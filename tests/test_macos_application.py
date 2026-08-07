from __future__ import annotations

import os
import platform
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
INSTALLER = PROJECT_DIR / "install_macos_app.sh"
HELPER = PROJECT_DIR / "macos" / "start-and-open.sh"
APPLESCRIPT = PROJECT_DIR / "macos" / "ObsidianAtlas.applescript"


class MacOSApplicationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.installer_source = INSTALLER.read_text(encoding="utf-8")
        cls.helper_source = HELPER.read_text(encoding="utf-8")
        cls.applescript_source = APPLESCRIPT.read_text(encoding="utf-8")

    def test_installation_help_describes_click_to_start_contract(self) -> None:
        completed = subprocess.run(
            ["bash", str(INSTALLER), "--help"],
            cwd=PROJECT_DIR,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn('"Obsidian Atlas.app"', completed.stdout)
        self.assertIn("inicia\nel servidor local", completed.stdout)
        self.assertIn("abre Atlas en Chrome", completed.stdout)

    def test_shell_sources_have_valid_syntax(self) -> None:
        for source in (INSTALLER, HELPER):
            with self.subTest(source=source.name):
                completed = subprocess.run(
                    ["bash", "-n", str(source)],
                    cwd=PROJECT_DIR,
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_native_applet_waits_for_health_before_opening(self) -> None:
        self.assertIn('path to resource "start-and-open"', self.applescript_source)
        self.assertIn("with timeout of 180 seconds", self.applescript_source)
        self.assertIn("display dialog", self.applescript_source)
        launch = self.helper_source.index('launch_output=$("${canonical_launcher}"')
        browser = self.helper_source.index(
            '/usr/bin/open -b "${browser_bundle_id}" "${viewer_url}"'
        )
        self.assertLess(launch, browser)
        self.assertIn('viewer_url="http://localhost:${viewer_port}"', self.helper_source)
        self.assertNotIn("0.0.0.0", self.helper_source)

    def test_finder_environment_and_singleton_are_explicit(self) -> None:
        self.assertIn(
            'export PATH="${executable_path}"',
            self.helper_source,
        )
        self.assertIn('export PYTHON_BIN="${python_bin}"', self.helper_source)
        self.assertIn("/usr/bin/lockf -k -t 150", self.helper_source)
        self.assertIn(
            'canonical_launcher="${project_dir}/start_local_atlas_luisa.sh"',
            self.helper_source,
        )
        self.assertNotIn("screen -dm", self.helper_source)
        self.assertNotIn("LaunchAgent", self.installer_source)
        self.assertNotIn("com.apple.Terminal", self.helper_source)

    def test_installer_uses_staging_icon_signature_and_owned_replacement(self) -> None:
        for expected in (
            'bundle_identifier="com.luisalvarado.obsidian-atlas"',
            'staging_dir=$(mktemp -d',
            "/usr/bin/osacompile",
            "/usr/bin/iconutil -c icns",
            "/usr/bin/codesign --force --deep --sign -",
            'existing_identifier}',
            "No se reemplazó una aplicación ajena",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, self.installer_source)
        for forbidden in ("killall", "launchctl", "0.0.0.0"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, self.installer_source)
        self.assertIn('if [[ ! -d "${install_dir}" ]]', self.installer_source)
        self.assertIn('if [[ ! -w "${install_dir}" ]]', self.installer_source)
        self.assertIn("NSDocumentsFolderUsageDescription", self.installer_source)
        self.assertIn("NSRemovableVolumesUsageDescription", self.installer_source)

    @unittest.skipUnless(platform.system() == "Darwin", "requiere macOS")
    def test_installer_builds_a_valid_signed_bundle(self) -> None:
        required = (
            "/usr/bin/codesign",
            "/usr/bin/iconutil",
            "/usr/bin/osacompile",
            "/usr/bin/sips",
        )
        if any(not Path(tool).is_file() for tool in required):
            self.skipTest("faltan herramientas nativas de macOS")
        if not (PROJECT_DIR / "viewer" / "node_modules").is_dir():
            self.skipTest("faltan las dependencias del visor")
        if shutil.which("node") is None or shutil.which("npm") is None:
            self.skipTest("faltan Node.js o npm")
        if subprocess.run(
            ["/usr/bin/open", "-Ra", "Safari"],
            check=False,
            capture_output=True,
        ).returncode != 0:
            self.skipTest("Safari no está disponible para la prueba aislada")

        with tempfile.TemporaryDirectory() as temporary_directory:
            applications_directory = Path(temporary_directory) / "applications"
            environment = os.environ.copy()
            environment["OBSIDIAN_ATLAS_BROWSER_BUNDLE_ID"] = "com.apple.Safari"
            environment["OBSIDIAN_ATLAS_BROWSER_NAME"] = "Safari"
            completed = subprocess.run(
                [
                    "bash",
                    str(INSTALLER),
                    "--install-dir",
                    str(applications_directory),
                ],
                cwd=PROJECT_DIR,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
                timeout=90,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)

            bundle = applications_directory / "Obsidian Atlas.app"
            plist = bundle / "Contents" / "Info.plist"
            self.assertTrue((bundle / "Contents" / "MacOS" / "applet").is_file())
            self.assertTrue((bundle / "Contents" / "Resources" / "AppIcon.icns").is_file())
            self.assertTrue((bundle / "Contents" / "Resources" / "start-and-open").is_file())
            identifier = subprocess.run(
                [
                    "/usr/bin/plutil",
                    "-extract",
                    "CFBundleIdentifier",
                    "raw",
                    "-o",
                    "-",
                    str(plist),
                ],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            self.assertEqual(identifier, "com.luisalvarado.obsidian-atlas")
            project_from_plist = subprocess.run(
                [
                    "/usr/bin/plutil",
                    "-extract",
                    "ObsidianAtlasProjectDirectory",
                    "raw",
                    "-o",
                    "-",
                    str(plist),
                ],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            self.assertEqual(project_from_plist, str(PROJECT_DIR))
            signature = subprocess.run(
                [
                    "/usr/bin/codesign",
                    "--verify",
                    "--deep",
                    "--strict",
                    str(bundle),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(signature.returncode, 0, signature.stderr)


if __name__ == "__main__":
    unittest.main()
