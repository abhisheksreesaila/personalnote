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



class CanvasAgentTests(unittest.TestCase):
    """F-052: agents write a canvas note's Markdown text through the CLI; marks and linked objects find their words again, never lost."""

    def setUp(self):
        import contextlib
        from personal_note_cli import main
        self.main = main
        self.redirect = contextlib.redirect_stdout
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database = str(Path(self.temporary_directory.name) / "personal-note.db")

    def tearDown(self):
        self.temporary_directory.cleanup()

    def cli(self, *arguments):
        output = io.StringIO()
        with self.redirect(output):
            code = self.main(["--database", self.database, *arguments])
        return code, output.getvalue()

    def canvas(self, nodes):
        code, out = self.cli("notes", "create", "--title", "Trip")
        note = json.loads(out)
        from services import NoteService
        service = NoteService(Path(self.database))
        service.update_note(note["id"], {"title": "Trip", "notebookId": note["notebookId"], "revision": note["revision"], "content": {"nodes": nodes, "edges": []}, "pageState": {"columns": 1, "rows": 1}})
        return note["id"]

    def nodes(self, note_id):
        code, out = self.cli("notes", "get", str(note_id))
        return {node["id"]: node for node in json.loads(out)["content"]["nodes"]}

    def test_append_to_a_canvas_adds_markdown_text(self):
        note_id = self.canvas([])
        self.cli("notes", "append", str(note_id), "--text", "## Findings\n- cold cache")
        [node] = [node for node in self.nodes(note_id).values() if node["type"] == "text"]
        self.assertEqual(node["text"], "## Findings\n- cold cache")
        self.assertEqual(node["pn"]["format"], "markdown")

    def test_write_rewrites_the_markdown_and_ink_finds_its_words(self):
        mark = lambda mark_id, word, pos: {"id": mark_id, "kind": "stroke", "tool": "pen", "width": 2, "color": "#1d3f9e", "path": [["M", 0, 0], ["L", 30, 0]], "anchor": {"pos": pos, "end": pos + len(word), "quote": {"exact": word, "prefix": "", "suffix": ""}, "dx": -2, "dy": 18}}
        text = {"id": "res_md", "type": "text", "x": 80, "y": 90, "width": 700, "height": 100, "text": SOURCE,
                "pn": {"type": "text", "mode": "box", "z": 0, "format": "markdown", "geometry": GEOMETRY, "style": {"fontSize": 24}, "marks": [mark("m1", "harbour", 20), mark("m2", "bread", 46)]}}
        linked = lambda node_id, word, pos: {"id": node_id, "type": "file", "x": 100, "y": 400, "width": 40, "height": 40, "file": "", "pn": {"type": "shape", "kind": "rect", "z": 1, "geometry": {**GEOMETRY, "x": 100, "y": 400, "width": 40, "height": 40}, "fill": "#ffd60a", "link": {"textId": "res_md", "pos": pos, "end": pos + len(word), "quote": {"exact": word}}, "folded": True}}
        note_id = self.canvas([text, linked("res_a", "walk", 30), linked("res_b", "bread", 46)])
        code, out = self.cli("notes", "write", str(note_id), "--text", "# Lisbon\nWe took the **harbour** walk again.")
        self.assertEqual(code, 0, out)
        nodes = self.nodes(note_id)
        rewritten = nodes["res_md"]
        self.assertEqual(rewritten["text"], "# Lisbon\nWe took the **harbour** walk again.")
        [kept] = rewritten["pn"]["marks"]
        self.assertEqual((kept["id"], kept["anchor"]["pos"], kept["anchor"]["end"]), ("m1", 23, 30))
        loose = [node for node in nodes.values() if node["pn"].get("type") == "ink"]
        self.assertEqual(len(loose), 1, "a mark whose words are gone is kept as ink beside the text")
        self.assertEqual((nodes["res_a"]["pn"]["link"]["pos"], nodes["res_a"]["pn"]["folded"]), (33, True))
        self.assertIsNone(nodes["res_b"]["pn"].get("link"))
        self.assertFalse(nodes["res_b"]["pn"]["folded"], "an object whose words are gone is shown, never left hidden")

    def test_write_can_pick_the_text_and_makes_one_when_there_is_none(self):
        note_id = self.canvas([])
        self.cli("notes", "write", str(note_id), "--text", "first words")
        [node] = [node for node in self.nodes(note_id).values() if node["type"] == "text"]
        self.assertEqual((node["text"], node["pn"]["format"]), ("first words", "markdown"))
        self.cli("notes", "write", str(note_id), "--object", node["id"], "--text", "second words")
        self.assertEqual(self.nodes(note_id)[node["id"]]["text"], "second words")
        code, out = self.cli("notes", "write", str(note_id), "--object", "res_nothing", "--text", "x")
        self.assertNotEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
