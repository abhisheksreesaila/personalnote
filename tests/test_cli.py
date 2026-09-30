import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from personal_note_cli import main
from services import NoteService


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

    def test_cli_creates_a_notebook_in_a_para_category(self):
        code, notebook = self.run_cli("notebooks", "create", "--name", "Health", "--category", "areas")
        self.assertEqual(code, 0)
        self.assertEqual(notebook["category"], "areas")
        code, default = self.run_cli("notebooks", "create", "--name", "Plain")
        self.assertEqual(default["category"], "projects")
        code, listed = self.run_cli("notebooks", "list")
        self.assertEqual({item["name"]: item["category"] for item in listed}["Health"], "areas")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            main(["--database", str(self.database_path), "notebooks", "create", "--name", "X", "--category", "nonsense"])

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

    def run_cli_raw(self, *arguments, stdin=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), mock.patch("sys.stdin", io.StringIO(stdin or "")):
            code = main(["--database", str(self.database_path), *arguments])
        return code, output.getvalue()

    def create_note(self, title="Agent note", text="First thought"):
        code, note = self.run_cli("notes", "create", "--title", title, "--text", text)
        self.assertEqual(code, 0)
        return note

    def test_read_returns_plain_text_as_json_or_readable_text(self):
        note = self.create_note(text="Line one")
        self.run_cli("notes", "append", str(note["id"]), "--text", "Line two")
        code, result = self.run_cli("notes", "read", str(note["id"]))
        self.assertEqual(code, 0)
        self.assertEqual(result["text"], "Line one\n\nLine two")
        self.assertEqual(result["revision"], 3)
        self.assertEqual(result["title"], "Agent note")
        code, text = self.run_cli_raw("notes", "read", str(note["id"]), "--text")
        self.assertEqual(code, 0)
        self.assertEqual(text, "Line one\n\nLine two\n")

    def test_read_of_a_mind_map_is_an_outline(self):
        code, note = self.run_cli("notes", "create", "--title", "Map", "--type", "mindmap")
        self.assertEqual(code, 0)
        code, result = self.run_cli("notes", "read", str(note["id"]))
        self.assertEqual(result["text"], "- Central idea")

    def test_append_adds_text_below_and_reports_the_new_revision(self):
        note = self.create_note()
        code, result = self.run_cli("notes", "append", str(note["id"]), "--text", "Second thought")
        self.assertEqual(code, 0)
        self.assertEqual(result["revision"], note["revision"] + 1)
        code, loaded = self.run_cli("notes", "get", str(note["id"]))
        first, second = loaded["content"]["objects"]
        self.assertEqual(first["text"], "First thought")
        self.assertGreater(second["top"], first["top"])

    def test_append_reads_stdin_and_honours_expected_revision(self):
        note = self.create_note()
        code, output = self.run_cli_raw("notes", "append", str(note["id"]), stdin="From a pipe\n")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)["ok"], True)
        code, output = self.run_cli_raw(
            "notes", "append", str(note["id"]), "--text", "stale", "--revision", str(note["revision"])
        )
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output), {"ok": False, "error": "Resource revision does not match"})
        _, text = self.run_cli_raw("notes", "read", str(note["id"]), "--text")
        self.assertNotIn("stale", text)
        self.assertIn("From a pipe", text)

    def test_append_of_blank_text_is_a_clear_error(self):
        note = self.create_note()
        code, result = self.run_cli("notes", "append", str(note["id"]), "--text", "  ")
        self.assertEqual((code, result["ok"]), (2, False))

    def test_append_to_a_mind_map_is_a_clear_error(self):
        _, note = self.run_cli("notes", "create", "--title", "Map", "--type", "mindmap")
        code, result = self.run_cli("notes", "append", str(note["id"]), "--text", "x")
        self.assertEqual(code, 2)
        self.assertFalse(result["ok"])

    def test_search_can_print_readable_lines(self):
        note = self.create_note(title="Kayak trip", text="pack the dry bag")
        code, text = self.run_cli_raw("search", "dry bag", "--text")
        self.assertEqual(code, 0)
        self.assertIn(f"#{note['id']}", text)
        self.assertIn("Kayak trip", text)

    def test_agent_activity_is_recorded_with_the_agent_name(self):
        note = self.create_note()
        service = NoteService(self.database_path)
        self.assertEqual(service.active_agents()[0]["action"], "writing")
        self.run_cli("notes", "read", str(note["id"]))
        active = service.active_agents()
        self.assertEqual((active[0]["agent"], active[0]["action"], active[0]["noteId"]), ("Claude Code", "reading", note["id"]))
        self.run_cli("--agent", "Helper", "notes", "append", str(note["id"]), "--text", "hi")
        self.run_cli("notes", "read", str(note["id"]), "--agent", "Reader")
        names = {a["agent"]: a["action"] for a in service.active_agents()}
        self.assertEqual(names, {"Claude Code": "reading", "Helper": "writing", "Reader": "reading"})

    def test_bin_wrapper_runs_from_any_directory_without_the_virtualenv(self):
        wrapper = Path(__file__).resolve().parent.parent / "bin" / "personal-note"
        completed = subprocess.run(
            [sys.executable, str(wrapper), "--database", str(self.database_path), "notes", "list"],
            capture_output=True, text=True, cwd=self.temporary_directory.name, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout), [])

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
