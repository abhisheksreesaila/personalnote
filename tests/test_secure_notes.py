import contextlib
import io
import json
import os
import shutil
import tempfile
import time
import threading
import unittest
import zipfile
from unittest import mock
from pathlib import Path

from starlette.testclient import TestClient

import secure_platform
from personal_note_cli import main as cli_main
from portability import import_workspace_backup, markdown_archive, workspace_backup
from routes import create_app
from services import (
    NoteService,
    SecureAuthError,
    SecureLockedError,
    SecureNoteAgentError,
    SecureSetupError,
    WorkspaceImportError,
)
from vault import export_vault_archive

SECRET = "ZEBRA-CARD-4111-1111-1111-1111 quokkaphrase"
PASSPHRASE = "correct horse battery"


class FakeMac:
    """The secure_platform seam on a Mac: Touch ID answers yes or no, and the keychain key is only given after a yes."""

    def __init__(self, approve=True):
        self.approve = approve
        self.prompts = 0
        self.key = os.urandom(32)
        self._authenticated = False

    def available(self, platform=None):
        return True

    def backend(self, platform=None):
        return "touchid"

    def authenticate(self, reason, timeout=0):
        self.prompts += 1
        self._authenticated = self.approve
        return self.approve

    def key_get_or_create(self, security=None):
        if not self._authenticated:
            raise secure_platform.NotAuthenticated("Touch ID is needed first")
        return self.key


