"""F-096: what a local agent wrote can be shown and undone, and undo never costs the person their own later edits."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from starlette.testclient import TestClient

from agent_edit import merge_markdown
from json_canvas import from_json_canvas
from personal_note_cli import main
from routes import create_app
from services import ConflictError, NoteService, NotFoundError, SecureNoteAgentError
from tests.test_secure_notes import SECRET, SecureCase

APP = {"x-personal-note": "1"}


class AgentEditCase(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "personal-note.db"
        self.client = TestClient(create_app(self.database_path))
        self.service = NoteService(self.database_path)

    def tearDown(self):
        self.client.close()
        self.temporary_directory.cleanup()

    def cli(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["--database", str(self.database_path), *arguments])
        self.assertEqual(code, 0)
        return json.loads(output.getvalue()) if output.getvalue().strip() else None

    def canvas(self, text="First thought"):
        note = self.client.post("/api/notes", json={"title": "Canvas"}).json()
        self.service.append_text(note["id"], text, revision=note["revision"])  # (the person's own first words: no agent)
        return self.service.get_note(note["id"])

    def page(self, markdown):
        note = self.client.post("/api/notes", json={"title": "Page", "noteType": "page"}).json()
        self.service.write_page(note["id"], markdown, revision=note["revision"])
        return self.service.get_note(note["id"])

    def texts(self, note_id):
        note = self.service.get_note(note_id)
        return [item["content"] for item in from_json_canvas(note["content"])["objects"] if item["type"] == "text"]

    def edit_of(self, note_id, revision):
        return self.client.get(f"/api/notes/{note_id}/agent-edit?revision={revision}").json()["edit"]

    def undo(self, edit_id):
        return self.client.post(f"/api/agent-edits/{edit_id}/undo", headers=APP)

    def redo(self, edit_id):
        return self.client.post(f"/api/agent-edits/{edit_id}/redo", headers=APP)

    def person_saves_canvas(self, note_id, change):
        """The person's own save: the stored canvas with `change(objects)` applied, on the current revision."""
        note = self.service.get_note(note_id)
        document = from_json_canvas(note["content"])
        change(document["objects"])
        from json_canvas import to_json_canvas
        return self.service.update_note(note_id, {"title": note["title"], "revision": note["revision"], "notebookId": note["notebookId"], "content": to_json_canvas(document)})


class RecordingTests(AgentEditCase):
    def test_a_cli_append_is_remembered_with_who_and_what_it_added(self):
        note = self.canvas()
        result = self.cli("--agent", "Claude Code", "notes", "append", str(note["id"]), "--text", "From the agent")
        edit = self.edit_of(note["id"], result["revision"])
        self.assertEqual(edit["agent"], "Claude Code")
        self.assertEqual(edit["state"], "applied")
        added = [item["id"] for item in from_json_canvas(self.service.get_note(note["id"])["content"])["objects"] if item.get("content") == "From the agent"]
        self.assertEqual(edit["changed"], {"kind": "canvas", "ids": added})

    def test_a_page_rewrite_names_the_words_it_changed(self):
        note = self.page("One\n\nTwo\n\nThree")
        result = self.cli("notes", "write", str(note["id"]), "--text", "One\n\nTWO and more\n\nThree")
        edit = self.edit_of(note["id"], result["revision"])
        markdown = self.service.get_note(note["id"])["content"]["markdown"]
        self.assertEqual(markdown[edit["changed"]["from"]:edit["changed"]["to"]], "TWO and more")

    def test_an_appended_paragraph_is_named_without_the_line_before_it(self):
        note = self.page("My own page")
        result = self.cli("notes", "append", str(note["id"]), "--text", "Agent paragraph")
        edit = self.edit_of(note["id"], result["revision"])
        markdown = self.service.get_note(note["id"])["content"]["markdown"]
        self.assertEqual(markdown[edit["changed"]["from"]:edit["changed"]["to"]], "Agent paragraph")

    def test_the_people_saving_is_not_an_agent_edit(self):
        note = self.canvas()
        saved = self.person_saves_canvas(note["id"], lambda objects: None)
        self.assertIsNone(self.edit_of(note["id"], saved["revision"]))

    def test_another_revision_has_no_edit(self):
        note = self.canvas()
        result = self.cli("notes", "append", str(note["id"]), "--text", "Added")
        self.assertIsNone(self.edit_of(note["id"], result["revision"] + 1))

    def test_deleting_the_note_forgets_its_edits(self):
        note = self.canvas()
        result = self.cli("notes", "append", str(note["id"]), "--text", "Added")
        edit = self.edit_of(note["id"], result["revision"])
        self.service.delete_note(note["id"])
        self.assertEqual(self.undo(edit["id"]).status_code, 404)


