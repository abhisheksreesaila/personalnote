"""Reminders for due mind-map nodes (F-110): the derived list, the scheduler's firing, the missed notice, the jump.

A fake clock and a fake notifier stand in for the time and the system notification; everything else is the real service and app.
"""

import json
import io
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
import zipfile
from unittest import mock
from datetime import datetime
from pathlib import Path

from starlette.testclient import TestClient

from portability import import_workspace_backup, markdown_archive, workspace_backup
from reminders import Reminders, system_notify
from routes import create_app
from services import NoteService
from tests.test_secure_notes import FakeMac


class Clock:
    def __init__(self, text):
        self.now = datetime.fromisoformat(text)

    def __call__(self):
        return self.now

    def set(self, text):
        self.now = datetime.fromisoformat(text)


class Notices:
    def __init__(self):
        self.sent = []

    def __call__(self, title, body):
        self.sent.append((title, body))
        return True


def node(node_id, text, **extra):
    return {"id": node_id, "parentId": "root", "text": text, "x": 0, "y": 0, **extra}


class ReminderTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / "notes.db"
        self.service = NoteService(self.path)
        self.clock = Clock("2026-11-03T09:00")
        self.notices = Notices()
        self.reminders = Reminders(self.service, notify=self.notices, clock=self.clock)

    def tearDown(self):
        self.folder.cleanup()

    def save_map(self, nodes, title="Week plan", note=None):
        if note is None:
            note = self.service.create_note({"title": title, "noteType": "mindmap"})
        document = {"version": 1, "rootId": "root", "nodes": [{"id": "root", "parentId": None, "text": "Plan", "x": 0, "y": 0}, *nodes]}
        self.service.update_note(note["id"], {"title": title, "content": document, "revision": note["revision"]})
        return self.service.get_note(note["id"])

    def pending_rows(self):
        with self.service.connection() as connection:
            return [tuple(row) for row in connection.execute("SELECT note_id, node_id FROM mindmap_reminders WHERE done = 0")]

    def test_a_node_with_a_time_notifies_once_at_that_time(self):
        self.save_map([node("a", "Call the bank", due="2026-11-03T09:30")])
        self.reminders.tick()
        self.assertEqual(self.notices.sent, [])
        self.clock.set("2026-11-03T09:30")
        self.reminders.tick()
        self.reminders.tick()
        self.assertEqual(self.notices.sent, [("Personal Note", "Call the bank — in Week plan")])

    def test_a_date_without_a_time_gets_no_notification(self):
        self.save_map([node("a", "Pay rent", due="2026-11-03")])
        self.clock.set("2026-11-05T10:00")
        self.reminders.tick()
        self.assertEqual(self.notices.sent, [])
        self.assertEqual(self.pending_rows(), [])

    def test_striking_a_node_cancels_its_reminder(self):
        note = self.save_map([node("a", "Call", due="2026-11-03T09:30"), node("b", "Email", due="2026-11-03T09:40")])
        self.save_map([node("a", "Call", due="2026-11-03T09:30", done=True), node("b", "Email", due="2026-11-03T09:40")], note=note)
        self.clock.set("2026-11-03T09:35")
        self.reminders.tick()
        self.assertEqual(self.notices.sent, [])  # a was struck
        self.clock.set("2026-11-03T09:40")
        self.reminders.tick()
        self.assertEqual([body for _, body in self.notices.sent], ["Email — in Week plan"])

    def test_unstriking_a_reminder_that_already_fired_does_not_fire_it_again(self):
        note = self.save_map([node("a", "Call", due="2026-11-03T09:10")])
        self.clock.set("2026-11-03T09:10")
        self.reminders.tick()
        note = self.save_map([node("a", "Call", due="2026-11-03T09:10", done=True)], note=note)
        self.save_map([node("a", "Call", due="2026-11-03T09:10")], note=note)
        self.reminders.tick()
        self.assertEqual(len(self.notices.sent), 1)

    def test_removing_the_time_cancels_and_editing_it_rearms(self):
        note = self.save_map([node("a", "Call", due="2026-11-03T09:10")])
        self.clock.set("2026-11-03T09:10")
        self.reminders.tick()
        self.assertEqual(len(self.notices.sent), 1)
        note = self.save_map([node("a", "Call", due="2026-11-03T10:00")], note=note)
        self.reminders.tick()
        self.assertEqual(len(self.notices.sent), 1)  # not yet
        self.clock.set("2026-11-03T10:00")
        self.reminders.tick()
        self.assertEqual(len(self.notices.sent), 2)  # the new time fired
        self.save_map([node("a", "Call")], note=note)
        self.assertEqual(self.pending_rows(), [])

    def test_deleting_the_map_cancels_its_reminders(self):
        note = self.save_map([node("a", "Call", due="2026-11-03T09:10")])
        self.service.delete_note(note["id"])
        self.clock.set("2026-11-03T09:10")
        self.reminders.tick()
        self.assertEqual(self.notices.sent, [])

    def secure_service(self, name="secure.db"):
        return NoteService(Path(self.folder.name) / name, secure_platform=FakeMac(), scrypt_cost=2**4)

    def secure_map(self, service):
        note = service.create_note({"title": "Week plan", "noteType": "mindmap"})
        document = {"version": 1, "rootId": "root", "nodes": [{"id": "root", "parentId": None, "text": "Plan", "x": 0, "y": 0}, node("a", "Call", due="2026-11-03T09:10")]}
        service.update_note(note["id"], {"title": "Week plan", "content": document, "revision": note["revision"]})
        return note

    @staticmethod
    def rows(service):
        with service.connection() as connection:
            return [tuple(row) for row in connection.execute("SELECT note_id, node_id FROM mindmap_reminders")]

    def test_making_a_map_secure_drops_its_reminders_and_removing_secure_brings_them_back(self):
        service = self.secure_service()
        note = self.secure_map(service)
        self.assertEqual(self.rows(service), [(note["id"], "a")])
        service.mark_secure(note["id"])
        self.assertEqual(self.rows(service), [])
        service.unmark_secure(note["id"])
        self.assertEqual(self.rows(service), [(note["id"], "a")])

    def test_importing_a_secure_map_arms_nothing(self):
        service = self.secure_service()
        note = self.secure_map(service)
        service.mark_secure(note["id"])
        backup = json.loads(json.dumps(workspace_backup(service)))
        other = self.secure_service("other.db")
        self.assertEqual(import_workspace_backup(other, backup)["notesImported"], 1)
        self.assertEqual(self.rows(other), [])
        Reminders(other, notify=self.notices, clock=Clock("2026-11-03T09:10")).tick()
        self.assertEqual(self.notices.sent, [])

    def test_reminders_that_came_due_while_closed_make_one_missed_notice(self):
        self.save_map([node("a", "One", due="2026-11-02T08:00"), node("b", "Two", due="2026-11-02T18:00"), node("c", "Later", due="2026-11-03T12:00")])
        self.reminders.catch_up()
        self.assertEqual(self.notices.sent, [("Personal Note", "You missed 2 reminders")])
        self.reminders.catch_up()
        self.reminders.tick()
        self.assertEqual(len(self.notices.sent), 1)  # fired once; the later one is not yet due
        self.clock.set("2026-11-03T12:00")
        self.reminders.tick()
        self.assertEqual(self.notices.sent[-1], ("Personal Note", "Later — in Week plan"))

    def test_one_missed_reminder_is_singular(self):
        self.save_map([node("a", "One", due="2026-11-02T08:00")])
        self.reminders.catch_up()
        self.assertEqual(self.notices.sent, [("Personal Note", "You missed 1 reminder")])

    def test_startup_backfills_maps_saved_before_the_table_existed(self):
        self.save_map([node("a", "Call", due="2026-11-03T09:10")])
        with sqlite3.connect(self.path) as connection:
            connection.execute("DELETE FROM mindmap_reminders")
        NoteService(self.path)  # a fresh start
        self.clock.set("2026-11-03T09:10")
        self.reminders.tick()
        self.assertEqual(self.notices.sent, [("Personal Note", "Call — in Week plan")])

    def test_a_backup_and_the_markdown_export_carry_no_reminder_data(self):
        """The same map with and without a due time: the backup has the same keys everywhere, and no reminder text is in either file."""
        def shape(value):
            if isinstance(value, dict):
                return {key: shape(item) for key, item in value.items() if key not in ("content", "exportedAt", "workspaceId")}
            return [shape(item) for item in value] if isinstance(value, list) else type(value).__name__

        self.save_map([node("a", "Call the bank", due="2026-11-03T09:10")])
        with tempfile.TemporaryDirectory() as other_folder:
            plain = NoteService(Path(other_folder) / "plain.db")
            note = plain.create_note({"title": "Week plan", "noteType": "mindmap"})
            document = {"version": 1, "rootId": "root", "nodes": [{"id": "root", "parentId": None, "text": "Plan", "x": 0, "y": 0}, node("a", "Call the bank")]}
            plain.update_note(note["id"], {"title": "Week plan", "content": document, "revision": note["revision"]})
            self.assertEqual(shape(self.service.workspace_snapshot()), shape(plain.workspace_snapshot()))
            self.assertEqual(shape(workspace_backup(self.service)), shape(workspace_backup(plain)))
        archive = zipfile.ZipFile(io.BytesIO(markdown_archive(self.service)))
        texts = [json.dumps(workspace_backup(self.service)), *(archive.read(name).decode("utf-8") for name in archive.namelist())]
        for text in texts:
            for word in ("mindmap_reminders", "reminder", "fired"):
                self.assertNotIn(word, text.lower())

    def test_a_notice_that_was_not_shown_stays_armed_and_is_sent_on_the_next_poll(self):
        self.save_map([node("a", "Call", due="2026-11-03T09:10")])
        self.clock.set("2026-11-03T09:10")
        shown = []
        results = iter([False, True])
        self.reminders.notify = lambda title, body: shown.append(body) or next(results)
        with self.assertLogs("personal-note.reminders", level="WARNING") as logs:
            self.reminders.tick()
        self.assertIn("outcome=not_shown", logs.output[0])
        self.reminders.tick()
        self.reminders.tick()
        self.assertEqual(shown, ["Call — in Week plan", "Call — in Week plan"])

    def test_the_missed_notice_jumps_to_the_earliest_missed_reminder(self):
        note = self.save_map([node("a", "One", due="2026-11-02T08:00"), node("b", "Two", due="2026-11-02T18:00")])
        self.reminders.catch_up()
        self.assertEqual(self.reminders.take_jump(), {"noteId": note["id"], "nodeId": "a"})

    def test_importing_a_backup_arms_its_maps(self):
        self.save_map([node("a", "Call", due="2026-11-03T09:10")])
        snapshot = self.service.workspace_snapshot()
        with tempfile.TemporaryDirectory() as folder:
            other = NoteService(Path(folder) / "other.db")
            other.import_workspace_snapshot(snapshot)
            notices = Notices()
            clock = Clock("2026-11-03T09:10")
            Reminders(other, notify=notices, clock=clock).tick()
            self.assertEqual(notices.sent, [("Personal Note", "Call — in Week plan")])


