import tempfile
import unittest
from pathlib import Path

from note_text import note_plain_text
from services import ConflictError, NoteService, NotFoundError, UnsupportedNoteTypeError


class TempServiceCase(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "personal-note.db"
        self.service = NoteService(self.database_path)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def canvas_note(self, objects, page_state=None, title="Agent note"):
        note = self.service.create_note({"title": title})
        self.service.update_note(
            note["id"],
            {
                "title": title,
                "revision": note["revision"],
                "content": {"objects": objects},
                "pageState": page_state or {"columns": 1, "rows": 1},
            },
        )
        return self.service.get_note(note["id"])


class PlainTextTests(TempServiceCase):
    def test_canvas_text_is_ordered_top_to_bottom_then_left_to_right(self):
        note = self.canvas_note(
            [
                {"type": "IText", "text": "third", "left": 10, "top": 300},
                {"type": "IText", "text": "second right", "left": 400, "top": 100},
                {"type": "IText", "text": "second left", "left": 50, "top": 100},
                {"type": "Path", "path": []},
                {"type": "IText", "text": "first", "left": 10, "top": 10},
            ]
        )
        self.assertEqual(
            note_plain_text(note),
            "first\n\nsecond left\n\nsecond right\n\nthird",
        )

    def test_mind_map_reads_as_an_indented_outline(self):
        note = self.service.create_note({"title": "Map", "noteType": "mindmap"})
        document = {
            "version": 1,
            "rootId": "root",
            "nodes": [
                {"id": "root", "parentId": None, "text": "Plan", "x": 0, "y": 0},
                {"id": "b", "parentId": "root", "text": "Second", "x": 0, "y": 50},
                {"id": "a", "parentId": "root", "text": "First", "x": 0, "y": 10},
                {"id": "c", "parentId": "a", "text": "Detail", "x": 0, "y": 0},
            ],
        }
        self.service.update_note(
            note["id"], {"title": "Map", "revision": note["revision"], "content": document}
        )
        loaded = self.service.get_note(note["id"])
        self.assertEqual(
            note_plain_text(loaded), "- Plan\n  - First\n    - Detail\n  - Second"
        )


class AppendTextTests(TempServiceCase):
    def test_append_places_text_below_existing_content_with_a_revision_bump(self):
        note = self.canvas_note(
            [{"type": "IText", "text": "existing", "left": 72, "top": 80, "height": 60}]
        )
        result = self.service.append_text(note["id"], "agent line", revision=note["revision"])
        self.assertEqual(result["revision"], note["revision"] + 1)
        loaded = self.service.get_note(note["id"])
        objects = loaded["content"]["objects"]
        self.assertEqual([item["text"] for item in objects], ["existing", "agent line"])
        self.assertGreaterEqual(objects[1]["top"], 80 + 60)
        self.assertTrue(objects[1]["semanticId"])

    def test_append_grows_pages_when_content_would_pass_the_bottom_edge(self):
        note = self.canvas_note(
            [{"type": "IText", "text": "low", "left": 72, "top": 1000, "height": 40}],
            page_state={"columns": 1, "rows": 1},
        )
        self.service.append_text(note["id"], "next page text")
        loaded = self.service.get_note(note["id"])
        self.assertGreaterEqual(loaded["pageState"]["rows"], 2)
        self.assertEqual(loaded["pageState"]["columns"], 1)
        new = loaded["content"]["objects"][-1]
        self.assertLess(new["top"], loaded["pageState"]["rows"] * 1080)

    def test_append_to_empty_note_starts_near_the_top_of_the_page(self):
        note = self.service.create_note({"title": "Empty"})
        self.service.append_text(note["id"], "hello")
        loaded = self.service.get_note(note["id"])
        self.assertEqual(loaded["content"]["objects"][0]["top"], 80)
        self.assertEqual(loaded["pageState"], {"columns": 1, "rows": 1})

    def test_append_rejects_a_stale_revision_and_leaves_the_note_intact(self):
        note = self.canvas_note([{"type": "IText", "text": "keep", "left": 72, "top": 80}])
        with self.assertRaises(ConflictError):
            self.service.append_text(note["id"], "late", revision=note["revision"] - 1)
        self.assertEqual(self.service.get_note(note["id"])["content"], note["content"])

    def test_append_keeps_unrelated_objects_untouched(self):
        drawing = {"type": "Path", "path": [["M", 0, 0], ["L", 10, 10]], "top": 20, "left": 20, "height": 10, "stroke": "#000"}
        note = self.canvas_note([drawing])
        self.service.append_text(note["id"], "note")
        objects = self.service.get_note(note["id"])["content"]["objects"]
        self.assertEqual(objects[0]["path"], drawing["path"])
        self.assertEqual(objects[0]["stroke"], "#000")

    def test_append_refuses_mind_maps_and_missing_notes(self):
        mindmap = self.service.create_note({"title": "Map", "noteType": "mindmap"})
        with self.assertRaises(UnsupportedNoteTypeError):
            self.service.append_text(mindmap["id"], "x")
        with self.assertRaises(NotFoundError):
            self.service.append_text(9999, "x")

    def test_append_rejects_blank_text(self):
        note = self.service.create_note({"title": "Empty"})
        with self.assertRaises(ValueError):
            self.service.append_text(note["id"], "   ")

    def test_appended_text_is_searchable(self):
        note = self.service.create_note({"title": "Empty"})
        self.service.append_text(note["id"], "quokka migration plan")
        self.assertEqual(self.service.search("quokka")[0]["id"], note["id"])


if __name__ == "__main__":
    unittest.main()