class UndoCanvasTests(AgentEditCase):
    def test_undo_takes_the_agents_words_off_and_redo_puts_them_back(self):
        note = self.canvas()
        result = self.cli("notes", "append", str(note["id"]), "--text", "From the agent")
        edit = self.edit_of(note["id"], result["revision"])
        undone = self.undo(edit["id"])
        self.assertEqual(undone.status_code, 200)
        self.assertEqual(undone.json()["revision"], result["revision"] + 1)  # one step, on top of the agent's revision
        self.assertEqual(self.texts(note["id"]), ["First thought"])
        self.assertEqual(self.edit_of(note["id"], result["revision"])["state"], "undone")
        redone = self.redo(edit["id"])
        self.assertEqual(redone.status_code, 200)
        self.assertEqual(self.texts(note["id"]), ["First thought", "From the agent"])

    def test_undo_brings_back_what_a_rewrite_replaced(self):
        note = self.canvas("Original words")
        result = self.cli("notes", "write", str(note["id"]), "--text", "Rewritten words")
        self.assertEqual(self.texts(note["id"]), ["Rewritten words"])
        self.assertEqual(self.undo(self.edit_of(note["id"], result["revision"])["id"]).status_code, 200)
        self.assertEqual(self.texts(note["id"]), ["Original words"])

    def test_undo_keeps_what_the_person_changed_elsewhere_since(self):
        note = self.canvas()
        result = self.cli("notes", "append", str(note["id"]), "--text", "From the agent")
        edit = self.edit_of(note["id"], result["revision"])

        def person_adds_a_note(objects):
            first = next(item for item in objects if item.get("content") == "First thought")
            first["content"] = "First thought, and my own addition"

        self.person_saves_canvas(note["id"], person_adds_a_note)
        self.assertEqual(self.undo(edit["id"]).status_code, 200)
        self.assertEqual(self.texts(note["id"]), ["First thought, and my own addition"])

    def test_undo_still_works_after_the_app_saved_the_note_in_a_shifted_page_frame(self):
        # The app writes a note in its own page frame (everything moved by a page width when it grew pages to the left): that is not an edit.
        note = self.canvas()
        result = self.cli("notes", "append", str(note["id"]), "--text", "From the agent")
        edit = self.edit_of(note["id"], result["revision"])

        def app_moves_everything_right(objects):
            for item in objects:
                item["geometry"]["x"] += 860

        self.person_saves_canvas(note["id"], app_moves_everything_right)
        self.assertEqual(self.undo(edit["id"]).status_code, 200)
        stored = [item for item in from_json_canvas(self.service.get_note(note["id"])["content"])["objects"] if item["type"] == "text"]
        self.assertEqual([item["content"] for item in stored], ["First thought"])
        self.assertGreaterEqual(stored[0]["geometry"]["x"], 860)  # (it stays where the app put it)
        self.assertEqual(self.redo(edit["id"]).status_code, 200)
        back = [item for item in from_json_canvas(self.service.get_note(note["id"])["content"])["objects"] if item["type"] == "text"]
        self.assertEqual([item["content"] for item in back], ["First thought", "From the agent"])
        self.assertEqual({item["geometry"]["x"] >= 860 for item in back}, {True})  # (the agent's words come back in the app's frame)

    def test_undo_refuses_when_the_person_edited_the_agents_own_words(self):
        note = self.canvas()
        result = self.cli("notes", "append", str(note["id"]), "--text", "From the agent")
        edit = self.edit_of(note["id"], result["revision"])

        def person_edits_agent_words(objects):
            next(item for item in objects if item.get("content") == "From the agent")["content"] = "From the agent, fixed by me"

        saved = self.person_saves_canvas(note["id"], person_edits_agent_words)
        refused = self.undo(edit["id"])
        self.assertEqual(refused.status_code, 409)
        self.assertEqual(refused.json()["error"], "You changed Claude Code’s words after it wrote them, so Undo would overwrite your edit. Nothing was changed.")
        self.assertEqual(self.texts(note["id"]), ["First thought", "From the agent, fixed by me"])
        self.assertEqual(self.service.get_note(note["id"])["revision"], saved["revision"])

    def test_undo_twice_is_refused(self):
        note = self.canvas()
        result = self.cli("notes", "append", str(note["id"]), "--text", "From the agent")
        edit = self.edit_of(note["id"], result["revision"])
        self.assertEqual(self.undo(edit["id"]).status_code, 200)
        again = self.undo(edit["id"])
        self.assertEqual(again.status_code, 409)
        self.assertEqual(again.json()["error"], "This edit is already undone.")

    def test_undo_needs_the_app_header(self):
        note = self.canvas()
        result = self.cli("notes", "append", str(note["id"]), "--text", "From the agent")
        edit = self.edit_of(note["id"], result["revision"])
        self.assertEqual(self.client.post(f"/api/agent-edits/{edit['id']}/undo").status_code, 403)


