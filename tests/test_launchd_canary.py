from __future__ import annotations

import datetime as dt
import json
import os
import plistlib
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, Mapping

import launchd_canary_luisa as canary


FIXED_NOW = dt.datetime(2026, 7, 25, 4, 0, tzinfo=dt.timezone.utc)
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


class CanaryFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.repository = root / "repo"
        self.output = root / "output"
        self.luisa = root / "LuisA"
        self.apfs = root / "2b2t Tiles"
        self.app_support = root / "Library/Application Support/ObsidianAtlas"
        self.repository.mkdir(parents=True)
        (self.repository / ".git").mkdir()
        (self.repository / "download_all_2b2t.py").write_text(
            "print('download')\n", encoding="utf-8"
        )
        (self.repository / "supervise_full_download_luisa.py").write_text(
            "print('supervise')\n", encoding="utf-8"
        )
        self.output.mkdir()
        self.luisa.mkdir()
        self.apfs.mkdir()
        (self.output / "progress.json").write_text(
            json.dumps(
                {
                    "status": "running",
                    "processed_requests": 125,
                    "planned_requests": 1_000,
                    "remaining_requests": 875,
                    "progress_percent": 12.5,
                    "updated_at": "2026-07-25T03:59:30+00:00",
                }
            ),
            encoding="utf-8",
        )
        connection = sqlite3.connect(self.output / "tiles.sqlite3")
        connection.execute(
            "CREATE TABLE tiles (id INTEGER PRIMARY KEY, status TEXT)"
        )
        connection.execute("INSERT INTO tiles(status) VALUES ('complete')")
        connection.commit()
        connection.close()
        self.config = canary.CanaryConfig(
            repository=self.repository,
            output=self.output,
            luisa_mount=self.luisa,
            apfs_mount=self.apfs,
            expected_luisa_uuid=canary.EXPECTED_LUISA_UUID,
            expected_apfs_uuid=canary.EXPECTED_APFS_UUID,
            app_support=self.app_support,
            sentinel_directory=self.app_support / "canary",
            result_path=self.app_support / "canary-result.json",
        )

    def disk_info(self, mount: Path) -> Mapping[str, Any]:
        if mount == self.luisa:
            return {
                "MountPoint": str(mount),
                "VolumeUUID": canary.EXPECTED_LUISA_UUID.lower(),
                "FilesystemType": "exfat",
                "WritableVolume": True,
            }
        if mount == self.apfs:
            return {
                "MountPoint": str(mount),
                "VolumeUUID": canary.EXPECTED_APFS_UUID,
                "FilesystemType": "apfs",
                "WritableVolume": True,
            }
        raise AssertionError("unexpected mount")

    def image_info_runner(
        self,
        arguments: Any,
        **kwargs: Any,
    ) -> subprocess.CompletedProcess:
        return subprocess.CompletedProcess(
            arguments,
            0,
            plistlib.dumps(
                {
                    "images": [
                        {
                            "image-path": (
                                "/Volumes/LuisA/2b2t_map/./"
                                "2b2t_tiles.sparsebundle/"
                            ),
                            "image-type": "sparse bundle disk image",
                            "system-entities": [
                                {
                                    "dev-entry": "/dev/disk6",
                                    "content-hint": (
                                        "GUID_partition_scheme"
                                    ),
                                },
                                {
                                    "dev-entry": "/dev/disk7s1",
                                    "mount-point": (
                                        "/Volumes/2b2t Tiles/."
                                    ),
                                },
                            ],
                        }
                    ],
                }
            ),
            b"",
        )


