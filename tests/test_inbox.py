"""F-064: a real Inbox. An unfiled note has no notebook (notebook_id NULL); nothing else is special about it."""

import contextlib
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from personal_note_cli import main as cli_main
from portability import markdown_archive, workspace_backup
from routes import create_app
from services import NoteService, WorkspaceImportError


class InboxServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "personal-note.db"
        self.service = NoteService(self.path)
        self.notebook = self.service.create_notebook({"name": "Plans"})

    def tearDown(self):
        self.directory.cleanup()

    def test_a_new_note_without_a_notebook_lands_in_the_inbox(self):
        note = self.service.create_note({"title": "Quick thought"})
        self.assertIsNone(note["notebookId"])
        self.assertIsNone(self.service.list_notes()[0]["notebookId"])

    def test_a_note_made_in_a_notebook_goes_there_and_an_unknown_notebook_means_inbox(self):
        filed = self.service.create_note({"title": "Filed", "notebookId": self.notebook["id"]})
        self.assertEqual(filed["notebookId"], self.notebook["id"])
        stray = self.service.create_note({"title": "Stray", "notebookId": 99999})
        self.assertIsNone(stray["notebookId"])

    def test_filing_and_unfiling_a_note(self):
        note = self.service.create_note({"title": "Sort me"})
        moved = self.service.move_note(note["id"], {"notebookId": self.notebook["id"]})
        self.assertEqual(self.service.get_note(note["id"])["notebookId"], self.notebook["id"])
        self.assertEqual({item["name"]: item["noteCount"] for item in self.service.list_notebooks()}["Plans"], 1)
        self.service.move_note(note["id"], {"notebookId": None, "revision": moved["revision"]})
        self.assertIsNone(self.service.get_note(note["id"])["notebookId"])

    def test_moving_to_a_notebook_that_does_not_exist_still_fails(self):
        note = self.service.create_note({"title": "Stay"})
        with self.assertRaises(Exception):
            self.service.move_note(note["id"], {"notebookId": 99999})
        with self.assertRaises(Exception):
            self.service.move_note(note["id"], {})  # no notebook named at all is not "Inbox"

    def test_inbox_notes_survive_a_restart(self):
        note = self.service.create_note({"title": "Still unfiled"})
        reopened = NoteService(self.path)
        self.assertIsNone(reopened.get_note(note["id"])["notebookId"])

    def test_autosave_with_no_notebook_keeps_the_note_where_it_is(self):
        note = self.service.create_note({"title": "Typing"})
        self.service.update_note(note["id"], {"title": "Typing", "revision": note["revision"], "notebookId": None, "content": self.service.get_note(note["id"])["content"]})
        self.assertIsNone(self.service.get_note(note["id"])["notebookId"])

    def test_deleting_a_notebook_moves_its_notes_to_the_inbox(self):
        note = self.service.create_note({"title": "Orphan", "notebookId": self.notebook["id"]})
        result = self.service.delete_notebook(self.notebook["id"])
        self.assertIsNone(result["destinationNotebookId"])
        self.assertEqual([item["id"] for item in result["movedNotes"]], [note["id"]])
        self.assertIsNone(self.service.get_note(note["id"])["notebookId"])
        self.assertEqual(len(self.service.list_notebooks()), 1)  # no "My Notes" is invented

    def test_deleting_the_only_notebook_does_not_invent_another(self):
        for item in self.service.list_notebooks():
            self.service.delete_notebook(item["id"])
        self.assertEqual(self.service.list_notebooks(), [])
        self.assertIsNone(self.service.create_note({"title": "Alone"})["notebookId"])

    def test_search_finds_an_inbox_note(self):
        self.service.create_note({"title": "Pomegranate recipe"})
        results = self.service.search("pomegranate")
        self.assertEqual([item["title"] for item in results], ["Pomegranate recipe"])
        self.assertIsNone(results[0]["notebookId"])
        self.assertEqual(results[0]["notebookName"], "Inbox")

    def test_backup_carries_inbox_notes_and_import_keeps_them_unfiled(self):
        self.service.create_note({"title": "Unfiled one"})
        self.service.create_note({"title": "Filed one", "notebookId": self.notebook["id"]})
        backup = workspace_backup(self.service)
        by_title = {note["title"]: note for note in backup["notes"]}
        self.assertIsNone(by_title["Unfiled one"]["notebookResourceId"])
        self.assertIsNotNone(by_title["Filed one"]["notebookResourceId"])

        other = NoteService(Path(self.directory.name) / "other.db")
        result = other.import_workspace_snapshot(backup)
        self.assertEqual(result["notesImported"], 2)
        titles = {item["title"]: item["notebookId"] for item in other.list_notes()}
        self.assertIsNone(titles["Unfiled one"])
        self.assertIsNotNone(titles["Filed one"])

    def test_import_still_rejects_a_note_naming_an_unknown_notebook(self):
        backup = workspace_backup(self.service)
        backup["notes"] = [{"resourceId": "r", "title": "Bad", "notebookResourceId": "nope", "content": {}}]
        with self.assertRaises(WorkspaceImportError):
            NoteService(Path(self.directory.name) / "x.db").import_workspace_snapshot(backup)

    def test_a_backup_note_with_no_notebook_key_lands_in_the_inbox(self):
        snapshot = {"notebooks": [], "notes": [{"title": "Loose", "content": {"nodes": [], "edges": []}}]}
        other = NoteService(Path(self.directory.name) / "loose.db")
        other.import_workspace_snapshot(snapshot)
        self.assertIsNone(other.list_notes()[0]["notebookId"])

    def test_readable_exports_name_the_inbox(self):
        self.service.create_note({"title": "Unfiled export"})
        archive = markdown_archive(self.service)
        import zipfile
        names = zipfile.ZipFile(io.BytesIO(archive)).namelist()
        self.assertTrue(any(name.startswith("notes/inbox/") for name in names), names)
        self.assertEqual(self.service.export_rows()[0]["notebookName"], "Inbox")