class ReminderApiTests(unittest.TestCase):
    def test_the_jump_endpoint_hands_out_a_clicked_notice_once(self):
        with tempfile.TemporaryDirectory() as folder:
            app = create_app(Path(folder) / "notes.db")
            client = TestClient(app)
            clock = Clock("2026-11-03T09:00")
            app.state.reminders = Reminders(app.state.note_service, notify=Notices(), clock=clock)
            note = client.post("/api/notes", json={"title": "Week plan", "noteType": "mindmap"}).json()
            document = note["content"]
            document["nodes"].append(node("a", "Call", due="2026-11-03T09:10"))
            client.put(f"/api/notes/{note['id']}", json={"title": "Week plan", "revision": note["revision"], "content": document})
            self.assertEqual(client.get("/api/reminders/jump").json(), {"jump": None})
            clock.set("2026-11-03T09:10")
            app.state.reminders.tick()
            app.state.reminders.clicked()
            self.assertEqual(client.get("/api/reminders/jump").json(), {"jump": {"noteId": note["id"], "nodeId": "a"}})
            self.assertEqual(client.get("/api/reminders/jump").json(), {"jump": None})


class SystemNotifyTests(unittest.TestCase):
    def test_linux_uses_notify_send_and_macos_uses_osascript(self):
        calls = []
        run = lambda command, **kw: calls.append(command)
        self.assertTrue(system_notify("Personal Note", "Call — in Plan", platform="linux", which=lambda n: "/bin/" + n, run=run))
        self.assertEqual(calls[-1][0], "/bin/notify-send")
        self.assertEqual(calls[-1][-2:], ["Personal Note", "Call — in Plan"])
        self.assertTrue(system_notify("Personal Note", 'Say "hi" \\ now', platform="darwin", which=lambda n: "/usr/bin/" + n, run=run))
        self.assertEqual(calls[-1][:2], ["/usr/bin/osascript", "-e"])
        self.assertEqual(calls[-1][2], 'display notification "Say \\"hi\\" \\\\ now" with title "Personal Note"')
        self.assertFalse(system_notify("a", "b", platform="linux", which=lambda n: None, run=run))

    def test_notify_send_shows_markup_in_a_label_as_text(self):
        calls = []
        system_notify("Personal Note", "<b>Call</b> & <i>pay — in Plan <u>", platform="linux", which=lambda n: "/bin/" + n, run=lambda c, **kw: calls.append(c))
        self.assertEqual(calls[-1][-1], "&lt;b&gt;Call&lt;/b&gt; &amp; &lt;i&gt;pay — in Plan &lt;u&gt;")

    def test_windows_passes_the_text_by_environment_to_powershell(self):
        seen = []
        run = lambda command, **kw: seen.append((command, kw["env"]["PN_TITLE"], kw["env"]["PN_BODY"]))
        self.assertTrue(system_notify("Personal Note", "Call'; rm x", platform="win32", which=lambda n: "C:/ps.exe", run=run))
        self.assertEqual(seen[0][0][:4], ["C:/ps.exe", "-NoProfile", "-NonInteractive", "-Command"])
        self.assertEqual(seen[0][1:], ("Personal Note", "Call'; rm x"))

    def test_a_click_wait_that_times_out_still_counts_as_shown(self):
        def run(command, **kw):
            raise subprocess.TimeoutExpired(command, 1)
        self.assertTrue(system_notify("t", "b", on_click=lambda: None, platform="linux", which=lambda n: "/bin/n", run=run))


