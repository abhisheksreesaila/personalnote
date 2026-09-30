import tempfile
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from note_text import note_plain_text
from routes import create_app
from services import (
    AGENT_ACTIVITY_WINDOW,
    AppendTextError,
    ConflictError,
    NoteService,
    NotFoundError,
    UnsupportedNoteTypeError,
)


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


class StickyAndShapeTests(TempServiceCase):
    OBJECTS = [
        {"type": "Sticky", "text": "Renew the passport", "stickyColor": "#ffd60a", "originX": "center", "originY": "center",
         "left": 300, "top": 200, "width": 240, "height": 200},
        {"type": "Rect", "fill": "#64b5ff", "rx": 28, "ry": 28, "originX": "center", "originY": "center",
         "left": 600, "top": 200, "width": 280, "height": 180},
        {"type": "IText", "text": "plain text", "left": 10, "top": 600},
    ]

    def test_sticky_text_is_read_and_shapes_add_nothing(self):
        note = self.canvas_note(self.OBJECTS)
        self.assertEqual(note_plain_text(note), "Renew the passport\n\nplain text")

    def test_an_empty_sticky_reads_as_nothing(self):
        note = self.canvas_note([{"type": "Sticky", "text": "", "stickyColor": "#30d158", "top": 50, "left": 50}])
        self.assertEqual(note_plain_text(note), "")

    def test_append_lands_below_the_lowest_sticky_or_shape(self):
        objects = [dict(item, top=item["top"] + 500) if item["type"] != "IText" else item for item in self.OBJECTS[:2]]
        note = self.canvas_note(objects)
        self.service.append_text(note["id"], "agent line")
        appended = self.service.get_note(note["id"])["content"]["objects"][-1]
        lowest_bottom = 700 + 100
        self.assertGreater(appended["top"], lowest_bottom)
        self.assertEqual([item["type"] for item in self.service.get_note(note["id"])["content"]["objects"][:2]], ["Sticky", "Rect"])


class ConnectorHandlingTests(TempServiceCase):
    OBJECTS = [
        {"type": "IText", "text": "left card", "semanticId": "res_a", "left": 72, "top": 80, "height": 60, "originY": "top"},
        {"type": "IText", "text": "right card", "semanticId": "res_b", "left": 400, "top": 80, "height": 60, "originY": "top"},
        {"type": "Connector", "semanticId": "res_c", "fromId": "res_a", "toId": "res_b",
         "originX": "center", "originY": "center", "left": 300, "top": 110, "width": 120, "height": 1},
    ]

    def test_plain_text_read_ignores_connectors(self):
        note = self.canvas_note(self.OBJECTS)
        self.assertEqual(note_plain_text(note), "left card\n\nright card")

    def test_append_lands_below_cards_and_leaves_connectors_untouched(self):
        note = self.canvas_note(self.OBJECTS)
        self.service.append_text(note["id"], "agent line")
        objects = self.service.get_note(note["id"])["content"]["objects"]
        self.assertEqual([o["type"] for o in objects], ["IText", "IText", "Connector", "Textbox"])
        self.assertGreaterEqual(objects[-1]["top"], 140)
        connector = objects[2]
        self.assertEqual((connector["fromId"], connector["toId"]), ("res_a", "res_b"))


class AppendTextTests(TempServiceCase):
    def test_append_places_text_below_existing_content_with_a_revision_bump(self):
        note = self.canvas_note(
            [{"type": "IText", "text": "existing", "left": 72, "top": 80, "height": 60, "originY": "top"}]
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
            [{"type": "IText", "text": "low", "left": 72, "top": 1000, "height": 40, "originY": "top"}],
            page_state={"columns": 1, "rows": 1},
        )
        self.service.append_text(note["id"], "next page text")
        loaded = self.service.get_note(note["id"])
        self.assertGreaterEqual(loaded["pageState"]["rows"], 2)
        self.assertEqual(loaded["pageState"]["columns"], 1)
        new = loaded["content"]["objects"][-1]
        self.assertLess(new["top"], loaded["pageState"]["rows"] * 1080)

    def test_append_understands_centre_origin_objects_saved_by_the_browser(self):
        note = self.canvas_note(
            [{"type": "Textbox", "text": "centred", "left": 400, "top": 500, "height": 100, "originX": "center", "originY": "center"}]
        )
        self.service.append_text(note["id"], "below")
        new = self.service.get_note(note["id"])["content"]["objects"][-1]
        self.assertGreaterEqual(new["top"], 550)
        self.assertLess(new["top"], 620)
        self.assertEqual((new["originX"], new["originY"]), ("left", "top"))

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
        with self.assertRaises(AppendTextError):
            self.service.append_text(note["id"], "   ")

    def test_appended_text_is_searchable(self):
        note = self.service.create_note({"title": "Empty"})
        self.service.append_text(note["id"], "quokka migration plan")
        self.assertEqual(self.service.search("quokka")[0]["id"], note["id"])


