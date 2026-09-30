import tempfile
import unittest
from pathlib import Path

from app_paths import app_data_dir, default_database_path, marker_path, write_migration_marker


class AppDataDirTests(unittest.TestCase):
    home = Path("/home/ada")

    def test_macos_uses_application_support(self):
        self.assertEqual(
            app_data_dir(platform="darwin", env={}, home=self.home),
            Path("/home/ada/Library/Application Support/Personal Note"),
        )

    def test_windows_uses_appdata(self):
        self.assertEqual(
            app_data_dir(platform="win32", env={"APPDATA": "C:/Users/ada/AppData/Roaming"}, home=self.home),
            Path("C:/Users/ada/AppData/Roaming/Personal Note"),
        )

    def test_windows_without_appdata_falls_back_to_home(self):
        self.assertEqual(
            app_data_dir(platform="win32", env={}, home=self.home),
            Path("/home/ada/AppData/Roaming/Personal Note"),
        )

    def test_linux_honours_xdg_data_home(self):
        self.assertEqual(
            app_data_dir(platform="linux", env={"XDG_DATA_HOME": "/data/xdg"}, home=self.home),
            Path("/data/xdg/personal-note"),
        )

    def test_linux_defaults_to_local_share(self):
        self.assertEqual(
            app_data_dir(platform="linux", env={}, home=self.home),
            Path("/home/ada/.local/share/personal-note"),
        )

    def test_linux_ignores_relative_xdg_data_home(self):
        self.assertEqual(
            app_data_dir(platform="linux", env={"XDG_DATA_HOME": "relative"}, home=self.home),
            Path("/home/ada/.local/share/personal-note"),
        )


class DefaultDatabasePathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.home = root / "home"
        self.legacy = root / "repo" / "data" / "personal-note.db"
        self.env = {"XDG_DATA_HOME": str(root / "xdg")}
        self.appdata_db = root / "xdg" / "personal-note" / "personal-note.db"

    def resolve(self, env=None):
        return default_database_path(
            platform="linux", env=self.env if env is None else env, home=self.home, legacy_path=self.legacy
        )

    def test_fresh_install_uses_app_data_folder(self):
        self.assertEqual(self.resolve(), self.appdata_db)

    def test_env_override_wins_over_everything(self):
        self.legacy.parent.mkdir(parents=True)
        self.legacy.write_bytes(b"x")
        self.assertEqual(self.resolve({**self.env, "PERSONAL_NOTE_DB": "/tmp/x.db"}), Path("/tmp/x.db"))

    def test_empty_env_override_is_ignored(self):
        self.assertEqual(self.resolve({**self.env, "PERSONAL_NOTE_DB": ""}), self.appdata_db)

    def make_legacy(self):
        self.legacy.parent.mkdir(parents=True)
        self.legacy.write_bytes(b"x")

    def make_appdata(self):
        self.appdata_db.parent.mkdir(parents=True)
        self.appdata_db.write_bytes(b"y")

    def test_existing_legacy_database_is_kept(self):
        self.make_legacy()
        self.assertEqual(self.resolve(), self.legacy)

    def test_legacy_wins_even_when_another_install_created_an_app_data_database_first(self):
        # the .app, or a second checkout, starts first and creates an empty app-data database
        self.make_legacy()
        self.make_appdata()
        self.assertEqual(self.resolve(), self.legacy)

    def test_after_an_explicit_migration_the_app_data_database_wins(self):
        self.make_legacy()
        self.make_appdata()
        write_migration_marker(self.legacy, self.appdata_db)
        self.assertTrue(marker_path(self.legacy).exists())
        self.assertEqual(self.resolve(), self.appdata_db)

    def test_a_marker_without_the_app_data_database_never_hides_the_legacy_notes(self):
        self.make_legacy()
        write_migration_marker(self.legacy, self.appdata_db)
        self.assertEqual(self.resolve(), self.legacy)

    def test_resolution_never_touches_the_filesystem(self):
        self.resolve()
        self.assertFalse(self.appdata_db.parent.exists())


if __name__ == "__main__":
    unittest.main()
