"""X bookmarks in the app (F-088): the sync files bookmarks as notes, against the fake X from test_x_bookmarks."""

import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from starlette.testclient import TestClient

import x_bookmarks
from routes import create_app
from secret_store import SecretStore, SecretStoreError
from services import NoteService
from tests.test_x_bookmarks import CLIENT_ID, FakeX, free_port, make_posts
from x_bookmarks import XError
from x_sync import XSync


def follow(url):
    """The captain's browser: opens the authorize URL, which redirects to the loopback callback."""
    def go():
        try:
            urllib.request.urlopen(url, timeout=10).close()
        except (urllib.error.URLError, OSError):
            pass

    threading.Thread(target=go, daemon=True).start()


class BrokenDelete:
    """A keychain that reads fine but refuses to delete."""

    def __init__(self, real):
        self.load = real.load

    def delete(self):
        raise SecretStoreError("keychain delete failed (-1)")


class XSyncCase(unittest.TestCase):
    posts = 5

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.x = FakeX(make_posts(self.posts))
        self.addCleanup(self.x.stop)
        self.service = NoteService(self.folder / "notes.db")
        self.sync = self.make_sync()
        self.addCleanup(self.sync.stop)

    def make_sync(self, **options):
        return XSync(
            self.service,
            token_store=x_bookmarks.default_token_store("linux", self.folder),
            client_id_secret=SecretStore("id", "x-client-id", platform="linux", folder=self.folder),
            open_browser=follow,
            client_options={"authorize_url": f"{self.x.base}/authorize", "api_base": f"{self.x.base}/2", "callback_port": free_port()},
            **options,
        )

    def connect(self):
        self.sync.set_client_id(CLIENT_ID)
        self.sync.connect()
        deadline = time.monotonic() + 15
        while self.sync.connecting and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertFalse(self.sync.connecting)

    def x_notebook(self):
        found = [n for n in self.service.list_notebooks() if n["icon"] == "brand:x"]
        self.assertEqual(len(found), 1)
        return found[0]

    def x_notes(self):
        notebook = self.x_notebook()["id"]
        return [n for n in self.service.list_notes() if n["notebookId"] == notebook]


class FirstSyncTests(XSyncCase):
    def test_connecting_makes_the_notebook_and_a_page_note_per_bookmark(self):
        self.connect()
        notebook = self.x_notebook()
        self.assertEqual((notebook["name"], notebook["noteCount"]), ("X bookmarks", 5))
        notes = self.x_notes()
        self.assertEqual([n["title"] for n in notes], [f"@ada: post {i}" for i in (5, 4, 3, 2, 1)])
        self.assertEqual({n["noteType"] for n in notes}, {"page"})
        self.assertEqual(self.sync.status()["imported"], 5)
        self.assertEqual(self.sync.error, "")

    def test_a_note_holds_the_text_author_date_and_links_and_the_picture_stays_a_link(self):
        self.connect()
        post3 = next(n for n in self.x_notes() if n["title"] == "@ada: post 3")
        markdown = self.service.get_note(post3["id"])["content"]["markdown"]
        self.assertEqual(
            markdown,
            "post 3\n\nAda Lovelace [@ada](https://x.com/ada) · 2026-01-01\n\n[Open on X](https://x.com/ada/status/1003)\n\n[Picture](https://pbs.example/m3.jpg)\n",
        )
        post2 = next(n for n in self.x_notes() if n["title"] == "@ada: post 2")
        self.assertNotIn("Picture", self.service.get_note(post2["id"])["content"]["markdown"])

    def test_the_title_is_the_first_words_with_an_ellipsis(self):
        title, _ = x_bookmarks.x_post_note({"id": "1", "url": "https://x.com/ada/status/1", "author_handle": "ada", "text": "word " * 40})
        self.assertEqual(title, "@ada: " + "word " * 11 + "word…")

    def test_bookmarks_are_found_by_search(self):
        self.connect()
        self.assertEqual([hit["title"] for hit in self.service.search("post 4")], ["@ada: post 4"])

    def test_an_odd_handle_or_a_plain_http_picture_makes_no_link(self):
        _, markdown = x_bookmarks.x_post_note({"id": "1", "url": "https://x.com/i/status/1", "author_handle": "a](javascript:x)", "author_name": "A", "text": "t", "image_url": "http://x/p.jpg"})
        self.assertNotIn("javascript", markdown)
        self.assertNotIn("Picture", markdown)