class AgentActivityTests(TempServiceCase):
    def test_activity_records_who_note_action_and_expires(self):
        note = self.service.create_note({"title": "Watched"})
        self.service.record_agent_activity("Claude Code", note["id"], "reading", now=1000.0)
        active = self.service.active_agents(now=1003.0)
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["agent"], "Claude Code")
        self.assertEqual(active[0]["noteId"], note["id"])
        self.assertEqual(active[0]["noteTitle"], "Watched")
        self.assertEqual(active[0]["action"], "reading")
        self.assertEqual(self.service.active_agents(now=1000.0 + AGENT_ACTIVITY_WINDOW + 1), [])

    def test_latest_action_per_agent_wins(self):
        note = self.service.create_note({"title": "Watched"})
        self.service.record_agent_activity("Claude Code", note["id"], "reading", now=1000.0)
        self.service.record_agent_activity("Claude Code", note["id"], "writing", now=1001.0)
        self.assertEqual([a["action"] for a in self.service.active_agents(now=1002.0)], ["writing"])

    def test_unknown_actions_are_rejected(self):
        with self.assertRaises(ValueError):
            self.service.record_agent_activity("Claude Code", None, "deleting")


class LegacyDatabaseTests(TempServiceCase):
    def test_a_database_created_before_agent_activity_upgrades_in_place(self):
        note = self.service.create_note({"title": "Old"})
        import sqlite3

        with sqlite3.connect(self.database_path) as connection:
            connection.execute("DROP TABLE agent_activity")
        upgraded = NoteService(self.database_path)
        upgraded.record_agent_activity("Claude Code", note["id"], "reading")
        self.assertEqual(upgraded.active_agents()[0]["noteId"], note["id"])
        self.assertEqual(upgraded.get_note(note["id"])["title"], "Old")


class ChangesSinceTests(TempServiceCase):
    def test_reports_changes_after_a_sequence_and_the_current_sequence(self):
        baseline = self.service.changes_since(None)
        self.assertEqual(baseline["changes"], [])
        note = self.service.create_note({"title": "A"})
        self.service.append_text(note["id"], "more")
        result = self.service.changes_since(baseline["sequence"])
        self.assertEqual(result["sequence"], baseline["sequence"] + 2)
        self.assertEqual(
            [(c["resourceKind"], c["changeType"], c["revision"]) for c in result["changes"]],
            [("note", "created", 1), ("note", "updated", 2)],
        )
        self.assertEqual(result["changes"][0]["resourceId"], note["resourceId"])
        self.assertEqual(self.service.changes_since(result["sequence"])["changes"], [])


class ChangesEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "personal-note.db"
        self.client = TestClient(create_app(self.database_path))
        self.service = NoteService(self.database_path)

    def tearDown(self):
        self.client.close()
        self.temporary_directory.cleanup()

    def test_browser_sees_an_agent_write_and_presence_through_one_cheap_poll(self):
        baseline = self.client.get("/api/changes").json()
        self.assertEqual(baseline["changes"], [])
        note = self.client.post("/api/notes", json={"title": "Shared"}).json()
        seen = self.client.get(f"/api/changes?since={baseline['sequence']}").json()["sequence"]
        self.service.append_text(note["id"], "from the agent", revision=note["revision"])
        self.service.record_agent_activity("Claude Code", note["id"], "writing")
        polled = self.client.get(f"/api/changes?since={seen}").json()
        self.assertEqual(polled["changes"][0]["resourceId"], note["resourceId"])
        self.assertEqual(polled["changes"][0]["revision"], note["revision"] + 1)
        self.assertEqual(polled["agents"][0]["agent"], "Claude Code")
        self.assertEqual(polled["agents"][0]["action"], "writing")

    def test_rejects_a_non_numeric_cursor_with_a_plain_baseline(self):
        response = self.client.get("/api/changes?since=abc")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["changes"], [])


if __name__ == "__main__":
    unittest.main()
