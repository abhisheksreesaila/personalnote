"""Page notes (F-040): Markdown text with an ink layer, through the HTTP API."""
import contextlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from starlette.testclient import TestClient

from personal_note_cli import main
from routes import create_app


class PageNoteApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.client = TestClient(create_app(Path(self.temporary_directory.name) / "personal-note.db"))
        self.notebook = self.client.get("/api/notebooks").json()[0]

    def tearDown(self):
        self.client.close()
        self.temporary_directory.cleanup()

    def create_page(self, title="Trip notes"):
        response = self.client.post("/api/notes", json={"title": title, "notebookId": self.notebook["id"], "noteType": "page"})
        self.assertEqual(response.status_code, 201)
        return response.json()

    def save(self, note, markdown, ink=None):
        return self.client.put(
            f"/api/notes/{note['id']}",
            json={
                "title": note["title"],
                "notebookId": self.notebook["id"],
                "revision": note["revision"],
                "content": {"version": 1, "markdown": markdown, "ink": ink or {"marks": [], "drawings": []}},
            },
        )

    def test_a_new_page_note_is_empty_markdown(self):
        note = self.create_page()
        self.assertEqual(note["noteType"], "page")
        self.assertEqual(note["contentFormat"], "page")
        self.assertEqual(note["content"], {"version": 1, "markdown": "", "ink": {"marks": [], "drawings": []}})

    def test_page_markdown_and_ink_round_trip_and_the_words_are_searchable(self):
        note = self.create_page()
        ink = {
            "marks": [{"id": "m1", "tool": "red", "points": [[0, 0], [10, 4]], "anchor": {"pos": 8, "quote": {"exact": "harbour", "prefix": "# Lisbon\n\n", "suffix": " walk"}}, "dx": -4, "dy": -2}],
            "drawings": [],
        }
        saved = self.save(note, "# Lisbon\n\nharbour walk at dusk", ink)
        self.assertEqual(saved.status_code, 200)

        loaded = self.client.get(f"/api/notes/{note['id']}").json()
        self.assertEqual(loaded["content"]["markdown"], "# Lisbon\n\nharbour walk at dusk")
        self.assertEqual(loaded["content"]["ink"], ink)
        self.assertEqual(loaded["revision"], 2)

        hits = self.client.get("/api/search", params={"q": "harbour"}).json()
        self.assertIn(note["id"], [hit["id"] for hit in hits])

    def test_a_stale_revision_is_refused(self):
        note = self.create_page()
        self.assertEqual(self.save(note, "first").status_code, 200)
        self.assertEqual(self.save(note, "second, from an old copy").status_code, 409)
        self.assertEqual(self.client.get(f"/api/notes/{note['id']}").json()["content"]["markdown"], "first")

    def test_scripts_that_name_no_type_still_get_a_canvas(self):
        # The app's New note asks for a page; older agent scripts that send no type keep getting what they always got.
        default = self.client.post("/api/notes", json={"title": "Untyped", "notebookId": self.notebook["id"]}).json()
        self.assertEqual(default["noteType"], "canvas")

    def test_a_page_note_lists_with_its_type(self):
        note = self.create_page("Listed page")
        listed = [item for item in self.client.get("/api/notes").json() if item["id"] == note["id"]]
        self.assertEqual(listed[0]["noteType"], "page")

    def test_backup_and_merge_import_keep_the_page_exactly(self):
        note = self.create_page("Backed up page")
        ink = {"marks": [], "drawings": [{"id": "d1", "pos": 5, "height": 160, "strokes": [], "link": None}], "folded": []}
        self.save(note, "Some *words* to keep", ink)
        backup = self.client.get("/api/export/workspace").json()
        exported = next(item for item in backup["notes"] if item["title"] == "Backed up page")
        self.assertEqual(exported["noteType"], "page")
        self.assertEqual(exported["content"], {"version": 1, "markdown": "Some *words* to keep", "ink": ink})

        imported = self.client.post("/api/import/workspace", json=backup)
        self.assertEqual(imported.status_code, 201)
        copies = [n for n in self.client.get("/api/notes").json() if n["title"] == "Backed up page"]
        self.assertEqual(len(copies), 2)
        copy = self.client.get(f"/api/notes/{max(n['id'] for n in copies)}").json()
        self.assertEqual(copy["content"], exported["content"])

    def test_markdown_export_writes_the_page_markdown_as_is(self):
        note = self.create_page("Exported page")
        self.save(note, "## Plan\n\n- pack\n- go")
        archive = zipfile.ZipFile(io.BytesIO(self.client.get("/api/export/markdown").content))
        path = next(name for name in archive.namelist() if name.endswith("exported-page.md"))
        text = archive.read(path).decode()
        self.assertIn("- Type: page", text)
        self.assertIn("## Plan\n\n- pack\n- go", text)

    def test_obsidian_vault_export_writes_a_page_as_a_plain_markdown_file(self):
        note = self.create_page("Vault page")
        self.save(note, "Plain words for Obsidian")
        archive = zipfile.ZipFile(io.BytesIO(self.client.get("/api/export/vault").content))
        path = next(name for name in archive.namelist() if name.endswith("Vault page.md"))
        self.assertEqual(archive.read(path).decode(), "Plain words for Obsidian\n")


class PageNoteCliTests(unittest.TestCase):
    """Agents work on pages through the CLI: create, read and append, all through NoteService."""

    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database = str(Path(self.temporary_directory.name) / "personal-note.db")

    def tearDown(self):
        self.temporary_directory.cleanup()

    def cli(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["--database", self.database, *arguments])
        return code, output.getvalue()

    def test_an_agent_creates_a_page_with_text_and_reads_it_back_as_markdown(self):
        code, out = self.cli("notes", "create", "--title", "Agent page", "--type", "page", "--text", "# Findings\n\nThe cache is cold.")
        self.assertEqual(code, 0)
        note = json.loads(out)
        self.assertEqual(note["noteType"], "page")
        code, text = self.cli("notes", "read", str(note["id"]), "--text")
        self.assertEqual(text, "# Findings\n\nThe cache is cold.\n")

    def test_append_adds_a_paragraph_at_the_end_and_keeps_the_ink(self):
        code, out = self.cli("notes", "create", "--title", "Log", "--type", "page", "--text", "Day one.")
        note = json.loads(out)
        code, out = self.cli("notes", "append", str(note["id"]), "--text", "Day two.")
        self.assertEqual(code, 0)
        code, text = self.cli("notes", "read", str(note["id"]), "--text")
        self.assertEqual(text, "Day one.\n\nDay two.\n")


if __name__ == "__main__":
    unittest.main()
