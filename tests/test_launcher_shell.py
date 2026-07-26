from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
LAUNCHER = PROJECT_DIR / "start_local_atlas_luisa.sh"
LEGACY_LAUNCHER = PROJECT_DIR / "start_progress_viewer_luisa.sh"


class LocalAtlasLauncherContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = LAUNCHER.read_text(encoding="utf-8")

    def position(self, text: str) -> int:
        position = self.source.find(text)
        self.assertGreaterEqual(position, 0, f"no se encontró: {text}")
        return position

    def test_launcher_was_renamed_and_help_uses_canonical_name(self) -> None:
        self.assertTrue(LAUNCHER.is_file())
        self.assertFalse(LEGACY_LAUNCHER.exists())
        completed = subprocess.run(
            ["bash", str(LAUNCHER), "--help"],
            cwd=PROJECT_DIR,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("./start_local_atlas_luisa.sh", completed.stdout)
        self.assertNotIn("start_progress_viewer", completed.stdout)

    def test_local_storage_contract_is_explicit(self) -> None:
        self.assertIn(
            'external_tile_root="${external_volume}/2b2t_tiles"',
            self.source,
        )
        self.assertIn(
            'external_regional_tile_root="${external_volume}/'
            'ObsidianAtlasRegions/2b2t_tiles"',
            self.source,
        )
        self.assertIn('backing_root="/Volumes/LuisA"', self.source)
        self.assertIn(
            'export OBSIDIAN_ATLAS_TILE_ROOT="${tile_root}"',
            self.source,
        )
        self.assertIn(
            'export OBSIDIAN_ATLAS_REGIONAL_TILE_ROOT='
            '"${regional_tile_root}"',
            self.source,
        )
        self.assertIn(
            'export OBSIDIAN_ATLAS_BACKING_ROOT="${backing_root}"',
            self.source,
        )
        self.assertIn(
            'export OBSIDIAN_ATLAS_PYTHON="${python_bin}"',
            self.source,
        )

    def test_existing_sparsebundle_is_mounted_safely_for_startup(self) -> None:
        self.assertIn(
            'external_volume="/Volumes/2b2t Tiles"',
            self.source,
        )
        self.assertIn(
            'sparsebundle_path="/Volumes/LuisA/2b2t_map/'
            '2b2t_tiles.sparsebundle"',
            self.source,
        )
        ensure_start = self.position("ensure_external_tile_volume() {")
        ensure_end = self.source.index("\n}\n", ensure_start)
        ensure_body = self.source[ensure_start:ensure_end]
        override = ensure_body.index(
            'if [[ -n "${OBSIDIAN_ATLAS_TILE_ROOT:-}" ]]'
        )
        mounted = ensure_body.index("if ! external_volume_is_mounted; then")
        attach = ensure_body.index("/usr/bin/hdiutil attach")
        recheck = ensure_body.index(
            "if ! external_volume_is_mounted; then",
            attach,
        )
        verify_root = ensure_body.index(
            'if [[ ! -d "${external_tile_root}" ]]'
        )
        assign_root = ensure_body.index('tile_root="${external_tile_root}"')
        self.assertLess(override, mounted)
        self.assertLess(mounted, attach)
        self.assertLess(attach, recheck)
        self.assertLess(recheck, verify_root)
        self.assertLess(verify_root, assign_root)
        for option in (
            "-nobrowse",
            "-noautoopen",
            '-mountpoint "${external_volume}"',
            '"${sparsebundle_path}" </dev/null',
        ):
            with self.subTest(option=option):
                self.assertIn(option, ensure_body)

    def test_sparsebundle_mount_contract_is_non_destructive_and_scoped(
        self,
    ) -> None:
        lowered = self.source.lower()
        for destructive in (
            "hdiutil create",
            "hdiutil resize",
            "hdiutil convert",
            "hdiutil compact",
            "diskutil erasedisk",
            "diskutil partitiondisk",
            "diskutil apfs addvolume",
        ):
            with self.subTest(destructive=destructive):
                self.assertNotIn(destructive, lowered)

        validate_start = self.position("validate_environment() {")
        validate_end = self.source.index("\n}\n", validate_start)
        validate_body = self.source[validate_start:validate_end]
        self.assertEqual(
            self.source.count("\n  ensure_external_tile_volume\n"),
            1,
        )
        self.assertIn("\n  ensure_external_tile_volume\n", validate_body)

        for function_name in ("show_status", "stop_viewer"):
            function_start = self.position(f"{function_name}() {{")
            function_end = self.source.index("\n}\n", function_start)
            function_body = self.source[function_start:function_end]
            self.assertNotIn("hdiutil", function_body)
            self.assertNotIn("sparsebundle", function_body)
            self.assertNotIn("ensure_external_tile_volume", function_body)

    def test_readiness_requires_local_atlas_capacity_contract(self) -> None:
        endpoint = self.position(
            '"${viewer_url}/api/local-atlas/status"'
        )
        local_only = self.position(
            'payload.get("localOnly") is not True'
        )
        capacity = self.position('capacity = payload.get("capacity")')
        configured = self.position(
            'capacity.get("configured") is not True'
        )
        fields = self.position('numeric_fields = (')
        fits = self.position(
            'not isinstance(capacity.get("fits"), bool)'
        )
        self.assertLess(endpoint, local_only)
        self.assertLess(local_only, capacity)
        self.assertLess(capacity, configured)
        self.assertLess(configured, fields)
        self.assertLess(fields, fits)
        self.assertIn(
            'response.headers.get("Cache-Control") != "no-store"',
            self.source,
        )

    def test_legacy_full_download_progress_contract_is_absent(self) -> None:
        lowered = self.source.lower()
        for legacy_text in (
            "progress.json",
            "local-progress",
            "obsidian_atlas_progress_file",
            "run_full_download",
            "download_all_2b2t",
            "start_progress_viewer",
        ):
            with self.subTest(legacy_text=legacy_text):
                self.assertNotIn(legacy_text, lowered)

    def test_launcher_declares_on_demand_downloads_only(self) -> None:
        completed = subprocess.run(
            ["bash", str(LAUNCHER), "--help"],
            cwd=PROJECT_DIR,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn(
            "todo el presupuesto disponible de hasta 16 req/s",
            completed.stdout,
        )
        self.assertIn(
            "no\ninicia ni reanuda descargas globales",
            completed.stdout,
        )

    def test_mounts_and_viewer_are_validated_before_screen_launch(self) -> None:
        validate = self.position("\n  validate_environment\n")
        tile_probe = self.position('if [[ ! -d "${tile_root}"')
        backing_probe = self.position('if [[ ! -d "${backing_root}"')
        package_probe = self.position(
            'if [[ ! -f "${viewer_dir}/package.json"'
        )
        screen_launch = self.position(
            'screen \\\n'
            '      -dmS "${session_name}" \\\n'
            '      "${project_dir}/start_local_atlas_luisa.sh" --serve-loop'
        )
        self.assertLess(tile_probe, backing_probe)
        self.assertLess(backing_probe, package_probe)
        self.assertLess(validate, screen_launch)

    def test_server_is_supervised_on_localhost_with_status_and_stop(self) -> None:
        self.assertIn('viewer_url="http://localhost:${viewer_port}"', self.source)
        self.assertIn("--hostname localhost", self.source)
        self.assertNotIn("--hostname 0.0.0.0", self.source)
        self.assertIn('session_name="obsidian_atlas_local"', self.source)
        self.assertIn(
            '"${project_dir}/start_local_atlas_luisa.sh" --serve-loop',
            self.source,
        )
        self.assertIn("\n  --status)\n    show_status", self.source)
        self.assertIn("\n  --stop)\n    stop_viewer", self.source)
        self.assertIn("trap request_stop HUP INT TERM", self.source)
        self.assertIn("while (( stop_requested == 0 )); do", self.source)

    def test_singleton_lock_keeps_inode_and_validates_owner_identity(
        self,
    ) -> None:
        self.assertIn(
            'lock_file="${runtime_dir}/.local_atlas.lock"',
            self.source,
        )
        self.assertIn(
            '/usr/bin/lockf -k -t 10 "${lock_guard}"',
            self.source,
        )
        self.assertIn(
            '*start_local_atlas_luisa.sh*" --serve-loop"*)',
            self.source,
        )
        candidate = self.position(
            'printf \'%s\\n\' "${requested_pid}" >"${candidate_lock}"'
        )
        hard_link = self.position(
            'if ln "${candidate_lock}" "${lock_file}" 2>/dev/null; then'
        )
        stale_move = self.position(
            'if mv "${lock_file}" "${stale_lock}" 2>/dev/null; then'
        )
        self.assertLess(candidate, hard_link)
        self.assertLess(hard_link, stale_move)

    def test_shell_syntax_is_valid(self) -> None:
        completed = subprocess.run(
            ["bash", "-n", str(LAUNCHER)],
            cwd=PROJECT_DIR,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)


if __name__ == "__main__":
    unittest.main()