class LaterSyncTests(XSyncCase):
    def add_post(self, n):
        self.x.posts.insert(0, {"id": str(1000 + n), "text": f"post {n}", "author_id": "u1", "created_at": "2026-02-01T00:00:00.000Z"})

    def test_the_second_sync_imports_only_the_new_ones_on_top(self):
        self.connect()
        self.add_post(6)
        self.add_post(7)
        self.assertTrue(self.sync.sync())
        self.assertEqual([n["title"] for n in self.x_notes()][:3], ["@ada: post 7", "@ada: post 6", "@ada: post 5"])
        self.assertEqual(len(self.x_notes()), 7)

    def test_nothing_new_changes_nothing(self):
        self.connect()
        before = self.service.workspace_sequence()
        self.sync.sync()
        self.assertEqual(self.service.workspace_sequence(), before)

    def test_moved_archived_and_deleted_notes_are_never_imported_again(self):
        self.connect()
        notes = {n["title"]: n for n in self.x_notes()}
        other = self.service.create_notebook({"name": "Reading"})
        archive = self.service.create_notebook({"name": "Done", "category": "archive"})
        self.service.move_note(notes["@ada: post 5"]["id"], {"notebookId": other["id"]})
        self.service.move_note(notes["@ada: post 4"]["id"], {"notebookId": archive["id"]})
        self.service.delete_note(notes["@ada: post 3"]["id"])
        self.add_post(6)
        self.sync.sync()
        titles = sorted(n["title"] for n in self.service.list_notes())
        self.assertEqual(titles, sorted(f"@ada: post {i}" for i in (1, 2, 4, 5, 6)))
        self.assertEqual(self.sync.status()["imported"], 6)

    def test_a_newest_bookmark_removed_on_x_does_not_make_it_import_everything_again(self):
        self.connect()
        self.x.posts.pop(0)  # post 5 un-bookmarked on X
        self.add_post(6)
        self.sync.sync()
        self.assertEqual(len(self.x_notes()), 6)
        self.assertEqual(sorted(n["title"] for n in self.x_notes()), sorted(f"@ada: post {i}" for i in (1, 2, 3, 4, 5, 6)))

    def test_a_renamed_and_recoloured_notebook_is_still_the_one_used(self):
        self.connect()
        notebook = self.x_notebook()
        self.service.update_notebook(notebook["id"], {"name": "Saved posts", "color": "#112233", "revision": notebook["revision"]})
        self.add_post(6)
        self.sync.sync()
        books = self.service.list_notebooks()
        self.assertEqual(sorted((b["name"], b["noteCount"]) for b in books), [("My Notes", 0), ("Saved posts", 6)])

    def test_a_deleted_notebook_is_made_again_for_new_bookmarks_only(self):
        self.connect()
        self.service.delete_notebook(self.x_notebook()["id"])
        self.add_post(6)
        self.sync.sync()
        self.assertEqual([n["title"] for n in self.x_notes()], ["@ada: post 6"])

    def test_other_notes_are_left_alone(self):
        mine = self.service.create_note({"title": "Mine", "noteType": "page"})
        self.connect()
        again = self.service.get_note(mine["id"])
        self.assertEqual((again["revision"], again["notebookId"], again["title"]), (mine["revision"], None, "Mine"))


class SecureNotesTests(XSyncCase):
    def test_a_secure_note_is_not_touched_by_a_sync(self):
        from tests.test_secure_notes import FakeMac

        service = NoteService(self.folder / "secure.db", secure_platform=FakeMac(), scrypt_cost=2**4)
        self.service = self.sync.service = service
        note = service.create_note({"title": "Cards", "noteType": "page"})
        content = {"markdown": "my card is quokkaphrase", "ink": {"marks": [], "drawings": []}}
        service.update_note(note["id"], {"title": "Cards", "content": content, "revision": note["revision"]})
        service.mark_secure(note["id"])
        with service.connection() as connection:
            before = tuple(connection.execute("SELECT revision, sealed, content, secure, notebook_id, updated_at FROM notes WHERE id = ?", (note["id"],)).fetchone())
        self.connect()
        with service.connection() as connection:
            after = tuple(connection.execute("SELECT revision, sealed, content, secure, notebook_id, updated_at FROM notes WHERE id = ?", (note["id"],)).fetchone())
        self.assertEqual(after, before)
        self.assertEqual(len(self.x_notes()), 5)