class WaiterLimitTests(unittest.TestCase):
    def test_only_a_few_notices_wait_for_a_click_the_rest_are_shown_plainly(self):
        import reminders
        with tempfile.TemporaryDirectory() as folder:
            service = NoteService(Path(folder) / "notes.db")
            note = service.create_note({"title": "Plan", "noteType": "mindmap"})
            nodes = [{"id": "root", "parentId": None, "text": "Plan", "x": 0, "y": 0}] + [node(f"n{i}", f"Task {i}", due="2026-11-03T09:00") for i in range(7)]
            service.update_note(note["id"], {"title": "Plan", "content": {"version": 1, "rootId": "root", "nodes": nodes}, "revision": note["revision"]})
            release, waiting, plain, lock = threading.Event(), [], [], threading.Lock()

            def fake(title, body, on_click=None, **kw):
                with lock:
                    (waiting if on_click else plain).append(body)
                if on_click:
                    release.wait(5)
                return True

            watcher = Reminders(service, clock=Clock("2026-11-03T09:00"))
            watcher.click_aware = True
            with mock.patch.object(reminders, "system_notify", fake):
                self.assertEqual(watcher.tick(), 7)
                time.sleep(0.3)
                self.assertEqual((len(waiting), len(plain)), (reminders.MAX_WAITERS, 3))
                self.assertEqual(watcher.tick(), 0)  # the waiting ones are in flight, the rest were fired
                release.set()
                time.sleep(0.3)
            self.assertEqual(service.reminders_due("2026-11-03T09:00"), [])


if __name__ == "__main__":
    unittest.main()