class InboxMigrationTests(unittest.TestCase):
    def test_an_old_database_keeps_every_note_where_it_was(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "old.db"
            first = NoteService(path)
            book = first.create_notebook({"name": "Old book"})
            filed = first.create_note({"title": "Old filed", "notebookId": book["id"]})
            # Simulate a database from before the column existed: notes had no notebook_id at all.
            connection = sqlite3.connect(path)
            connection.execute("ALTER TABLE notes DROP COLUMN notebook_id")
            connection.commit()
            connection.close()
            reopened = NoteService(path)
            notes = {item["title"]: item["notebookId"] for item in reopened.list_notes()}
            self.assertIsNotNone(notes["Old filed"])  # filed (to the first notebook, as before), not dumped in Inbox
            # ...and the Inbox is not emptied back into a notebook by the next start.
            fresh = reopened.create_note({"title": "New unfiled"})
            self.assertIsNone(NoteService(path).get_note(fresh["id"])["notebookId"])
            self.assertIsNotNone(filed)


class InboxApiAndCliTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "personal-note.db"
        self.client = TestClient(create_app(self.path))

    def tearDown(self):
        self.client.close()
        self.directory.cleanup()

    def cli(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli_main(["--database", str(self.path), *arguments])
        return code, json.loads(output.getvalue())

    def test_api_creates_into_the_inbox_and_files_by_patch(self):
        note = self.client.post("/api/notes", json={"title": "Inbox me"}).json()
        self.assertIsNone(note["notebookId"])
        notebook = self.client.post("/api/notebooks", json={"name": "Home"}).json()
        moved = self.client.patch(f"/api/notes/{note['id']}/notebook", json={"notebookId": notebook["id"], "revision": note["revision"]})
        self.assertEqual(moved.status_code, 200)
        self.assertEqual(self.client.get(f"/api/notes/{note['id']}").json()["notebookId"], notebook["id"])
        back = self.client.patch(f"/api/notes/{note['id']}/notebook", json={"notebookId": None, "revision": moved.json()["revision"]})
        self.assertEqual(back.status_code, 200)
        self.assertIsNone(self.client.get(f"/api/notes/{note['id']}").json()["notebookId"])

    def test_cli_creates_into_the_inbox_and_files_a_note(self):
        _, note = self.cli("notes", "create", "--title", "Agent capture")
        self.assertIsNone(note["notebookId"])
        _, book = self.cli("notebooks", "create", "--name", "Research")
        code, moved = self.cli("notes", "move", str(note["id"]), "--notebook-id", str(book["id"]))
        self.assertEqual(code, 0)
        self.assertEqual(self.cli("notes", "get", str(note["id"]))[1]["notebookId"], book["id"])
        self.cli("notes", "move", str(note["id"]), "--inbox")
        self.assertIsNone(self.cli("notes", "get", str(note["id"]))[1]["notebookId"])


if __name__ == "__main__":
    unittest.main()