class ErrorTests(XSyncCase):
    def test_no_credit_is_recorded_not_raised_and_clears_on_the_next_good_sync(self):
        self.connect()
        self.x.fail_next = (402, {})
        self.assertTrue(self.sync.sync())
        status = self.sync.status()
        self.assertEqual(status["errorKind"], "no_credits")
        self.assertIn("no API credit", status["error"])
        self.assertTrue(status["connected"])
        self.sync.sync()
        self.assertEqual(self.sync.status()["error"], "")

    def test_rate_limited_names_the_wait(self):
        self.connect()
        self.x.fail_next = (429, {"x-rate-limit-reset": str(int(time.time()) + 600)})
        self.sync.sync()
        self.assertEqual(self.sync.status()["errorKind"], "rate_limited")

    def test_not_connected_says_so_and_files_nothing(self):
        self.sync.sync()
        self.assertEqual(self.sync.status()["error"], "X is not connected. Connect X in Settings.")
        self.assertEqual([b["name"] for b in self.service.list_notebooks()], ["My Notes"])

    def test_a_crash_in_filing_is_recorded_and_the_next_sync_works(self):
        self.connect()
        real = self.service.import_x_bookmarks
        self.service.import_x_bookmarks = lambda posts: (_ for _ in ()).throw(RuntimeError("disk"))
        self.sync.sync()
        self.assertEqual(self.sync.status()["errorKind"], "other")
        self.service.import_x_bookmarks = real
        self.sync.sync()
        self.assertEqual(self.sync.status()["error"], "")

    def test_connect_without_a_client_id_asks_for_it(self):
        with self.assertRaises(XError) as caught:
            self.sync.connect()
        self.assertIn("client id", str(caught.exception))

    def test_a_bad_client_id_is_refused(self):
        with self.assertRaises(XError):
            self.sync.set_client_id("no spaces allowed")

    def test_the_sign_in_denied_is_shown(self):
        self.x.tamper_state = True  # the callback carries a wrong state: ignored, so the wait times out; use a short one
        self.sync.set_client_id(CLIENT_ID)
        self.sync.client_options["callback_port"] = free_port()
        original = x_bookmarks.XClient.sign_in
        x_bookmarks.XClient.sign_in = lambda self, open_browser, timeout=300: original(self, open_browser, timeout=1)
        self.addCleanup(setattr, x_bookmarks.XClient, "sign_in", original)
        self.sync.connect()
        while self.sync.connecting:
            time.sleep(0.02)
        self.assertEqual(self.sync.status()["error"], "X sign-in timed out. Try Connect X again.")
        self.assertFalse(self.sync.status()["connected"])


class OneAtATimeTests(XSyncCase):
    def test_a_second_sync_while_one_runs_does_nothing_and_nothing_is_doubled(self):
        self.connect()
        self.x.posts.insert(0, {"id": "2000", "text": "new", "author_id": "u1", "created_at": "2026-02-01T00:00:00.000Z"})
        inside, release = threading.Event(), threading.Event()
        real = self.service.x_known_ids

        def slow(limit=20):
            inside.set()
            release.wait(10)
            return real(limit)

        self.service.x_known_ids = slow
        results = []
        first = threading.Thread(target=lambda: results.append(self.sync.sync()))
        first.start()
        self.assertTrue(inside.wait(10))
        self.assertTrue(self.sync.status()["syncing"])
        self.assertFalse(self.sync.sync())  # refused at once, X is not called twice
        release.set()
        first.join(10)
        self.assertEqual(results, [True])
        self.assertEqual(len(self.x_notes()), 6)

    def test_connect_is_refused_while_a_sync_runs(self):
        self.connect()
        inside, release = threading.Event(), threading.Event()
        real = self.service.x_known_ids
        self.service.x_known_ids = lambda limit=20: (inside.set(), release.wait(10), real(limit))[2]
        first = threading.Thread(target=self.sync.sync)
        first.start()
        self.assertTrue(inside.wait(10))
        with self.assertRaises(XError):
            self.sync.connect()
        release.set()
        first.join(10)


class ThreadTests(XSyncCase):
    def test_it_syncs_on_start_and_again_each_interval_then_stops_cleanly(self):
        self.connect()
        self.sync.stop()
        sync = self.make_sync(interval=0.2, first_delay=0.05)
        self.x.posts.insert(0, {"id": "2000", "text": "later", "author_id": "u1", "created_at": "2026-02-01T00:00:00.000Z"})
        sync.start()
        self.wait_for(lambda: len(self.x_notes()) == 6)
        self.x.posts.insert(0, {"id": "2001", "text": "later still", "author_id": "u1", "created_at": "2026-02-01T00:00:00.000Z"})
        self.wait_for(lambda: len(self.x_notes()) == 7)
        sync.stop()
        self.assertFalse(sync._thread.is_alive())

    def test_a_disconnected_app_never_calls_x(self):
        sync = self.make_sync(interval=0.1, first_delay=0.05)
        sync.start()
        time.sleep(0.4)
        sync.stop()
        self.assertEqual(self.x.bookmark_calls, [])
        self.assertEqual(self.x.token_calls, [])

    def wait_for(self, check, seconds=10):
        deadline = time.monotonic() + seconds
        while not check() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(check())


