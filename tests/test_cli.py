import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from personal_note_cli import main


class CliContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "personal-note.db"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def run_cli(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["--database", str(self.database_path), *arguments])
        return code, json.loads(output.getvalue())

    def test_cli_creates_searches_and_reads_a_canvas_note(self):
        code, notebooks = self.run_cli("notebooks", "list")
        self.assertEqual(code, 0)
        notebook_id = notebooks[0]["id"]

        code, note = self.run_cli(
            "notes", "create", "--title", "CLI capture", "--notebook-id", str(notebook_id),
            "--text", "Keep a searchable local idea",
        )
        self.assertEqual(code, 0)
        self.assertEqual(note["revision"], 2)
        self.assertEqual(note["content"]["objects"][0]["text"], "Keep a searchable local idea")

        code, matches = self.run_cli("search", "searchable local")
        self.assertEqual(code, 0)
        self.assertEqual(matches[0]["id"], note["id"])

        code, loaded = self.run_cli("notes", "get", str(note["id"]))
        self.assertEqual(code, 0)
        self.assertEqual(loaded["resourceId"], note["resourceId"])

    def test_cli_exports_and_merges_lossless_workspace_backups(self):
        code, _ = self.run_cli("notes", "create", "--title", "Backup source", "--text", "Portable data")
        self.assertEqual(code, 0)
        backup_path = Path(self.temporary_directory.name) / "backup.json"

        code, exported = self.run_cli("export", "workspace", "--output", str(backup_path))
        self.assertEqual(code, 0)
        self.assertTrue(exported["ok"])
        self.assertEqual(json.loads(backup_path.read_text(encoding="utf-8"))["format"], "personal-note-workspace")

        code, imported = self.run_cli("import", str(backup_path))
        self.assertEqual(code, 0)
        self.assertEqual(imported["mode"], "merge")

    def test_cli_returns_machine_readable_error_for_missing_note(self):
        code, result = self.run_cli("notes", "get", "404")
        self.assertEqual(code, 2)
        self.assertEqual(result, {"ok": False, "error": "Note not found"})


if __name__ == "__main__":
    unittest.main()
