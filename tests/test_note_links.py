"""A note dropped into a note (F-095): the link card on a canvas, the link in a page, what the server says about the target,
backup and Markdown export, and "Done" on an X bookmark."""
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from starlette.testclient import TestClient

import json_canvas as jc
from portability import import_workspace_backup, markdown_archive, workspace_backup
from routes import create_app
from services import NoteService
from tests.test_secure_notes import FakeMac

GEOMETRY = {"x": 40, "y": 60, "width": 280, "height": 92, "rotation": 0, "scaleX": 1, "scaleY": 1, "flipX": False, "flipY": False, "skewX": 0, "skewY": 0}


def link_object(ref, title, object_id="card-1"):
    return {"id": object_id, "type": "notelink", "geometry": dict(GEOMETRY), "noteRef": ref, "title": title, "extras": {}}


def canvas_with(*objects):
    return jc.to_json_canvas({"schemaVersion": 1, "page": {"columns": 1, "rows": 1}, "objects": list(objects), "extras": {}})


class NoteLinkApiTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.mac = FakeMac()
        self.service = NoteService(Path(self.folder.name) / "p.db", secure_platform=self.mac, scrypt_cost=2**4)
        self.client = TestClient(create_app(Path(self.folder.name) / "app.db"))
        self.notebook = self.client.get("/api/notebooks").json()[0]

    def tearDown(self):
        self.client.close()
        self.folder.cleanup()

    def make_page(self, title, markdown, client=None):
        client = client or self.client
        note = client.post("/api/notes", json={"title": title, "notebookId": self.notebook["id"], "noteType": "page"}).json()
        saved = client.put(f"/api/notes/{note['id']}", json={"title": title, "revision": note["revision"], "content": {"version": 1, "markdown": markdown, "ink": {"marks": [], "drawings": []}}})
        self.assertEqual(saved.status_code, 200)
        return client.get(f"/api/notes/{note['id']}").json()

    def make_canvas(self, title, *objects):
        note = self.client.post("/api/notes", json={"title": title, "notebookId": self.notebook["id"]}).json()
        saved = self.client.put(f"/api/notes/{note['id']}", json={"title": title, "revision": note["revision"], "content": canvas_with(*objects)})
        self.assertEqual(saved.status_code, 200, saved.text)
        return self.client.get(f"/api/notes/{note['id']}").json()

    def info(self, *refs):
        return self.client.get("/api/note-links", params={"refs": ",".join(refs)}).json()

    # --- what the card shows --------------------------------------------------------------------------------------------

    def test_a_card_shows_the_title_the_first_lines_and_the_notebook(self):
        target = self.make_page("Lisbon trip", "# Lisbon\n\nHarbour walk at dusk\n\nBuy tickets\n\nPack the camera")
        result = self.info(target["resourceId"])
        card = result[target["resourceId"]]
        self.assertEqual(card["id"], target["id"])
        self.assertEqual(card["title"], "Lisbon trip")
        self.assertEqual(card["excerpt"], "Lisbon\nHarbour walk at dusk\nBuy tickets")
        self.assertEqual(card["secure"], False)
        self.assertEqual(card["notebook"], {"name": self.notebook["name"], "color": self.notebook["color"], "icon": self.notebook["icon"]})

    def test_a_removed_target_is_null_not_an_error(self):
        target = self.make_page("Gone soon", "words")
        self.assertEqual(self.client.delete(f"/api/notes/{target['id']}").status_code, 204)
        response = self.client.get("/api/note-links", params={"refs": f"{target['resourceId']},res_" + "0" * 32})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {target["resourceId"]: None, "res_" + "0" * 32: None})

    def test_a_secure_target_shows_only_its_title(self):
        note = self.service.create_note({"title": "Card numbers", "noteType": "page"})
        self.service.update_note(note["id"], {"title": "Card numbers", "revision": note["revision"], "content": {"markdown": "ZEBRA-4111 secret words", "ink": {"marks": [], "drawings": []}}})
        self.service.mark_secure(note["id"])
        card = self.service.note_links([note["resourceId"]])[note["resourceId"]]
        self.assertEqual((card["title"], card["excerpt"], card["secure"]), ("Card numbers", "", True))
        self.assertNotIn("ZEBRA", json.dumps(card))

    # --- the link card is JSON Canvas ----------------------------------------------------------------------------------

    def test_a_card_is_a_json_canvas_link_node_and_reads_back_as_a_card(self):
        canvas = canvas_with(link_object("res_" + "a" * 32, "Lisbon trip"))
        (node,) = canvas["nodes"]
        self.assertEqual((node["type"], node["url"]), ("link", "personal-note://note/res_" + "a" * 32))
        self.assertEqual(jc.validate_json_canvas(canvas), {"ok": True, "errors": []})
        (back,) = jc.from_json_canvas(canvas)["objects"]
        self.assertEqual((back["type"], back["noteRef"], back["title"], back["id"]), ("notelink", "res_" + "a" * 32, "Lisbon trip", "card-1"))

    def test_a_card_saves_and_loads_and_only_its_title_is_searchable(self):
        target = self.make_page("Lisbon trip", "words")
        note = self.make_canvas("Hub", link_object(target["resourceId"], "Lisbon trip"))
        again = self.client.get(f"/api/notes/{note['id']}").json()
        (node,) = [n for n in again["content"]["nodes"] if n["type"] == "link"]
        self.assertEqual(node["url"], f"personal-note://note/{target['resourceId']}")
        hits = self.client.get("/api/search", params={"q": "Lisbon"}).json()
        self.assertIn("Hub", [hit["title"] for hit in hits])
        self.assertEqual([hit["title"] for hit in self.client.get("/api/search", params={"q": "personal"}).json()], [])

    # --- backup and export ----------------------------------------------------------------------------------------------

    def test_a_restored_backup_points_its_cards_and_links_at_the_restored_notes(self):
        target = self.make_page("Lisbon trip", "words")
        canvas = self.make_canvas("Hub", link_object(target["resourceId"], "Lisbon trip"))
        page = self.make_page("Reading list", f"See [Lisbon trip](personal-note://note/{target['resourceId']}) first.")
        backup = self.client.get("/api/export/workspace").json()

        other = TestClient(create_app(Path(self.folder.name) / "other.db"))
        try:
            result = other.post("/api/import/workspace", json=backup)
            self.assertEqual(result.status_code, 201, result.text)
            notes = {note["title"]: note for note in other.get("/api/notes").json()}
            new_target = notes["Lisbon trip"]
            self.assertNotEqual(new_target["resourceId"], target["resourceId"])
            hub = other.get(f"/api/notes/{notes['Hub']['id']}").json()
            (node,) = [n for n in hub["content"]["nodes"] if n["type"] == "link"]
            self.assertEqual(node["url"], f"personal-note://note/{new_target['resourceId']}")
            reading = other.get(f"/api/notes/{notes['Reading list']['id']}").json()
            self.assertEqual(reading["content"]["markdown"], f"See [Lisbon trip](personal-note://note/{new_target['resourceId']}) first.")
            card = other.get("/api/note-links", params={"refs": new_target["resourceId"]}).json()[new_target["resourceId"]]
            self.assertEqual(card["title"], "Lisbon trip")
        finally:
            other.close()
        self.assertEqual(canvas["title"], "Hub")
        self.assertEqual(page["title"], "Reading list")

    def test_markdown_export_writes_a_working_relative_link(self):
        target = self.make_page("Lisbon trip", "words")
        self.make_canvas("Hub", link_object(target["resourceId"], "Lisbon trip"))
        self.make_page("Reading list", f"See [Lisbon trip](personal-note://note/{target['resourceId']}) first.")
        removed = self.make_page("Short lived", "x")
        self.make_canvas("Orphan", link_object(removed["resourceId"], "Short lived", "card-2"))
        self.client.delete(f"/api/notes/{removed['id']}")
        archive = zipfile.ZipFile(io.BytesIO(self.client.get("/api/export/markdown").content))
        names = archive.namelist()
        folder = Path(next(name for name in names if name.endswith("lisbon-trip.md"))).parent.as_posix()
        hub = archive.read(next(name for name in names if name.endswith("/hub.md"))).decode()
        reading = archive.read(next(name for name in names if name.endswith("/reading-list.md"))).decode()
        orphan = archive.read(next(name for name in names if name.endswith("/orphan.md"))).decode()
        self.assertIn("[Lisbon trip](lisbon-trip.md)", hub)
        self.assertIn("See [Lisbon trip](lisbon-trip.md) first.", reading)
        self.assertIn("Short lived (note removed)", orphan)
        self.assertNotIn("personal-note://", hub + reading + orphan)
        self.assertTrue(folder.startswith("notes/"))

    # --- Done on an X bookmark ------------------------------------------------------------------------------------------

    def test_done_files_an_x_bookmark_into_an_archive_notebook_and_keeps_it(self):
        service = NoteService(Path(self.folder.name) / "x.db")
        service.import_x_bookmarks([{"id": "7001", "url": "https://x.com/ada/status/7001", "author_handle": "ada", "text": "first post"}, {"id": "7002", "url": "https://x.com/bob/status/7002", "author_handle": "bob", "text": "second post"}])
        notes = {note["title"]: note for note in service.list_notes()}
        bookmark = next(note for title, note in notes.items() if "first post" in title)
        done = service.mark_x_done(bookmark["id"])
        moved = service.get_note(bookmark["id"])
        archive = next(book for book in service.list_notebooks() if book["id"] == moved["notebookId"])
        self.assertEqual((archive["category"], archive["icon"], archive["name"]), ("archive", "brand:x", "X bookmarks done"))
        self.assertEqual(done["notebookId"], archive["id"])
        self.assertIn("first post", moved["content"]["markdown"])
        other = next(note for note in service.list_notes() if "second post" in note["title"])
        self.assertNotEqual(other["notebookId"], archive["id"])
        service.mark_x_done(other["id"])  # the same archive notebook is used again
        self.assertEqual(len([b for b in service.list_notebooks() if b["name"] == "X bookmarks done"]), 1)

    def test_done_works_on_a_restored_bookmark_in_an_x_notebook_before_the_sync_adopts_it(self):
        service = NoteService(Path(self.folder.name) / "restored.db")
        notebook = service.create_notebook({"name": "X bookmarks", "category": "resources", "icon": "brand:x"})
        note = service.create_note({"title": "@ada: restored", "noteType": "page", "notebookId": notebook["id"]})
        done = service.mark_x_done(note["id"])
        self.assertEqual(service.get_note(note["id"])["notebookId"], done["notebookId"])
        self.assertNotEqual(done["notebookId"], notebook["id"])

    def test_done_refuses_a_note_that_is_not_an_x_bookmark(self):
        plain = self.make_page("Plain", "x")
        response = self.client.post(f"/api/notes/{plain['id']}/x-done", headers={"x-personal-note": "1"})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.client.get(f"/api/notes/{plain['id']}").json()["notebookId"], self.notebook["id"])


if __name__ == "__main__":
    unittest.main()