class DisconnectTests(XSyncCase):
    def test_disconnect_forgets_the_sign_in_and_keeps_the_notes(self):
        self.connect()
        self.sync.disconnect()
        self.assertFalse(self.sync.status()["connected"])
        self.assertEqual(len(self.x_notes()), 5)

    def test_a_keychain_that_refuses_is_a_plain_message_not_a_crash(self):
        self.connect()

        self.sync.tokens.secret = BrokenDelete(self.sync.tokens.secret)
        with self.assertRaises(XError) as caught:
            self.sync.disconnect()
        self.assertEqual(str(caught.exception), "The X sign-in could not be removed from this computer.")


class BackupTests(XSyncCase):
    def test_the_notes_travel_in_a_backup_as_normal_notes(self):
        self.connect()
        snapshot = self.service.workspace_snapshot()
        self.assertEqual(sorted(n["name"] for n in snapshot["notebooks"]), ["My Notes", "X bookmarks"])
        self.assertEqual(next(n for n in snapshot["notebooks"] if n["name"] == "X bookmarks")["icon"], "brand:x")
        self.assertEqual(len([n for n in snapshot["notes"] if n["noteType"] == "page"]), 5)
        self.assertFalse(any("x_post" in key for note in snapshot["notes"] for key in note))
        fresh = NoteService(self.folder / "fresh.db")
        fresh.import_workspace_snapshot(snapshot)
        self.assertEqual(sorted(n["title"] for n in fresh.list_notes()), sorted(f"@ada: post {i}" for i in range(1, 6)))


class RouteTests(XSyncCase):
    def setUp(self):
        super().setUp()
        self.app = create_app(self.folder / "app.db", x_sync=self.sync)
        self.http = TestClient(self.app)
        self.addCleanup(self.app.state.search.shutdown)
        self.addCleanup(self.app.state.indexer.stop)

    def test_status_before_anything(self):
        body = self.http.get("/api/x/status").json()
        self.assertEqual(body, {"clientId": "", "connected": False, "connecting": False, "syncing": False, "lastSync": None, "imported": 0, "error": "", "errorKind": ""})

    def test_changes_need_the_apps_own_header(self):
        for call in (lambda h: self.http.post("/api/x/sync", headers=h), lambda h: self.http.post("/api/x/connect", headers=h),
                     lambda h: self.http.delete("/api/x", headers=h), lambda h: self.http.post("/api/x/client-id", json={"clientId": CLIENT_ID}, headers=h)):
            self.assertEqual(call({}).status_code, 403)

    def test_client_id_then_connect_then_sync_now_through_the_api(self):
        header = {"x-personal-note": "1"}
        self.assertEqual(self.http.post("/api/x/client-id", json={"clientId": "bad id"}, headers=header).status_code, 409)
        self.assertEqual(self.http.post("/api/x/client-id", json={"clientId": CLIENT_ID}, headers=header).json()["clientId"], CLIENT_ID)
        self.assertEqual(self.http.post("/api/x/connect", headers=header).status_code, 200)
        deadline = time.monotonic() + 15
        while self.http.get("/api/x/status").json()["connecting"] and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.http.get("/api/x/status").json()["imported"], 5)
        self.x.posts.insert(0, {"id": "2000", "text": "fresh", "author_id": "u1", "created_at": "2026-02-01T00:00:00.000Z"})
        self.assertEqual(self.http.post("/api/x/sync", headers=header).json()["imported"], 6)
        self.assertEqual(self.http.delete("/api/x", headers=header).json()["connected"], False)

    def test_a_failed_disconnect_is_a_409_with_a_message(self):
        self.sync.tokens.secret = BrokenDelete(self.sync.tokens.secret)
        response = self.http.delete("/api/x", headers={"x-personal-note": "1"})
        self.assertEqual((response.status_code, response.json()["error"]), (409, "The X sign-in could not be removed from this computer."))

    def test_a_test_app_does_not_start_the_sync_thread(self):
        self.assertIsNone(self.app.state.x_sync._thread)


if __name__ == "__main__":
    unittest.main()
