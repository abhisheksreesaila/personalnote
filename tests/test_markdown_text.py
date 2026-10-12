"""Markdown text on the canvas (F-048, ADR 0004): a canvas text whose words are Markdown keeps them, and its extra fields, through the API."""
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from starlette.testclient import TestClient

from routes import create_app

SOURCE = "# Lisbon trip\nThe **harbour** walk at dusk.\n- bread"
GEOMETRY = {"x": 80, "y": 90, "width": 724, "height": 120, "rotation": 0, "scaleX": 1, "scaleY": 1, "flipX": False, "flipY": False, "skewX": 0, "skewY": 0}


def canvas_with_markdown_text():
    pn = {"type": "text", "mode": "box", "z": 0, "format": "markdown", "geometry": GEOMETRY, "style": {"fontSize": 24}}
    return {"nodes": [{"id": "res_md", "type": "text", "x": 80, "y": 90, "width": 724, "height": 120, "text": SOURCE, "pn": pn}], "edges": []}


class MarkdownTextTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.client = TestClient(create_app(Path(self.temporary_directory.name) / "personal-note.db"))
        self.notebook = self.client.get("/api/notebooks").json()[0]
        created = self.client.post("/api/notes", json={"title": "Trip", "notebookId": self.notebook["id"], "noteType": "canvas"}).json()
        saved = self.client.put(f"/api/notes/{created['id']}", json={"title": "Trip", "notebookId": self.notebook["id"], "revision": created["revision"], "content": canvas_with_markdown_text(), "pageState": {"columns": 1, "rows": 1}})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.note_id = created["id"]

    def tearDown(self):
        self.client.close()
        self.temporary_directory.cleanup()

    def text_node(self, note_id):
        note = self.client.get(f"/api/notes/{note_id}").json()
        return next(node for node in note["content"]["nodes"] if node["type"] == "text")

    def test_the_markdown_and_its_format_are_kept(self):
        node = self.text_node(self.note_id)
        self.assertEqual(node["text"], SOURCE)
        self.assertEqual(node["pn"]["format"], "markdown")

    def test_search_finds_its_words(self):
        matches = self.client.get("/api/search", params={"q": "harbour"}).json()
        self.assertEqual([match["id"] for match in matches], [self.note_id])

    def test_backup_and_import_keep_it_markdown(self):
        backup = self.client.get("/api/export/workspace").json()
        imported = self.client.post("/api/import/workspace", json=backup).json()
        node = self.text_node(imported["noteIds"][0])
        self.assertEqual(node["text"], SOURCE)
        self.assertEqual(node["pn"]["format"], "markdown")

    def test_markdown_export_writes_the_markdown_as_typed(self):
        archive = zipfile.ZipFile(io.BytesIO(self.client.get("/api/export/markdown").content))
        written = "\n".join(archive.read(name).decode("utf-8") for name in archive.namelist() if name.endswith(".md"))
        self.assertIn(SOURCE, written)


if __name__ == "__main__":
    unittest.main()