class UndoPageTests(AgentEditCase):
    def test_undo_of_an_appended_paragraph_and_redo(self):
        note = self.page("My own page")
        result = self.cli("notes", "append", str(note["id"]), "--text", "Agent paragraph")
        edit = self.edit_of(note["id"], result["revision"])
        self.assertEqual(self.undo(edit["id"]).status_code, 200)
        self.assertEqual(self.service.get_note(note["id"])["content"]["markdown"], "My own page")
        self.assertEqual(self.redo(edit["id"]).status_code, 200)
        self.assertEqual(self.service.get_note(note["id"])["content"]["markdown"], "My own page\n\nAgent paragraph")

    def test_undo_keeps_a_line_the_person_added_above_since(self):
        note = self.page("My own page")
        result = self.cli("notes", "append", str(note["id"]), "--text", "Agent paragraph")
        edit = self.edit_of(note["id"], result["revision"])
        current = self.service.get_note(note["id"])
        self.service.write_page(note["id"], "A title I typed\n\n" + current["content"]["markdown"], revision=current["revision"])
        self.assertEqual(self.undo(edit["id"]).status_code, 200)
        self.assertEqual(self.service.get_note(note["id"])["content"]["markdown"], "A title I typed\n\nMy own page")

    def test_undo_refuses_when_the_person_reworded_the_agents_paragraph(self):
        note = self.page("My own page")
        result = self.cli("notes", "append", str(note["id"]), "--text", "Agent paragraph")
        edit = self.edit_of(note["id"], result["revision"])
        current = self.service.get_note(note["id"])
        self.service.write_page(note["id"], current["content"]["markdown"].replace("Agent", "Better"), revision=current["revision"])
        refused = self.undo(edit["id"])
        self.assertEqual(refused.status_code, 409)
        self.assertIn("so Undo would overwrite your edit", refused.json()["error"])
        self.assertEqual(self.service.get_note(note["id"])["content"]["markdown"], "My own page\n\nBetter paragraph")

    def test_undo_of_a_rewrite_restores_the_old_paragraph_in_place(self):
        note = self.page("One\n\nTwo\n\nThree")
        result = self.cli("notes", "write", str(note["id"]), "--text", "One\n\nTWO and more\n\nThree")
        edit = self.edit_of(note["id"], result["revision"])
        self.assertEqual(self.undo(edit["id"]).status_code, 200)
        self.assertEqual(self.service.get_note(note["id"])["content"]["markdown"], "One\n\nTwo\n\nThree")


class MergeMarkdownTests(unittest.TestCase):
    def test_a_short_change_never_lands_on_other_words(self):
        # base -> target fixes a typo in "the"; the person has since rewritten the rest of the line
        self.assertIsNone(merge_markdown("Notes: the plan", "Notes: hello world", "Notes: teh plan"))

    def test_the_change_is_made_where_the_same_words_still_stand(self):
        self.assertEqual(merge_markdown("one two three", "zero one two three", "one TWO three"), "zero one TWO three")

    def test_words_that_appear_twice_are_found_by_what_surrounds_them(self):
        self.assertEqual(merge_markdown("a cat\n\nb cat", "a cat\n\nb cat\n\nmine", "a cat\n\nb dog"), "a cat\n\nb dog\n\nmine")

    def test_the_words_around_the_change_being_edited_is_unsure_and_refused(self):
        self.assertIsNone(merge_markdown("alpha beta gamma", "alpha BETA! gamma", "alpha beta2 gamma"))


