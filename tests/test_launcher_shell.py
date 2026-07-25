from __future__ import annotations

import unittest
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
LAUNCHER = PROJECT_DIR / "run_full_download_luisa.sh"


class LauncherShellLockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = LAUNCHER.read_text(encoding="utf-8")

    def position(self, text: str) -> int:
        position = self.source.find(text)
        self.assertGreaterEqual(position, 0, f"no se encontró: {text}")
        return position

    def test_bootstrap_lock_precedes_every_volume_probe(self) -> None:
        app_support = self.position(
            'application_support="/Users/luisalvarado/Library/'
            'Application Support/ObsidianAtlas"'
        )
        mkdir = self.position(
            '/usr/bin/install -d -m 700 "${application_support}"'
        )
        bootstrap_exec = self.position(
            'exec /usr/bin/lockf -s -t 0 -k "${bootstrap_lock}"'
        )
        volume_probe = self.position(
            'if [[ ! -d "${backing_volume}" ]]; then'
        )
        self.assertLess(app_support, mkdir)
        self.assertLess(mkdir, bootstrap_exec)
        self.assertLess(bootstrap_exec, volume_probe)
        self.assertIn(
            'bootstrap_lock="${application_support}/'
            'download.bootstrap.lock"',
            self.source,
        )

    def test_lock_order_and_markers_keep_both_locks_for_lifetime(
        self,
    ) -> None:
        bootstrap_marker = self.position(
            "export OBSIDIAN_ATLAS_DOWNLOAD_BOOTSTRAP_LOCK_HELD=1"
        )
        bootstrap_exec = self.position(
            'exec /usr/bin/lockf -s -t 0 -k "${bootstrap_lock}"'
        )
        apfs_marker = self.position(
            "export OBSIDIAN_ATLAS_DOWNLOAD_EXEC_LOCK_HELD=1"
        )
        apfs_exec = self.position(
            'exec /usr/bin/lockf -s -t 0 -k "${execution_lock}"'
        )
        bootstrap_unset = self.position(
            "unset OBSIDIAN_ATLAS_DOWNLOAD_BOOTSTRAP_LOCK_HELD"
        )
        apfs_unset = self.position(
            "unset OBSIDIAN_ATLAS_DOWNLOAD_EXEC_LOCK_HELD"
        )
        downloader_lock = self.position("\nacquire_lock\n")

        self.assertLess(bootstrap_marker, bootstrap_exec)
        self.assertLess(bootstrap_exec, apfs_marker)
        self.assertLess(apfs_marker, apfs_exec)
        self.assertLess(apfs_exec, bootstrap_unset)
        self.assertLess(bootstrap_unset, apfs_unset)
        self.assertLess(apfs_unset, downloader_lock)

    def test_both_command_locks_use_kept_inode_and_zero_timeout(self) -> None:
        self.assertEqual(
            self.source.count("exec /usr/bin/lockf -s -t 0 -k"),
            2,
        )

    def test_temporary_headroom_requires_exactly_eighteen(self) -> None:
        self.assertIn(
            "float(sys.argv[1]) == 18.0",
            self.source,
        )
        self.assertNotIn("math.isclose", self.source)

    def test_terminal_safety_gate_surrounds_stale_lock_recovery(self) -> None:
        gate_definition = self.position("launcher_safety_gate() {")
        storage_latch = self.position(
            'storage_stop = output / "storage_stop.json"'
        )
        transition_latch = self.position(
            'transition = output / "margin_transition.json"'
        )
        transition_validation = self.position(
            "supervisor.read_transition_journal(transition)"
        )
        safety_signal = self.position(
            "safety = supervisor.safety_signal(progress)"
        )
        active_only = self.position(
            "progress.status not in supervisor.ACTIVE_STATUSES"
        )
        authorized_reboot = self.position(
            'os.environ.get("OBSIDIAN_ATLAS_RECOVERY_AUTHORIZED") == "1"'
        )
        first_gate = self.position("\nlauncher_safety_gate\nacquire_lock\n")
        stale_gate = self.position(
            "\n    if ! launcher_safety_gate; then\n"
            "      return 1\n"
            "    fi\n"
            '    stale_lock="${lock_dir}.stale.$$"'
        )
        stale_move = self.position(
            'if mv "${lock_dir}" "${stale_lock}" 2>/dev/null; then'
        )
        final_gate = self.position(
            "\nacquire_lock\n"
            "if ! launcher_safety_gate; then\n"
            "  release_own_lock"
        )
        unset_authorization = self.position(
            "unset OBSIDIAN_ATLAS_RECOVERY_AUTHORIZED"
        )

        self.assertLess(gate_definition, storage_latch)
        self.assertLess(storage_latch, transition_latch)
        self.assertLess(transition_latch, transition_validation)
        self.assertLess(transition_validation, safety_signal)
        self.assertLess(safety_signal, authorized_reboot)
        self.assertLess(authorized_reboot, active_only)
        self.assertLess(stale_gate, stale_move)
        self.assertLess(stale_move, first_gate)
        self.assertLess(first_gate, final_gate)
        self.assertLess(final_gate, unset_authorization)


if __name__ == "__main__":
    unittest.main()