class LaunchdCanaryTests(unittest.TestCase):
    def test_healthy_run_is_read_only_on_output_and_publishes_result(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = CanaryFixture(Path(directory))
            before = {
                path.relative_to(fixture.output): (
                    path.stat().st_size,
                    path.stat().st_mtime_ns,
                )
                for path in fixture.output.rglob("*")
                if path.is_file()
            }

            exit_code, result = canary.run_once(
                fixture.config,
                now=FIXED_NOW,
                disk_info_reader=fixture.disk_info,
                image_info_runner=fixture.image_info_runner,
            )

            after = {
                path.relative_to(fixture.output): (
                    path.stat().st_size,
                    path.stat().st_mtime_ns,
                )
                for path in fixture.output.rglob("*")
                if path.is_file()
            }
            self.assertEqual(exit_code, 0)
            self.assertTrue(result["healthy"])
            self.assertEqual(before, after)
            self.assertEqual(
                list((fixture.app_support / "canary").iterdir()), []
            )
            persisted = json.loads(
                (fixture.app_support / "canary-result.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertTrue(persisted["healthy"])
            self.assertEqual(
                persisted["checks"]["sqlite"]["quick_check"], "ok"
            )
            self.assertEqual(
                persisted["checks"]["luisa_volume"]["uuid"],
                canary.EXPECTED_LUISA_UUID,
            )
            self.assertEqual(
                persisted["checks"]["apfs_volume"]["uuid"],
                canary.EXPECTED_APFS_UUID,
            )
            self.assertEqual(
                persisted["checks"]["sparsebundle"],
                {
                    "device": "/dev/disk7s1",
                    "image_path": (
                        "/Volumes/LuisA/2b2t_map/"
                        "2b2t_tiles.sparsebundle"
                    ),
                    "image_type": "sparse bundle disk image",
                    "matching_images": 1,
                    "matching_mounted_entities": 1,
                    "mount_point": "/Volumes/2b2t Tiles",
                    "ok": True,
                    "operation": "info",
                    "plist": True,
                    "tool": "/usr/bin/hdiutil",
                },
            )
            result_mode = (
                fixture.app_support / "canary-result.json"
            ).stat().st_mode
            self.assertEqual(result_mode & 0o777, 0o600)

    def test_uuid_mismatch_is_unhealthy_but_all_checks_are_recorded(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = CanaryFixture(Path(directory))

            def wrong_luisa_uuid(mount: Path) -> Mapping[str, Any]:
                result = dict(fixture.disk_info(mount))
                if mount == fixture.luisa:
                    result["VolumeUUID"] = (
                        "00000000-0000-0000-0000-000000000000"
                    )
                return result

            exit_code, result = canary.run_once(
                fixture.config,
                now=FIXED_NOW,
                disk_info_reader=wrong_luisa_uuid,
                image_info_runner=fixture.image_info_runner,
            )

            self.assertEqual(exit_code, 1)
            self.assertFalse(result["healthy"])
            self.assertFalse(result["checks"]["luisa_volume"]["ok"])
            self.assertTrue(result["checks"]["apfs_volume"]["ok"])
            self.assertTrue(result["checks"]["progress"]["ok"])
            self.assertTrue(result["checks"]["sqlite"]["ok"])
            self.assertTrue(result["checks"]["sparsebundle"]["ok"])
            self.assertTrue(result["checks"]["sentinel"]["ok"])
            persisted = json.loads(
                fixture.config.result_path.read_text(encoding="utf-8")
            )
            self.assertFalse(persisted["healthy"])

    def test_stale_progress_and_corrupt_sqlite_are_reported_without_writes(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = CanaryFixture(Path(directory))
            progress = json.loads(
                fixture.config.progress_path.read_text(encoding="utf-8")
            )
            progress["updated_at"] = "2026-07-25T03:00:00+00:00"
            fixture.config.progress_path.write_text(
                json.dumps(progress), encoding="utf-8"
            )
            fixture.config.database_path.write_bytes(b"not a sqlite database")
            progress_before = fixture.config.progress_path.read_bytes()
            database_before = fixture.config.database_path.read_bytes()

            exit_code, result = canary.run_once(
                fixture.config,
                now=FIXED_NOW,
                disk_info_reader=fixture.disk_info,
                image_info_runner=fixture.image_info_runner,
            )

            self.assertEqual(exit_code, 1)
            self.assertFalse(result["checks"]["progress"]["ok"])
            self.assertFalse(result["checks"]["sqlite"]["ok"])
            self.assertEqual(
                fixture.config.progress_path.read_bytes(), progress_before
            )
            self.assertEqual(
                fixture.config.database_path.read_bytes(), database_before
            )

    def test_write_paths_cannot_escape_app_support_or_enter_output(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = CanaryFixture(Path(directory))
            escaped = fixture.output / "canary"
            unsafe = canary.dataclasses.replace(
                fixture.config,
                sentinel_directory=escaped,
            )

            exit_code, result = canary.run_once(
                unsafe,
                now=FIXED_NOW,
                disk_info_reader=fixture.disk_info,
                image_info_runner=fixture.image_info_runner,
            )

            self.assertEqual(exit_code, 2)
            self.assertFalse(result["healthy"])
            self.assertFalse(result["checks"]["sentinel"]["ok"])
            self.assertFalse(escaped.exists())
            self.assertIn("result_write_error", result)

    def test_complete_progress_does_not_expire(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = CanaryFixture(Path(directory))
            progress = json.loads(
                fixture.config.progress_path.read_text(encoding="utf-8")
            )
            progress.update(
                {
                    "status": "complete",
                    "processed_requests": 1_000,
                    "remaining_requests": 0,
                    "progress_percent": 100.0,
                    "updated_at": "2026-01-01T00:00:00+00:00",
                }
            )
            fixture.config.progress_path.write_text(
                json.dumps(progress), encoding="utf-8"
            )

            result = canary.build_result(
                fixture.config,
                now=FIXED_NOW,
                disk_info_reader=fixture.disk_info,
                image_info_runner=fixture.image_info_runner,
            )

            self.assertTrue(result["checks"]["progress"]["ok"])

    def test_sparsebundle_uses_only_fixed_read_only_hdiutil_command(
        self,
    ) -> None:
        calls = []

        def recording_runner(
            arguments: Any,
            **kwargs: Any,
        ) -> subprocess.CompletedProcess:
            calls.append((arguments, kwargs))
            return subprocess.CompletedProcess(
                arguments,
                0,
                plistlib.dumps(
                    {
                        "images": [
                            {
                                "image-path": (
                                    "/Volumes/LuisA/2b2t_map/"
                                    "2b2t_tiles.sparsebundle"
                                ),
                                "system-entities": [
                                    {
                                        "mount-point": (
                                            "/Volumes/2b2t Tiles"
                                        )
                                    }
                                ],
                            }
                        ]
                    }
                ),
                b"",
            )

        result = canary.check_sparsebundle(recording_runner)

        self.assertEqual(
            calls,
            [
                (
                    [
                        "/usr/bin/hdiutil",
                        "info",
                        "-plist",
                    ],
                    {
                        "check": False,
                        "stdout": subprocess.PIPE,
                        "stderr": subprocess.PIPE,
                        "timeout": 30.0,
                    },
                )
            ],
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["operation"], "info")
        self.assertNotIn("attach", calls[0][0])
        self.assertNotIn("mount", calls[0][0])
        self.assertNotIn("imageinfo", calls[0][0])

    def test_sparsebundle_requires_one_image_and_one_mounted_entity(
        self,
    ) -> None:
        image = {
            "image-path": (
                "/Volumes/LuisA/2b2t_map/2b2t_tiles.sparsebundle"
            ),
            "system-entities": [
                {"mount-point": "/Volumes/2b2t Tiles"},
            ],
        }
        cases = {
            "missing image": {"images": []},
            "duplicate image": {"images": [image, image]},
            "wrong mount": {
                "images": [
                    {
                        **image,
                        "system-entities": [
                            {"mount-point": "/Volumes/Other"}
                        ],
                    }
                ]
            },
            "duplicate entity": {
                "images": [
                    {
                        **image,
                        "system-entities": [
                            {"mount-point": "/Volumes/2b2t Tiles"},
                            {"mount-point": "/Volumes/2b2t Tiles/."},
                        ],
                    }
                ]
            },
        }
        for name, plist in cases.items():
            with self.subTest(name=name):
                def runner(
                    arguments: Any,
                    **kwargs: Any,
                ) -> subprocess.CompletedProcess:
                    return subprocess.CompletedProcess(
                        arguments,
                        0,
                        plistlib.dumps(plist),
                        b"",
                    )

                with self.assertRaises(canary.CanaryError):
                    canary.check_sparsebundle(runner)

    def test_sparsebundle_runner_failure_is_recorded_independently(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = CanaryFixture(Path(directory))

            def failed_runner(
                arguments: Any,
                **kwargs: Any,
            ) -> subprocess.CompletedProcess:
                return subprocess.CompletedProcess(
                    arguments,
                    1,
                    b"",
                    b"image not recognized",
                )

            exit_code, result = canary.run_once(
                fixture.config,
                now=FIXED_NOW,
                disk_info_reader=fixture.disk_info,
                image_info_runner=failed_runner,
            )

            self.assertEqual(exit_code, 1)
            self.assertFalse(result["healthy"])
            self.assertFalse(result["checks"]["sparsebundle"]["ok"])
            self.assertTrue(result["checks"]["repository"]["ok"])
            self.assertTrue(result["checks"]["luisa_volume"]["ok"])
            self.assertTrue(result["checks"]["apfs_volume"]["ok"])
            self.assertTrue(result["checks"]["progress"]["ok"])
            self.assertTrue(result["checks"]["sqlite"]["ok"])
            self.assertTrue(result["checks"]["sentinel"]["ok"])
            persisted = json.loads(
                fixture.config.result_path.read_text(encoding="utf-8")
            )
            self.assertFalse(
                persisted["checks"]["sparsebundle"]["ok"]
            )

    def test_script_constants_match_the_verified_volume_uuids(self) -> None:
        self.assertEqual(
            canary.EXPECTED_LUISA_UUID,
            "D1445254-D3DC-3AE9-9BE7-E55D401ACE68",
        )
        self.assertEqual(
            canary.EXPECTED_APFS_UUID,
            "CBBDD2B8-D219-446C-AFDA-088E2E68C409",
        )


class LaunchdPlistTests(unittest.TestCase):
    @staticmethod
    def load(name: str) -> Dict[str, Any]:
        path = REPOSITORY_ROOT / "launchd" / name
        with path.open("rb") as stream:
            return plistlib.load(stream)

    def assert_locked_python_job(
        self,
        plist: Mapping[str, Any],
        expected_script: str,
        expected_lock: str,
    ) -> None:
        arguments = plist["ProgramArguments"]
        self.assertEqual(
            arguments[:5],
            ["/usr/bin/lockf", "-s", "-t", "0", "-k"],
        )
        self.assertEqual(arguments[5], expected_lock)
        self.assertEqual(
            arguments[6],
            (
                "/Users/luisalvarado/.local/share/uv/python/"
                "cpython-3.11.15-macos-aarch64-none/bin/python3.11"
            ),
        )
        self.assertEqual(arguments[7], expected_script)
        for argument in (arguments[0], arguments[5], arguments[6], arguments[7]):
            self.assertTrue(Path(argument).is_absolute())
            self.assertNotIn("~", argument)

    def test_canary_is_an_unscheduled_one_shot_installed_copy(self) -> None:
        value = self.load(
            "com.luisalvarado.obsidian-atlas.canary.plist"
        )
        self.assertEqual(
            value["Label"],
            "com.luisalvarado.obsidian-atlas.canary",
        )
        self.assert_locked_python_job(
            value,
            (
                "/Users/luisalvarado/Library/Application Support/"
                "ObsidianAtlas/bin/launchd_canary_luisa.py"
            ),
            (
                "/Users/luisalvarado/Library/Application Support/"
                "ObsidianAtlas/canary.lock"
            ),
        )
        for forbidden in (
            "RunAtLoad",
            "StartInterval",
            "KeepAlive",
            "AssociatedBundleIdentifiers",
        ):
            self.assertNotIn(forbidden, value)

    def test_assurer_is_disabled_periodic_future_copy(self) -> None:
        value = self.load(
            "com.luisalvarado.obsidian-atlas.assurer.plist"
        )
        self.assertEqual(
            value["Label"],
            "com.luisalvarado.obsidian-atlas.assurer",
        )
        self.assertTrue(value["Disabled"])
        self.assertTrue(value["RunAtLoad"])
        self.assertTrue(value["StartOnMount"])
        self.assertEqual(value["StartInterval"], 300)
        self.assertEqual(value["LimitLoadToSessionType"], "Aqua")
        self.assert_locked_python_job(
            value,
            (
                "/Users/luisalvarado/Library/Application Support/"
                "ObsidianAtlas/bin/resume_after_login_luisa.py"
            ),
            (
                "/Users/luisalvarado/Library/Application Support/"
                "ObsidianAtlas/assurer.lock"
            ),
        )
        self.assertEqual(
            value["ProgramArguments"][8:],
            [
                "--execute",
                (
                    "--project-dir=/Users/luisalvarado/Documents/"
                    "GitHub/2b2t_map"
                ),
            ],
        )
        self.assertEqual(
            value["StandardOutPath"],
            (
                "/Users/luisalvarado/Library/Logs/"
                "ObsidianAtlas/assurer.out.log"
            ),
        )
        self.assertEqual(
            value["StandardErrorPath"],
            (
                "/Users/luisalvarado/Library/Logs/"
                "ObsidianAtlas/assurer.err.log"
            ),
        )
        for forbidden in ("KeepAlive", "AssociatedBundleIdentifiers"):
            self.assertNotIn(forbidden, value)


if __name__ == "__main__":
    unittest.main()
