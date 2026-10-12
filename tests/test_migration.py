import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app_paths import default_database_path, instance_file, marker_path
from desktop import LocalServer
from migration import MigrationError, migrate_legacy_database
from routes import create_app
from personal_note_cli import main
from services import NoteService


class MigrationTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {"PORT": "9", "HOST": "127.0.0.1"})  # a closed port, never the real 3137
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.legacy = root / "repo" / "data" / "personal-note.db"
        self.appdata = root / "xdg" / "personal-note" / "personal-note.db"
        self.env = {"XDG_DATA_HOME": str(root / "xdg")}
        self.home = root / "home"

    def root_db(self):
        return Path(self.tmp.name) / "served.db"

    def resolve(self):
        return default_database_path(platform="linux", env=self.env, home=self.home, legacy_path=self.legacy)

    def titles(self, path):
        return sorted(note["title"] for note in NoteService(path).list_notes())

    def make_legacy_note(self, title="From the checkout"):
        service = NoteService(self.legacy)
        service.create_note({"title": title, "noteType": "canvas"})

    def test_copies_to_a_missing_destination_and_keeps_the_legacy_file(self):
        self.make_legacy_note()
        before = self.legacy.read_bytes()
        result = migrate_legacy_database(self.legacy, self.appdata)
        self.assertEqual(result["mode"], "copied")
        self.assertEqual(self.titles(self.appdata), ["From the checkout"])
        self.assertTrue(self.legacy.exists())
        self.assertEqual(NoteService(self.legacy).list_notes()[0]["title"], "From the checkout")
        self.assertEqual(self.legacy.read_bytes()[:16], before[:16])
        self.assertTrue(marker_path(self.legacy).exists())
        self.assertFalse(self.appdata.with_name(self.appdata.name + ".partial").exists())

    def test_copy_brings_the_media_folder_and_never_overwrites_files_there(self):
        self.make_legacy_note()
        name = "a" * 64 + ".png"
        other = "b" * 64 + ".png"
        (self.legacy.parent / "media").mkdir()
        (self.legacy.parent / "media" / name).write_bytes(b"picture")
        (self.legacy.parent / "media" / other).write_bytes(b"legacy bytes")
        (self.appdata.parent / "media").mkdir(parents=True)
        (self.appdata.parent / "media" / other).write_bytes(b"already here")
        result = migrate_legacy_database(self.legacy, self.appdata)
        self.assertEqual(result["mode"], "copied")
        self.assertEqual((self.appdata.parent / "media" / name).read_bytes(), b"picture")
        self.assertEqual((self.appdata.parent / "media" / other).read_bytes(), b"already here")
        self.assertEqual((self.legacy.parent / "media" / name).read_bytes(), b"picture", "the original is kept")

    def test_merges_into_a_destination_another_install_already_created(self):
        self.make_legacy_note("Legacy note")
        NoteService(self.appdata).create_note({"title": "App note", "noteType": "canvas"})
        result = migrate_legacy_database(self.legacy, self.appdata)
        self.assertEqual(result["mode"], "merged")
        self.assertEqual(self.titles(self.appdata), ["App note", "Legacy note"])
        self.assertEqual(self.titles(self.legacy), ["Legacy note"])

    def test_full_sequence_from_another_install_creating_app_data_first(self):
        self.make_legacy_note()
        NoteService(self.appdata)  # the .app creates an empty app-data database first
        self.assertEqual(self.resolve(), self.legacy)  # the checkout keeps its notes
        migrate_legacy_database(self.legacy, self.appdata)
        self.assertEqual(self.resolve(), self.appdata)
        self.assertIn("From the checkout", self.titles(self.appdata))

    def test_refuses_while_the_desktop_app_answers(self):
        self.make_legacy_note()
        server = LocalServer(create_app(self.root_db()))
        url = server.start()
        self.addCleanup(server.stop)
        instance_file(self.appdata).parent.mkdir(parents=True)
        instance_file(self.appdata).write_text(json.dumps({"url": url, "pid": 1, "nonce": server.nonce}))
        with self.assertRaises(MigrationError):
            migrate_legacy_database(self.legacy, self.appdata)
        self.assertFalse(marker_path(self.legacy).exists())

    def test_a_stale_instance_record_does_not_block(self):
        self.make_legacy_note()
        instance_file(self.appdata).parent.mkdir(parents=True)
        # nothing listens on port 9, and the recorded pid is ours: liveness must not rely on the pid
        instance_file(self.appdata).write_text(json.dumps({"url": "http://127.0.0.1:9", "pid": os.getpid(), "nonce": "n"}))
        self.assertEqual(migrate_legacy_database(self.legacy, self.appdata)["mode"], "copied")

    def test_running_it_twice_does_not_duplicate_anything(self):
        self.make_legacy_note()
        migrate_legacy_database(self.legacy, self.appdata)
        second = migrate_legacy_database(self.legacy, self.appdata)
        self.assertEqual(second["mode"], "already-migrated")
        self.assertEqual(self.titles(self.appdata), ["From the checkout"])

    def test_force_merge_runs_again_when_asked(self):
        self.make_legacy_note()
        migrate_legacy_database(self.legacy, self.appdata)
        self.assertEqual(migrate_legacy_database(self.legacy, self.appdata, force_merge=True)["mode"], "merged")

    def test_relative_and_absolute_destination_count_as_the_same(self):
        self.make_legacy_note()
        migrate_legacy_database(self.legacy, self.appdata)
        relative = Path(os.path.relpath(self.appdata))
        self.assertEqual(migrate_legacy_database(self.legacy, relative)["mode"], "already-migrated")

    def test_a_marker_for_another_destination_does_not_block(self):
        self.make_legacy_note()
        migrate_legacy_database(self.legacy, self.appdata.with_name("other.db"))
        self.assertEqual(migrate_legacy_database(self.legacy, self.appdata)["mode"], "copied")

    def test_refuses_while_a_server_is_answering_on_the_port(self):
        self.make_legacy_note()
        server = LocalServer(create_app(self.root_db()))
        server.start()
        self.addCleanup(server.stop)
        port = int(server.base_url.rsplit(":", 1)[1])
        with self.assertRaises(MigrationError):
            migrate_legacy_database(self.legacy, self.appdata, server_port=port)
        self.assertFalse(self.appdata.exists())
        self.assertEqual(migrate_legacy_database(self.legacy, self.appdata, server_port=port, allow_running_server=True)["mode"], "copied")

    def test_nothing_to_migrate_is_an_error_that_creates_nothing(self):
        with self.assertRaises(MigrationError):
            migrate_legacy_database(self.legacy, self.appdata)
        self.assertFalse(self.appdata.exists())
        self.assertFalse(self.legacy.exists())

    def test_cli_command_reports_json(self):
        self.make_legacy_note()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["migrate-data", "--from", str(self.legacy), "--to", str(self.appdata)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["mode"], "copied")

    def test_cli_second_run_reports_already_migrated(self):
        self.make_legacy_note()
        for _ in range(2):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                main(["migrate-data", "--from", str(self.legacy), "--to", str(self.appdata)])
        self.assertEqual(json.loads(output.getvalue())["mode"], "already-migrated")

    def test_cli_reads_port_from_dot_env_when_the_environment_has_none(self):
        self.make_legacy_note()
        server = LocalServer(create_app(self.root_db()))
        server.start()
        self.addCleanup(server.stop)
        port = server.base_url.rsplit(":", 1)[1]
        env_file = Path(self.tmp.name) / ".env"
        env_file.write_text(f"# settings\nHOST=127.0.0.1\nPORT={port}\n")
        with mock.patch.dict(os.environ, {}, clear=False), mock.patch("personal_note_cli.ENV_FILE", env_file):
            os.environ.pop("PORT", None)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = main(["migrate-data", "--from", str(self.legacy), "--to", str(self.appdata)])
        self.assertEqual(code, 2)
        self.assertIn("answering", json.loads(output.getvalue())["error"])

    def test_cli_command_failure_is_json_and_exit_code_two(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["migrate-data", "--from", str(self.legacy), "--to", str(self.appdata)])
        self.assertEqual(code, 2)
        self.assertFalse(json.loads(output.getvalue())["ok"])


if __name__ == "__main__":
    unittest.main()