class FakeLinux:
    def available(self, platform=None):
        return False

    def backend(self, platform=None):
        return "passphrase"

    def authenticate(self, reason, timeout=0):
        raise secure_platform.Unavailable("passphrase")

    def key_get_or_create(self, security=None):
        raise secure_platform.Unavailable("passphrase")


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class SecureCase(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.database_path = self.root / "personal-note.db"
        self.mac = FakeMac()
        self.service = self.make_service(self.database_path, self.mac)

    def tearDown(self):
        self.temporary_directory.cleanup()

    @staticmethod
    def make_service(path, platform):
        return NoteService(path, secure_platform=platform, scrypt_cost=2**4)

    def page_note(self, service=None, title="Cards", markdown=None):
        service = service or self.service
        note = service.create_note({"title": title, "noteType": "page"})
        content = {"markdown": markdown or f"my card is {SECRET}", "ink": {"marks": [], "drawings": []}}
        service.update_note(note["id"], {"title": title, "content": content, "revision": note["revision"]})
        return service.get_note(note["id"])

    def assert_no_words_on_disk(self, path=None):
        """Neither the text nor the lower-cased words the search index would keep are anywhere in the file or its log."""
        data = self.disk_bytes(path).lower()
        for needle in (b"quokkaphrase", b"4111-1111", b"second secret", b"zebra-second"):
            self.assertNotIn(needle, data)

    def disk_bytes(self, path=None):
        path = Path(path or self.database_path)
        blobs = [path.read_bytes()]
        for suffix in ("-wal", "-shm"):
            extra = Path(str(path) + suffix)
            if extra.exists():
                blobs.append(extra.read_bytes())
        return b"".join(blobs)


class MarkingSecureTests(SecureCase):
    def test_first_secure_note_returns_a_recovery_key_once(self):
        note = self.page_note()
        result = self.service.mark_secure(note["id"])
        groups = result["recoveryKey"].split("-")
        self.assertGreaterEqual(len(groups), 6)
        self.assertTrue(all(len(group) == 4 for group in groups))
        self.assertEqual(self.mac.prompts, 1)
        second = self.service.mark_secure(self.page_note(title="More")["id"])
        self.assertNotIn("recoveryKey", second)

    def test_the_note_stays_readable_while_unlocked_and_flags_itself(self):
        note = self.page_note()
        self.service.mark_secure(note["id"])
        opened = self.service.get_note(note["id"])
        self.assertTrue(opened["secure"])
        self.assertFalse(opened["locked"])
        self.assertEqual(opened["content"]["markdown"], f"my card is {SECRET}")
        self.assertEqual(opened["title"], "Cards")
        self.assertFalse(self.page_note(title="Plain")["secure"])

    def test_marking_bumps_the_revision_and_honours_a_stale_one(self):
        note = self.page_note()
        with self.assertRaises(Exception) as caught:
            self.service.mark_secure(note["id"], revision=note["revision"] - 1)
        self.assertEqual(type(caught.exception).__name__, "ConflictError")
        self.service.mark_secure(note["id"], revision=note["revision"])
        self.assertEqual(self.service.get_note(note["id"])["revision"], note["revision"] + 1)

    def test_a_declined_touch_id_marks_nothing(self):
        self.mac.approve = False
        note = self.page_note()
        with self.assertRaises(SecureAuthError):
            self.service.mark_secure(note["id"])
        self.assertFalse(self.service.get_note(note["id"])["secure"])

    def test_marking_needs_the_secure_notes_unlocked_when_keys_exist(self):
        first = self.page_note()
        self.service.mark_secure(first["id"])
        self.service.lock_secure()
        with self.assertRaises(SecureLockedError):
            self.service.mark_secure(self.page_note(title="Later")["id"])

    def test_a_canvas_note_can_be_secure_too(self):
        note = self.service.create_note({"title": "Board"})
        self.service.append_text(note["id"], SECRET)
        self.service.mark_secure(note["id"])
        self.assertIn(SECRET, json.dumps(self.service.get_note(note["id"])["content"]))
        self.service.lock_secure()
        self.assert_no_words_on_disk()
        self.service.unlock_secure()
        self.assertIn(SECRET, json.dumps(self.service.get_note(note["id"])["content"]))

    def test_marking_a_mind_map_secure_hides_its_nodes(self):
        note = self.service.create_note({"title": "Map", "noteType": "mindmap"})
        document = {"version": 1, "title": "m", "rootId": "root", "nodes": [{"id": "root", "parentId": None, "text": SECRET, "x": 0, "y": 0}]}
        self.service.update_note(note["id"], {"title": "Map", "content": document, "revision": note["revision"]})
        self.service.mark_secure(note["id"])
        self.assertEqual(self.service.search("ZEBRA"), [])
        self.assert_no_words_on_disk()


class LockedTests(SecureCase):
    def setUp(self):
        super().setUp()
        self.note = self.page_note()
        self.service.mark_secure(self.note["id"])
        self.service.lock_secure()

    def test_a_locked_note_shows_no_words_but_keeps_its_title(self):
        locked = self.service.get_note(self.note["id"])
        self.assertTrue(locked["secure"])
        self.assertTrue(locked["locked"])
        self.assertIsNone(locked["content"])
        self.assertEqual(locked["title"], "Cards")
        listed = {item["id"]: item for item in self.service.list_notes()}
        self.assertTrue(listed[self.note["id"]]["secure"])
        self.assertNotIn(SECRET, json.dumps(locked))

    def test_writes_to_a_locked_note_are_refused(self):
        with self.assertRaises(SecureLockedError) as caught:
            self.service.update_note(self.note["id"], {"title": "x", "content": {"markdown": "overwrite"}})
        self.assertIn("locked", str(caught.exception).lower())

    def test_moving_or_deleting_a_locked_note_still_works(self):
        notebook = self.service.create_notebook({"name": "Vault"})
        self.service.move_note(self.note["id"], {"notebookId": notebook["id"]})
        self.service.delete_note(self.note["id"])

    def test_touch_id_unlocks_and_the_words_come_back(self):
        status = self.service.unlock_secure()
        self.assertTrue(status["unlocked"])
        self.assertEqual(self.service.get_note(self.note["id"])["content"]["markdown"], f"my card is {SECRET}")

    def test_a_declined_touch_id_leaves_it_locked(self):
        self.mac.approve = False
        with self.assertRaises(SecureAuthError):
            self.service.unlock_secure()
        self.assertTrue(self.service.get_note(self.note["id"])["locked"])

    def test_the_keychain_key_is_never_asked_for_without_a_yes(self):
        calls = []
        original = self.mac.key_get_or_create
        self.mac.key_get_or_create = lambda security=None: calls.append(1) or original()
        self.mac.approve = False
        with self.assertRaises(SecureAuthError):
            self.service.unlock_secure()
        self.assertEqual(calls, [])

    def test_edits_while_unlocked_are_saved_and_survive_a_lock(self):
        self.service.unlock_secure()
        opened = self.service.get_note(self.note["id"])
        content = {"markdown": "new words ZEBRA-TWO", "ink": {"marks": [], "drawings": []}}
        self.service.update_note(self.note["id"], {"title": "Cards 2", "content": content, "revision": opened["revision"]})
        self.service.lock_secure()
        self.assertEqual(self.service.get_note(self.note["id"])["title"], "Cards 2")
        self.service.unlock_secure()
        self.assertEqual(self.service.get_note(self.note["id"])["content"]["markdown"], "new words ZEBRA-TWO")

    def test_a_stale_revision_still_conflicts_on_a_secure_note(self):
        self.service.unlock_secure()
        opened = self.service.get_note(self.note["id"])
        with self.assertRaises(Exception) as caught:
            self.service.update_note(self.note["id"], {"title": "x", "content": opened["content"], "revision": opened["revision"] - 1})
        self.assertEqual(type(caught.exception).__name__, "ConflictError")


class AutoLockHookTests(SecureCase):
    def test_the_keys_forget_themselves_after_the_idle_time(self):
        clock = Clock()
        service = NoteService(self.root / "clock.db", secure_platform=self.mac, scrypt_cost=2**4, clock=clock)
        note = self.page_note(service)
        service.mark_secure(note["id"])
        service.keyring.set_idle_timeout(300)
        clock.now += 299
        self.assertFalse(service.get_note(note["id"])["locked"])  # reading counts as use and renews the time
        clock.now += 299
        self.assertFalse(service.get_note(note["id"])["locked"])
        clock.now += 301
        self.assertTrue(service.get_note(note["id"])["locked"])
        self.assertFalse(service.secure_status()["unlocked"])


class PassphraseTests(SecureCase):
    def setUp(self):
        super().setUp()
        self.linux = FakeLinux()
        self.path = self.root / "linux.db"
        self.service = self.make_service(self.path, self.linux)

    def test_linux_needs_a_passphrase_to_make_the_first_secure_note(self):
        note = self.page_note()
        with self.assertRaises(SecureSetupError):
            self.service.mark_secure(note["id"])
        with self.assertRaises(SecureSetupError):
            self.service.mark_secure(note["id"], passphrase="short")
        self.assertEqual(self.service.secure_status()["backend"], "passphrase")
        self.assertFalse(self.service.secure_status()["configured"])

    def test_the_passphrase_unlocks_and_a_wrong_one_does_not(self):
        note = self.page_note()
        result = self.service.mark_secure(note["id"], passphrase=PASSPHRASE)
        self.assertIn("recoveryKey", result)
        self.service.lock_secure()
        with self.assertRaises(SecureAuthError):
            self.service.unlock_secure(passphrase="wrong wrong wrong")
        with self.assertRaises(SecureSetupError):
            self.service.unlock_secure()
        self.service.unlock_secure(passphrase=PASSPHRASE)
        self.assertEqual(self.service.get_note(note["id"])["content"]["markdown"], f"my card is {SECRET}")

    def test_the_wrapped_keys_never_hold_the_passphrase_or_the_data_key(self):
        note = self.page_note()
        self.service.mark_secure(note["id"], passphrase=PASSPHRASE)
        self.assertNotIn(PASSPHRASE.encode(), self.disk_bytes(self.path))


class RecoveryKeyTests(SecureCase):
    def test_the_recovery_key_opens_the_notes_on_another_machine(self):
        note = self.page_note()
        recovery = self.service.mark_secure(note["id"])["recoveryKey"]
        self.service.lock_secure()
        other_path = self.root / "other-machine.db"
        shutil.copy(self.database_path, other_path)
        other = self.make_service(other_path, FakeMac())  # a different keychain
        with self.assertRaises(SecureAuthError):
            other.unlock_secure()
        with self.assertRaises(SecureAuthError):
            other.unlock_secure(recovery_key="AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA")
        other.unlock_secure(recovery_key=recovery.lower().replace("-", " "))
        self.assertEqual(other.get_note(note["id"])["content"]["markdown"], f"my card is {SECRET}")


class NothingLeaksTests(SecureCase):
    def setUp(self):
        super().setUp()
        self.plain = self.page_note(title="Grocery list", markdown="milk and ZEBRA-GROCERY")
        self.note = self.page_note()
        self.assertIn(SECRET.encode(), self.disk_bytes())  # sanity: it was plain before
        self.service.mark_secure(self.note["id"])

    def test_the_file_on_disk_holds_no_plaintext_after_marking(self):
        self.assert_no_words_on_disk()
        self.assertIn(b"ZEBRA-GROCERY", self.disk_bytes())  # ordinary notes are untouched

    def test_later_saves_stay_encrypted_on_disk(self):
        opened = self.service.get_note(self.note["id"])
        content = {"markdown": "second secret ZEBRA-SECOND", "ink": {"marks": [], "drawings": []}}
        self.service.update_note(self.note["id"], {"title": "Cards", "content": content, "revision": opened["revision"]})
        self.assert_no_words_on_disk()

    def test_search_finds_the_title_but_never_the_words(self):
        self.assertEqual(self.service.search("ZEBRA-CARD"), [])
        self.assertEqual(self.service.search("4111"), [])
        hits = self.service.search("Cards")
        self.assertEqual([hit["id"] for hit in hits], [self.note["id"]])
        self.assertEqual(hits[0]["excerpt"], "")
        self.assertEqual([hit["id"] for hit in self.service.search("ZEBRA-GROCERY")], [self.plain["id"]])

    def test_the_change_feed_carries_no_words(self):
        feed = self.service.changes_since(0)
        self.assertTrue(feed["changes"])
        self.assertNotIn("ZEBRA", json.dumps(feed))

    def test_a_restart_does_not_put_the_words_back_in_the_index(self):
        self.service.lock_secure()
        again = self.make_service(self.database_path, self.mac)
        self.assertEqual(again.search("ZEBRA-CARD"), [])
        self.assert_no_words_on_disk()

    def test_unsecuring_puts_the_words_back_in_the_open(self):
        self.service.unmark_secure(self.note["id"])
        restored = self.service.get_note(self.note["id"])
        self.assertFalse(restored["secure"])
        self.assertEqual(restored["content"]["markdown"], f"my card is {SECRET}")
        self.assertEqual([hit["id"] for hit in self.service.search("4111")], [self.note["id"]])

    def test_unsecuring_needs_the_note_unlocked(self):
        self.service.lock_secure()
        with self.assertRaises(SecureLockedError):
            self.service.unmark_secure(self.note["id"])


class ExportAndBackupTests(SecureCase):
    def setUp(self):
        super().setUp()
        self.plain = self.page_note(title="Grocery list", markdown="milk and ZEBRA-GROCERY")
        self.note = self.page_note()
        self.recovery = self.service.mark_secure(self.note["id"])["recoveryKey"]

    def test_markdown_export_skips_the_words_but_names_the_note(self):
        archive = zipfile.ZipFile(io.BytesIO(markdown_archive(self.service)))
        text = "\n".join(archive.read(name).decode("utf-8") for name in archive.namelist())
        self.assertNotIn("ZEBRA-CARD", text)
        self.assertIn("ZEBRA-GROCERY", text)
        self.assertIn("# Cards", text)
        self.assertIn("secure note", text.lower())

    def test_obsidian_vault_export_skips_the_words_too(self):
        archive = zipfile.ZipFile(io.BytesIO(export_vault_archive(self.service)))
        text = "\n".join(archive.read(name).decode("utf-8") for name in archive.namelist())
        self.assertNotIn("ZEBRA-CARD", text)
        self.assertIn("secure note", text.lower())

    def test_a_backup_carries_ciphertext_and_wrapped_keys_even_when_unlocked(self):
        backup = workspace_backup(self.service)
        raw = json.dumps(backup)
        self.assertNotIn("ZEBRA-CARD", raw)
        self.assertIn("ZEBRA-GROCERY", raw)
        secure = [note for note in backup["notes"] if note.get("secure")]
        self.assertEqual(len(secure), 1)
        self.assertTrue(secure[0]["sealed"])
        self.assertTrue(backup["secureKeys"])
        self.assertNotIn(self.recovery, raw)
        self.assertNotIn(self.mac.key.hex(), raw)

    def test_restoring_on_another_machine_stays_encrypted_until_the_recovery_key(self):
        backup = json.loads(json.dumps(workspace_backup(self.service)))
        fresh_path = self.root / "fresh.db"
        fresh = self.make_service(fresh_path, FakeMac())
        result = import_workspace_backup(fresh, backup)
        self.assertEqual(result["notesImported"], 2)
        self.assert_no_words_on_disk(fresh_path)
        imported = {note["title"]: fresh.get_note(note["id"]) for note in fresh.list_notes()}
        self.assertTrue(imported["Cards"]["locked"])
        self.assertIsNone(imported["Cards"]["content"])
        with self.assertRaises(SecureAuthError):
            fresh.unlock_secure()
        fresh.unlock_secure(recovery_key=self.recovery)
        self.assertEqual(fresh.get_note(imported["Cards"]["id"])["content"]["markdown"], f"my card is {SECRET}")
        self.assertEqual(fresh.search("ZEBRA-CARD"), [])

    def test_importing_into_the_same_workspace_adds_a_copy_and_leaves_the_original(self):
        before = self.service.get_note(self.note["id"])
        import_workspace_backup(self.service, json.loads(json.dumps(workspace_backup(self.service))))
        self.assertEqual(self.service.get_note(self.note["id"])["revision"], before["revision"])
        copies = [note for note in self.service.list_notes() if note["title"] == "Cards"]
        self.assertEqual(len(copies), 2)
        self.assertTrue(all(self.service.get_note(note["id"])["content"]["markdown"] == f"my card is {SECRET}" for note in copies))

    def test_a_machine_with_its_own_secure_notes_keeps_both_sets_apart(self):
        other = self.make_service(self.root / "own.db", FakeMac())
        own = self.page_note(other, title="Own", markdown="own ZEBRA-OWN")
        other.mark_secure(own["id"])
        import_workspace_backup(other, json.loads(json.dumps(workspace_backup(self.service))))
        titles = {note["title"]: note for note in other.list_notes()}
        self.assertFalse(other.get_note(titles["Own"]["id"])["locked"])
        self.assertTrue(other.get_note(titles["Cards"]["id"])["locked"])
        other.lock_secure()
        other.unlock_secure(recovery_key=self.recovery)
        self.assertEqual(other.get_note(titles["Cards"]["id"])["content"]["markdown"], f"my card is {SECRET}")

    def test_a_damaged_backup_secure_note_is_refused_whole(self):
        backup = json.loads(json.dumps(workspace_backup(self.service)))
        for note in backup["notes"]:
            if note.get("secure"):
                note["sealed"] = 7
        fresh = self.make_service(self.root / "fresh2.db", FakeMac())
        with self.assertRaises(WorkspaceImportError):
            import_workspace_backup(fresh, backup)
        self.assertEqual([note["title"] for note in fresh.list_notes()], [])


class AgentTests(SecureCase):
    def setUp(self):
        super().setUp()
        self.note = self.page_note()
        self.service.mark_secure(self.note["id"])

    def run_cli(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli_main(["--database", str(self.database_path), *arguments])
        return code, json.loads(output.getvalue())

    def test_the_agent_cli_sees_a_locked_note_with_no_words(self):
        code, note = self.run_cli("notes", "get", str(self.note["id"]))
        self.assertEqual(code, 0)
        self.assertTrue(note["locked"])
        self.assertIsNone(note["content"])
        self.assertNotIn("ZEBRA", json.dumps(note))

    def test_the_agent_cli_refuses_to_read_or_write_a_secure_note(self):
        for arguments in (
            ("notes", "read", str(self.note["id"])),
            ("notes", "append", str(self.note["id"]), "--text", "hello"),
            ("notes", "write", str(self.note["id"]), "--text", "hello"),
        ):
            code, result = self.run_cli(*arguments)
            self.assertEqual(code, 2, arguments)
            self.assertFalse(result["ok"])
            self.assertIn("secure", result["error"].lower())

    def test_service_agent_writes_are_refused_even_while_unlocked(self):
        for call in (
            lambda: self.service.append_text(self.note["id"], "more"),
            lambda: self.service.write_page(self.note["id"], "overwrite"),
            lambda: self.service.write_canvas_text(self.note["id"], "overwrite"),
        ):
            with self.assertRaises(SecureNoteAgentError):
                call()

    def test_the_agent_cli_search_and_exports_hold_no_words(self):
        code, matches = self.run_cli("search", "ZEBRA")
        self.assertEqual(matches, [])
        output = self.root / "backup.json"
        with contextlib.redirect_stdout(io.StringIO()):
            cli_main(["--database", str(self.database_path), "export", "workspace", "--output", str(output)])
        self.assertNotIn("ZEBRA-CARD", output.read_text())


class RouteTests(SecureCase):
    def setUp(self):
        super().setUp()
        self.app = create_app(self.root / "routes.db", secure_platform=self.mac, bound_host=None)
        self.app.state.note_service.scrypt_cost = 2**4
        self.client = TestClient(self.app, headers={"x-personal-note": "1"})
        self.note = self.client.post("/api/notes", json={"title": "Cards", "noteType": "page"}).json()
        saved = self.client.put(
            f"/api/notes/{self.note['id']}",
            json={"title": "Cards", "content": {"markdown": f"card {SECRET}"}, "revision": self.note["revision"]},
        ).json()
        self.revision = saved["revision"]

    def test_status_before_anything_is_secure(self):
        status = self.client.get("/api/secure/status").json()
        self.assertEqual(status["backend"], "touchid")
        self.assertFalse(status["configured"])
        self.assertFalse(status["unlocked"])

    def test_mark_lock_and_unlock_over_http(self):
        marked = self.client.post(f"/api/notes/{self.note['id']}/secure", json={}).json()
        self.assertIn("recoveryKey", marked)
        status = self.client.get("/api/secure/status").json()
        self.assertTrue(status["configured"] and status["unlocked"])
        self.assertEqual(self.client.post("/api/secure/lock").json()["unlocked"], False)
        locked = self.client.get(f"/api/notes/{self.note['id']}").json()
        self.assertTrue(locked["locked"])
        self.assertIsNone(locked["content"])
        refused = self.client.put(
            f"/api/notes/{self.note['id']}", json={"title": "x", "content": {"markdown": "z"}, "revision": marked["revision"]}
        )
        self.assertEqual(refused.status_code, 423)
        self.assertIn("locked", refused.json()["error"].lower())
        self.assertEqual(self.client.post("/api/secure/unlock", json={}).json()["unlocked"], True)
        opened = self.client.get(f"/api/notes/{self.note['id']}").json()
        self.assertEqual(opened["content"]["markdown"], f"card {SECRET}")

    def test_declined_touch_id_is_a_403_and_a_wrong_recovery_key_too(self):
        self.client.post(f"/api/notes/{self.note['id']}/secure", json={})
        self.client.post("/api/secure/lock")
        self.mac.approve = False
        self.assertEqual(self.client.post("/api/secure/unlock", json={}).status_code, 403)
        wrong = self.client.post("/api/secure/unlock", json={"recoveryKey": "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH"})
        self.assertEqual(wrong.status_code, 403)

    def test_the_secure_routes_refuse_requests_from_other_pages(self):
        plain = TestClient(self.app)
        self.assertEqual(plain.post(f"/api/notes/{self.note['id']}/secure", json={}).status_code, 403)
        self.assertEqual(plain.post("/api/secure/unlock", json={}).status_code, 403)
        self.assertEqual(plain.post("/api/secure/lock").status_code, 403)
        self.assertEqual(plain.delete(f"/api/notes/{self.note['id']}/secure").status_code, 403)

    def test_a_passphrase_travels_in_the_body_on_linux(self):
        app = create_app(self.root / "linux-routes.db", secure_platform=FakeLinux(), bound_host=None)
        app.state.note_service.scrypt_cost = 2**4
        client = TestClient(app, headers={"x-personal-note": "1"})
        note = client.post("/api/notes", json={"title": "Cards", "noteType": "page"}).json()
        self.assertEqual(client.post(f"/api/notes/{note['id']}/secure", json={}).status_code, 400)
        marked = client.post(f"/api/notes/{note['id']}/secure", json={"passphrase": PASSPHRASE})
        self.assertEqual(marked.status_code, 200)
        client.post("/api/secure/lock")
        self.assertEqual(client.post("/api/secure/unlock", json={"passphrase": "nope nope nope"}).status_code, 403)
        self.assertTrue(client.post("/api/secure/unlock", json={"passphrase": PASSPHRASE}).json()["unlocked"])

    def test_the_exports_over_http_hold_no_words(self):
        self.client.post(f"/api/notes/{self.note['id']}/secure", json={})
        for path in ("/api/export/workspace", "/api/export/markdown", "/api/export/vault"):
            body = self.client.get(path).content
            if body[:2] == b"PK":
                archive = zipfile.ZipFile(io.BytesIO(body))
                body = b"".join(archive.read(name) for name in archive.namelist())
            self.assertNotIn(b"ZEBRA-CARD", body, path)

    def test_unsecure_over_http(self):
        self.client.post(f"/api/notes/{self.note['id']}/secure", json={})
        result = self.client.delete(f"/api/notes/{self.note['id']}/secure")
        self.assertEqual(result.status_code, 200)
        self.assertFalse(self.client.get(f"/api/notes/{self.note['id']}").json()["secure"])


class ReviewFixTests(SecureCase):
    def setUp(self):
        super().setUp()
        self.note = self.page_note()
        self.recovery = self.service.mark_secure(self.note["id"])["recoveryKey"]

    def backup(self):
        return json.loads(json.dumps(workspace_backup(self.service)))

    def linux_backup(self):
        linux = self.make_service(self.root / "src-linux.db", FakeLinux())
        note = self.page_note(linux)
        result = linux.mark_secure(note["id"], passphrase=PASSPHRASE)
        return linux, json.loads(json.dumps(workspace_backup(linux))), result["recoveryKey"]

    # 1: key rows in a backup are validated
    def test_import_refuses_secure_key_rows_that_could_break_unlocking(self):
        _linux, backup, _recovery = self.linux_backup()
        cases = {
            "salt null": lambda k: k.update(salt=None),
            "params null": lambda k: k.update(params=None),
            "oversize n": lambda k: k.update(params={"kdf": "scrypt", "n": 2**25, "r": 8, "p": 1}),
            "oversize memory": lambda k: k.update(params={"kdf": "scrypt", "n": 2**18, "r": 32, "p": 1}),
            "not a power of two": lambda k: k.update(params={"kdf": "scrypt", "n": 1000, "r": 8, "p": 1}),
            "string n": lambda k: k.update(params={"kdf": "scrypt", "n": "big", "r": 8, "p": 1}),
        }
        for name, damage in cases.items():
            damaged = json.loads(json.dumps(backup))
            damage(next(k for k in damaged["secureKeys"] if k["kind"] == "passphrase"))
            with self.assertRaises(WorkspaceImportError, msg=name):
                import_workspace_backup(self.make_service(self.root / f"v-{abs(hash(name))}.db", FakeMac()), damaged)
        damaged = json.loads(json.dumps(backup))
        next(k for k in damaged["secureKeys"] if k["kind"] == "recovery")["salt"] = None
        with self.assertRaises(WorkspaceImportError):
            import_workspace_backup(self.make_service(self.root / "v-rec.db", FakeMac()), damaged)

    def test_a_bad_stored_row_never_breaks_unlocking(self):
        import sqlite3
        self.service.lock_secure()
        with sqlite3.connect(self.database_path) as connection:
            connection.execute("INSERT INTO secure_keys (key_id, kind, version, salt, params, wrapped) VALUES ('key_x', 'passphrase', 1, NULL, NULL, 'AAAA')")
            connection.execute("INSERT INTO secure_keys (key_id, kind, version, salt, params, wrapped) VALUES ('key_y', 'recovery', 1, NULL, NULL, 'AAAA')")
            connection.execute("INSERT INTO secure_keys (key_id, kind, version, salt, params, wrapped) VALUES ('key_z', 'keychain', 1, '!!', 'junk', '!!')")
        self.service.unlock_secure()
        self.service.lock_secure()
        self.service.unlock_secure(recovery_key=self.recovery)
        self.assertTrue(self.service.secure_status()["unlocked"])

    # 2: a restored machine gets its own wrap
    def test_a_recovery_unlock_on_a_mac_adds_this_macs_own_wrap(self):
        other_mac = FakeMac()
        fresh = self.make_service(self.root / "restored.db", other_mac)
        import_workspace_backup(fresh, self.backup())
        with self.assertRaises(SecureAuthError):
            fresh.unlock_secure()
        status = fresh.unlock_secure(recovery_key=self.recovery)
        self.assertTrue(status["deviceWrapAdded"])
        fresh.lock_secure()
        fresh.unlock_secure()  # Touch ID alone now opens them
        self.assertTrue(fresh.secure_status()["unlocked"])

    def test_a_declined_touch_id_still_unlocks_by_recovery_but_adds_no_wrap(self):
        other_mac = FakeMac(approve=False)
        fresh = self.make_service(self.root / "restored2.db", other_mac)
        import_workspace_backup(fresh, self.backup())
        status = fresh.unlock_secure(recovery_key=self.recovery)
        self.assertTrue(status["unlocked"])
        self.assertFalse(status["deviceWrapAdded"])

    def test_a_recovery_unlock_with_a_passphrase_adds_a_linux_wrap(self):
        fresh = self.make_service(self.root / "restored3.db", FakeLinux())
        import_workspace_backup(fresh, self.backup())
        with self.assertRaises(SecureSetupError):
            fresh.unlock_secure(recovery_key=self.recovery, passphrase="short")
        self.assertFalse(fresh.secure_status()["unlocked"])
        status = fresh.unlock_secure(recovery_key=self.recovery, passphrase=PASSPHRASE)
        self.assertTrue(status["deviceWrapAdded"])
        fresh.lock_secure()
        fresh.unlock_secure(passphrase=PASSPHRASE)
        self.assertTrue(fresh.secure_status()["unlocked"])

    def test_a_passphrase_can_be_added_later_while_unlocked_on_linux_only(self):
        fresh = self.make_service(self.root / "restored4.db", FakeLinux())
        import_workspace_backup(fresh, self.backup())
        with self.assertRaises(SecureLockedError):
            fresh.add_passphrase(PASSPHRASE)
        fresh.unlock_secure(recovery_key=self.recovery)
        fresh.add_passphrase(PASSPHRASE)
        fresh.lock_secure()
        fresh.unlock_secure(passphrase=PASSPHRASE)
        self.assertTrue(fresh.secure_status()["unlocked"])
        with self.assertRaises(SecureSetupError):
            self.service.add_passphrase(PASSPHRASE)  # a Mac uses Touch ID instead

    def test_marking_refuses_a_passphrase_it_would_not_store(self):
        with self.assertRaises(SecureSetupError):
            self.service.mark_secure(self.page_note(title="Second")["id"], passphrase=PASSPHRASE)
        mac = self.make_service(self.root / "mac2.db", FakeMac())
        with self.assertRaises(SecureSetupError):
            mac.mark_secure(self.page_note(mac)["id"], passphrase=PASSPHRASE)

    # 3: each sealed blob is bound to its note
    def test_swapping_sealed_blobs_between_notes_fails(self):
        import sqlite3
        other = self.page_note(title="Other", markdown="other ZEBRA-OTHER")
        self.service.mark_secure(other["id"])
        with sqlite3.connect(self.database_path) as connection:
            rows = dict(connection.execute("SELECT id, sealed FROM notes WHERE secure = 1").fetchall())
            connection.execute("UPDATE notes SET sealed = ? WHERE id = ?", (rows[other["id"]], self.note["id"]))
        with self.assertRaises(SecureAuthError):
            self.service.get_note(self.note["id"])

    def test_the_seal_id_travels_in_a_backup_and_is_required(self):
        backup = self.backup()
        secure = [n for n in backup["notes"] if n.get("secure")][0]
        self.assertTrue(secure["sealId"])
        del secure["sealId"]
        with self.assertRaises(WorkspaceImportError):
            import_workspace_backup(self.make_service(self.root / "nos.db", FakeMac()), backup)

    # 4: agents cannot delete
    def test_the_cli_will_not_delete_a_secure_note(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli_main(["--database", str(self.database_path), "notes", "delete", str(self.note["id"])])
        self.assertEqual(code, 2)
        self.assertEqual(self.service.get_note(self.note["id"])["id"], self.note["id"])

    # extras
    def test_a_save_without_words_cannot_wipe_a_secure_note(self):
        opened = self.service.get_note(self.note["id"])
        for content in (None, "missing"):
            body = {"title": "Cards", "revision": opened["revision"]}
            if content is None:
                body["content"] = None
            with self.assertRaises(SecureSetupError):
                self.service.update_note(self.note["id"], body)
        self.assertEqual(self.service.get_note(self.note["id"])["content"]["markdown"], f"my card is {SECRET}")

    def test_the_words_need_the_app_header_over_http(self):
        app = create_app(self.root / "hdr.db", secure_platform=FakeMac(), bound_host=None)
        client = TestClient(app, headers={"x-personal-note": "1"})
        note = client.post("/api/notes", json={"title": "T", "noteType": "page"}).json()
        client.put(f"/api/notes/{note['id']}", json={"title": "T", "content": {"markdown": "hello ZEBRA"}, "revision": note["revision"]})
        client.post(f"/api/notes/{note['id']}/secure", json={})
        self.assertEqual(client.get(f"/api/notes/{note['id']}").json()["content"]["markdown"], "hello ZEBRA")
        casual = TestClient(app).get(f"/api/notes/{note['id']}").json()
        self.assertTrue(casual["locked"])
        self.assertIsNone(casual["content"])


if __name__ == "__main__":
    unittest.main()


class AutoLockSettingsTests(SecureCase):
    def test_the_status_tells_the_page_how_long_the_quiet_time_is(self):
        app = create_app(self.root / "idle.db", secure_platform=self.mac, bound_host=None)
        client = TestClient(app, headers={"x-personal-note": "1"})
        self.assertEqual(client.get("/api/secure/status").json()["idleSeconds"], 300)

    def test_the_quiet_time_can_be_shortened_for_checks(self):
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_SECURE_IDLE_SECONDS": "7"}):
            app = create_app(self.root / "idle2.db", secure_platform=self.mac, bound_host=None)
        client = TestClient(app, headers={"x-personal-note": "1"})
        self.assertEqual(client.get("/api/secure/status").json()["idleSeconds"], 7)

    def test_a_garbage_setting_keeps_five_minutes(self):
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_SECURE_IDLE_SECONDS": "soon"}):
            app = create_app(self.root / "idle3.db", secure_platform=self.mac, bound_host=None)
        self.assertEqual(TestClient(app).get("/api/secure/status").json()["idleSeconds"], 300)


class SearchShowsSecureNotesTests(SecureCase):
    def test_a_secure_note_is_found_by_title_and_marked_secure_with_no_excerpt(self):
        service = self.service_for(self.mac) if hasattr(self, "service_for") else NoteService(self.root / "s.db", secure_platform=self.mac, scrypt_cost=2**4)
        note = service.create_note({"title": "Banking quokka", "noteType": "page"})
        saved = service.update_note(note["id"], {"title": "Banking quokka", "content": {"markdown": f"pin {SECRET}"}, "revision": note["revision"]})
        service.mark_secure(note["id"], revision=saved["revision"])
        found = service.search("quokka")
        self.assertEqual([item["title"] for item in found], ["Banking quokka"])
        self.assertTrue(found[0]["secure"])
        self.assertEqual(found[0]["excerpt"], "")
        self.assertEqual(service.search("ZEBRA"), [])


class SlowMac(FakeMac):
    """Touch ID that takes a while to answer, like a person finding the sensor."""

    def authenticate(self, reason, timeout=0):
        time.sleep(0.8)
        return super().authenticate(reason, timeout)


class EventLoopTests(SecureCase):
    """A real server (a TestClient gives every request its own loop and would hide a blocked one)."""

    def serve(self, name, platform):
        from desktop import LocalServer

        server = LocalServer(create_app(self.root / name, secure_platform=platform, bound_host=None))
        base = server.start()
        self.addCleanup(server.stop)

        def call(method, path, body=None):
            from urllib.request import Request, urlopen

            request = Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"x-personal-note": "1", "content-type": "application/json"})
            with urlopen(request, timeout=10) as response:
                return json.loads(response.read() or b"null")

        return call

    def assert_others_answer_meanwhile(self, call, slow):
        thread = threading.Thread(target=slow)
        thread.start()
        time.sleep(0.25)
        started = time.monotonic()
        call("GET", "/api/secure/status")
        call("GET", "/api/notes")
        self.assertLess(time.monotonic() - started, 0.5)
        thread.join(10)

    def test_a_slow_touch_id_does_not_stop_other_requests(self):
        call = self.serve("slow.db", SlowMac())
        note = call("POST", "/api/notes", {"title": "Cards", "noteType": "page"})
        call("POST", f"/api/notes/{note['id']}/secure", {})
        call("POST", "/api/secure/lock", {})
        self.assert_others_answer_meanwhile(call, lambda: call("POST", "/api/secure/unlock", {}))
        self.assertTrue(call("GET", "/api/secure/status")["unlocked"])

    def test_marking_a_note_secure_does_not_block_either(self):
        call = self.serve("slow2.db", SlowMac())
        note = call("POST", "/api/notes", {"title": "Cards", "noteType": "page"})
        self.assert_others_answer_meanwhile(call, lambda: call("POST", f"/api/notes/{note['id']}/secure", {}))

    def test_a_slow_recovery_unlock_that_adds_this_machine_does_not_block(self):
        mac = SlowMac()
        call = self.serve("slow3.db", mac)
        note = call("POST", "/api/notes", {"title": "Cards", "noteType": "page"})
        key = call("POST", f"/api/notes/{note['id']}/secure", {})["recoveryKey"]
        call("POST", "/api/secure/lock", {})
        self.assert_others_answer_meanwhile(call, lambda: call("POST", "/api/secure/unlock", {"recoveryKey": key}))


class TouchTests(SecureCase):
    def test_a_touch_renews_the_quiet_time_while_unlocked(self):
        clock = Clock()
        service = NoteService(self.root / "touch.db", secure_platform=self.mac, scrypt_cost=2**4, clock=clock)
        note = self.page_note(service)
        service.mark_secure(note["id"])
        service.keyring.set_idle_timeout(300)
        for _ in range(3):
            clock.now += 250
            self.assertTrue(service.touch_secure()["unlocked"])
        self.assertFalse(service.get_note(note["id"])["locked"])
        clock.now += 301
        self.assertFalse(service.touch_secure()["unlocked"])  # too late: a touch never unlocks
        self.assertTrue(service.get_note(note["id"])["locked"])

    def test_the_touch_route_needs_the_app_header(self):
        app = create_app(self.root / "touchroute.db", secure_platform=self.mac, bound_host=None)
        self.assertEqual(TestClient(app).post("/api/secure/touch").status_code, 403)
        self.assertEqual(TestClient(app, headers={"x-personal-note": "1"}).post("/api/secure/touch").status_code, 200)