class SecureNoteTests(SecureCase):
    def agent_edit(self, text):
        note = self.page_note(markdown="plain start")
        with self.service.as_agent("Claude Code"):
            result = self.service.append_text(note["id"], text, revision=note["revision"])
        with self.service.connection() as connection:
            edit = connection.execute("SELECT id FROM agent_edits WHERE note_id = ?", (note["id"],)).fetchone()
        return note, result, edit["id"]

    def edit_count(self):
        with self.service.connection() as connection:
            return connection.execute("SELECT COUNT(*) FROM agent_edits").fetchone()[0]

    def test_making_the_note_secure_forgets_the_agents_plain_copies_and_undo_cannot_wipe_it(self):
        note, _, edit_id = self.agent_edit(SECRET)
        self.assertEqual(self.edit_count(), 1)
        self.service.mark_secure(note["id"])
        self.assertEqual(self.edit_count(), 0)
        self.assert_no_words_on_disk()
        with self.assertRaises(NotFoundError):
            self.service.undo_agent_edit(edit_id)
        self.assertIn(SECRET, json.dumps(self.service.get_note(note["id"])["content"]))  # (still there, sealed)

    def test_undo_on_a_secure_note_refuses_plainly_even_if_a_copy_were_left(self):
        note, _, edit_id = self.agent_edit("plain agent words")
        self.service.mark_secure(note["id"])
        with self.service.connection() as connection:
            connection.execute("INSERT INTO agent_edits (id, note_id, agent, after_revision, changed, before_content, before_format, before_page_state, after_content, after_format, after_page_state, at) VALUES (?, ?, 'x', 1, '{}', '{}', 'page', '{}', '{}', 'page', '{}', 0)", (edit_id + 100, note["id"]))
            connection.commit()
        with self.assertRaisesRegex(ConflictError, "secure now"):
            self.service.undo_agent_edit(edit_id + 100)
        self.assertIn("plain start", json.dumps(self.service.get_note(note["id"])["content"]))

    def test_an_agent_write_to_a_secure_note_is_refused_and_records_nothing(self):
        note = self.page_note()
        self.service.mark_secure(note["id"])
        with self.service.as_agent("Claude Code"), self.assertRaises(SecureNoteAgentError):
            self.service.append_text(note["id"], "more words", revision=self.service.get_note(note["id"])["revision"])
        self.assertEqual(self.edit_count(), 0)


class TurnTests(AgentEditCase):
    def test_a_save_landing_between_the_merge_and_the_write_is_looked_at_again_once(self):
        note = self.canvas()
        result = self.cli("notes", "append", str(note["id"]), "--text", "From the agent")
        edit = self.edit_of(note["id"], result["revision"])
        real = self.service.update_note
        calls = []

        def racing(note_id, payload, **kwargs):
            calls.append(payload["revision"])
            if len(calls) == 1:
                real(note_id, {**payload, "title": "Renamed meanwhile"})  # an autosave lands first
            return real(note_id, payload, **kwargs)

        with mock.patch.object(self.service, "update_note", racing):
            saved = self.service.undo_agent_edit(edit["id"])
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.texts(note["id"]), ["First thought"])
        self.assertEqual(self.service.get_note(note["id"])["revision"], saved["revision"])

    def test_the_note_and_the_edits_state_change_together(self):
        note = self.canvas()
        result = self.cli("notes", "append", str(note["id"]), "--text", "From the agent")
        edit = self.edit_of(note["id"], result["revision"])
        with mock.patch.object(self.service, "record_change", side_effect=RuntimeError("disk")):
            with self.assertRaises(RuntimeError):
                self.service.undo_agent_edit(edit["id"])
        self.assertEqual(self.texts(note["id"]), ["First thought", "From the agent"])
        self.assertEqual(self.edit_of(note["id"], result["revision"])["state"], "applied")


if __name__ == "__main__":
    unittest.main()
