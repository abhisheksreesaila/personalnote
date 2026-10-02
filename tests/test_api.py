import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from starlette.testclient import TestClient

from routes import create_app


class ApiContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        database_path = Path(self.temporary_directory.name) / "personal-note.db"
        self.app = create_app(database_path)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.temporary_directory.cleanup()

    def create_text_note(self, title="Project note", text="A useful project detail"):
        notebook = self.client.get("/api/notebooks").json()[0]
        note = self.client.post(
            "/api/notes", json={"title": title, "notebookId": notebook["id"]}
        ).json()
        update = self.client.put(
            f"/api/notes/{note['id']}",
            json={
                "title": title,
                "notebookId": notebook["id"],
                "revision": note["revision"],
                "content": {
                    "objects": [
                        {"type": "IText", "text": text, "left": 72, "top": 80}
                    ]
                },
                "pageState": {"columns": 2, "rows": 1},
            },
        )
        self.assertEqual(update.status_code, 200)
        return notebook, self.client.get(f"/api/notes/{note['id']}").json()

    def test_notebook_category_defaults_validates_and_round_trips(self):
        default = self.client.get("/api/notebooks").json()[0]
        self.assertEqual(default["category"], "projects")

        created = self.client.post(
            "/api/notebooks", json={"name": "Health", "category": "areas"}
        ).json()
        self.assertEqual(created["category"], "areas")

        bogus = self.client.post(
            "/api/notebooks", json={"name": "Odd", "category": "nonsense"}
        ).json()
        self.assertEqual(bogus["category"], "projects")

        updated = self.client.put(
            f"/api/notebooks/{created['id']}",
            json={"revision": created["revision"], "category": "archive"},
        ).json()
        self.assertEqual(updated["category"], "archive")
        self.assertEqual(updated["name"], "Health")

        listed = {item["name"]: item["category"] for item in self.client.get("/api/notebooks").json()}
        self.assertEqual(listed["Health"], "archive")

        backup = self.client.get("/api/export/workspace").json()
        exported = {item["name"]: item.get("category") for item in backup["notebooks"]}
        self.assertEqual(exported["Health"], "archive")
        self.client.post("/api/import/workspace", json=backup)
        categories = [item["category"] for item in self.client.get("/api/notebooks").json() if item["name"] == "Health"]
        self.assertEqual(sorted(categories), ["archive", "archive"])

    def test_existing_database_without_category_migrates_to_projects(self):
        import sqlite3
        legacy = Path(self.temporary_directory.name) / "legacy.db"
        connection = sqlite3.connect(legacy)
        connection.execute(
            "CREATE TABLE notebooks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#B86B4B', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        )
        connection.execute("INSERT INTO notebooks (name) VALUES ('Old')")
        connection.commit()
        connection.close()
        with TestClient(create_app(legacy)) as client:
            notebooks = client.get("/api/notebooks").json()
        self.assertEqual([(item["name"], item["category"]) for item in notebooks], [("Old", "projects")])

    def test_note_and_notebook_contract(self):
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["backend"], "fasthtml")

        notebooks = self.client.get("/api/notebooks").json()
        self.assertEqual(len(notebooks), 1)
        self.assertEqual(notebooks[0]["name"], "My Notes")

        notebook_response = self.client.post(
            "/api/notebooks", json={"name": "Launch", "color": "#267A9D"}
        )
        self.assertEqual(notebook_response.status_code, 201)
        notebook = notebook_response.json()

        note_response = self.client.post(
            "/api/notes", json={"title": "Maya decision", "notebookId": notebook["id"]}
        )
        self.assertEqual(note_response.status_code, 201)
        note = note_response.json()
        self.assertEqual(note["notebookId"], notebook["id"])

        update_response = self.client.put(
            f"/api/notes/{note['id']}",
            json={
                "title": "Maya decision",
                "notebookId": notebook["id"],
                "revision": note["revision"],
                "content": {
                    "objects": [
                        {"type": "IText", "text": "Maya preferred September for the partner event"}
                    ]
                },
                "pageState": {"columns": 1, "rows": 1},
            },
        )
        self.assertEqual(update_response.status_code, 200)

        stale = self.client.put(
            f"/api/notes/{note['id']}",
            json={
                "title": "Stale title",
                "revision": note["revision"],
                "content": {"objects": []},
            },
        )
        self.assertEqual(stale.status_code, 409)

        search = self.client.get("/api/search", params={"q": "partner event"}).json()
        self.assertEqual(search[0]["id"], note["id"])
        self.assertIn("Maya preferred September", search[0]["excerpt"])

        delete_response = self.client.delete(f"/api/notes/{note['id']}")
        self.assertEqual(delete_response.status_code, 204)
        self.assertEqual(self.client.get(f"/api/notes/{note['id']}").status_code, 404)
        self.assertEqual(self.client.get("/api/search", params={"q": "partner event"}).json(), [])

    def test_mindmap_note_round_trips_and_indexes_node_text(self):
        notebook = self.client.get("/api/notebooks").json()[0]
        response = self.client.post(
            "/api/notes",
            json={
                "title": "Product map",
                "notebookId": notebook["id"],
                "noteType": "mindmap",
            },
        )
        self.assertEqual(response.status_code, 201)
        note = response.json()
        document = note["content"]
        document["nodes"].append({
            "id": "research",
            "parentId": "root",
            "text": "Customer discovery interviews",
            "x": 320,
            "y": -80,
            "color": "#3d8fe8",
        })
        update = self.client.put(
            f"/api/notes/{note['id']}",
            json={
                "title": "Product map",
                "notebookId": notebook["id"],
                "revision": note["revision"],
                "content": document,
            },
        )
        self.assertEqual(update.status_code, 200)
        loaded = self.client.get(f"/api/notes/{note['id']}").json()
        self.assertEqual(loaded["noteType"], "mindmap")
        self.assertEqual(loaded["content"]["nodes"][1]["text"], "Customer discovery interviews")
        self.assertEqual(
            self.client.get("/api/search", params={"q": "discovery interviews"}).json()[0]["noteType"],
            "mindmap",
        )

    def test_capabilities_describe_only_core_and_built_in_modules(self):
        response = self.client.get("/api/settings/capabilities")
        self.assertEqual(response.status_code, 200)
        capabilities = response.json()
        self.assertEqual(capabilities["storage"]["engine"], "sqlite")
        self.assertEqual(capabilities["modules"]["mindmap"]["loading"], "on-demand")
        self.assertEqual(capabilities["modules"]["voice"]["durableOutput"], "transcript-text")
        self.assertEqual(capabilities["modules"]["voice"]["audioRetention"], "none")
        self.assertTrue(capabilities["portability"]["workspaceBackup"])
        self.assertEqual(set(capabilities), {"storage", "portability", "modules"})

    def test_workspace_backup_and_merge_import_preserve_editable_documents(self):
        notebook, note = self.create_text_note()
        response = self.client.get("/api/export/workspace")
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response.headers["content-disposition"])
        backup = response.json()
        self.assertEqual(backup["format"], "personal-note-workspace")
        self.assertEqual(backup["version"], 2)
        self.assertNotIn("id", backup["notes"][0])
        exported_note = next(item for item in backup["notes"] if item["title"] == note["title"])
        self.assertEqual(exported_note["content"], note["content"])
        self.assertEqual(exported_note["pageState"], {"columns": 2, "rows": 1})

        before_notes = len(self.client.get("/api/notes").json())
        before_notebooks = len(self.client.get("/api/notebooks").json())
        imported = self.client.post("/api/import/workspace", json=backup)
        self.assertEqual(imported.status_code, 201)
        self.assertEqual(imported.json()["mode"], "merge")
        self.assertEqual(imported.json()["notesImported"], len(backup["notes"]))
        self.assertEqual(len(self.client.get("/api/notes").json()), before_notes + len(backup["notes"]))
        self.assertEqual(
            len(self.client.get("/api/notebooks").json()),
            before_notebooks + len(backup["notebooks"]),
        )
        matches = self.client.get("/api/search", params={"q": "useful project detail"}).json()
        self.assertEqual(len(matches), 2)

        self.assertEqual(exported_note["contentFormat"], "json-canvas")
        original_object_id = exported_note["content"]["nodes"][0]["id"]
        imported_note = self.client.get(f"/api/notes/{imported.json()['noteIds'][0]}").json()
        self.assertNotEqual(imported_note["content"]["nodes"][0]["id"], original_object_id)
        self.assertEqual(notebook["name"], "My Notes")

    def test_backup_import_keeps_connectors_attached_to_their_remapped_objects(self):
        notebook = self.client.get("/api/notebooks").json()[0]
        note = self.client.post("/api/notes", json={"title": "Linked", "notebookId": notebook["id"]}).json()
        objects = [
            {"type": "IText", "text": "a", "semanticId": "res_a", "left": 0, "top": 0, "width": 50, "height": 20},
            {"type": "IText", "text": "b", "semanticId": "res_b", "left": 200, "top": 0, "width": 50, "height": 20},
            {"type": "Connector", "semanticId": "res_c", "fromId": "res_a", "toId": "res_b",
             "originX": "center", "originY": "center", "left": 125, "top": 10, "width": 140, "height": 1},
        ]
        saved = self.client.put(
            f"/api/notes/{note['id']}",
            json={"title": "Linked", "notebookId": notebook["id"], "revision": note["revision"],
                  "content": {"objects": objects}, "pageState": {"columns": 1, "rows": 1}},
        )
        self.assertEqual(saved.status_code, 200)
        backup = self.client.get("/api/export/workspace").json()
        exported = next(item for item in backup["notes"] if item["title"] == "Linked")
        self.assertEqual([n["type"] for n in exported["content"]["nodes"]], ["text", "text"])
        self.assertEqual([(e["fromNode"], e["toNode"]) for e in exported["content"]["edges"]], [("res_a", "res_b")])

        imported = self.client.post("/api/import/workspace", json=backup).json()
        titles = {self.client.get(f"/api/notes/{i}").json()["title"]: i for i in imported["noteIds"]}
        copy = self.client.get(f"/api/notes/{titles['Linked']}").json()["content"]
        by_text = {n["text"]: n["id"] for n in copy["nodes"]}
        edge = copy["edges"][0]
        self.assertNotEqual(by_text["a"], "res_a")
        self.assertEqual(edge["fromNode"], by_text["a"])
        self.assertEqual(edge["toNode"], by_text["b"])
        original = self.client.get(f"/api/notes/{note['id']}").json()["content"]["edges"][0]
        self.assertEqual((original["fromNode"], original["toNode"]), ("res_a", "res_b"))

    def test_invalid_import_is_atomic_and_keeps_existing_workspace(self):
        self.create_text_note()
        before = self.client.get("/api/export/workspace").json()
        invalid = {
            "format": "personal-note-workspace",
            "version": 1,
            "notebooks": [{"resourceId": "book-1", "name": "Imported"}],
            "notes": [{
                "resourceId": "note-1",
                "notebookResourceId": "missing",
                "noteType": "canvas",
                "title": "Broken",
                "content": {"objects": []},
            }],
        }
        response = self.client.post("/api/import/workspace", json=invalid)
        self.assertEqual(response.status_code, 400)
        after = self.client.get("/api/export/workspace").json()
        self.assertEqual(after["notebooks"], before["notebooks"])
        self.assertEqual(after["notes"], before["notes"])

    def test_markdown_archive_contains_readable_notes_and_embedded_assets(self):
        notebook = self.client.get("/api/notebooks").json()[0]
        note = self.client.post(
            "/api/notes", json={"title": "Sketch plan", "notebookId": notebook["id"]}
        ).json()
        image = "data:image/png;base64,aGVsbG8="
        self.client.put(
            f"/api/notes/{note['id']}",
            json={
                "title": "Sketch plan",
                "revision": note["revision"],
                "notebookId": notebook["id"],
                "content": {"objects": [
                    {"type": "IText", "text": "Build the portable export", "top": 10},
                    {"type": "Image", "src": image, "top": 20},
                ]},
            },
        )

        response = self.client.get("/api/export/markdown")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            names = archive.namelist()
            note_path = next(name for name in names if name.endswith("sketch-plan.md"))
            markdown = archive.read(note_path).decode("utf-8")
            asset_path = next(name for name in names if name.startswith("assets/") and name.endswith(".png"))
            self.assertIn("Build the portable export", markdown)
            self.assertIn(f"../../{asset_path}", markdown)
            self.assertEqual(archive.read(asset_path), b"hello")
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["format"], "personal-note-markdown")

    def test_sticky_notes_are_searchable_and_exported_while_shapes_add_no_text(self):
        notebook = self.client.get("/api/notebooks").json()[0]
        note = self.client.post(
            "/api/notes", json={"title": "Desk board", "notebookId": notebook["id"]}
        ).json()
        content = {"objects": [
            {"type": "Sticky", "text": "Renew the passport", "stickyColor": "#ffd60a", "fontFamily": "Caveat", "top": 40, "left": 10},
            {"type": "Rect", "fill": "#64b5ff", "rx": 28, "ry": 28, "top": 300, "left": 10},
            {"type": "Sticky", "text": "", "stickyColor": "#30d158", "top": 500, "left": 10},
            {"type": "Image", "src": "data:image/webp;base64,aGVsbG8=", "top": 700, "left": 10},
        ]}
        saved = self.client.put(
            f"/api/notes/{note['id']}",
            json={"title": "Desk board", "revision": note["revision"], "notebookId": notebook["id"], "content": content},
        )
        self.assertEqual(saved.status_code, 200)

        found = self.client.get("/api/search", params={"q": "passport"}).json()
        self.assertEqual([item["id"] for item in found], [note["id"]])
        self.assertIn("Renew the passport", found[0]["excerpt"])

        reloaded = self.client.get(f"/api/notes/{note['id']}").json()
        nodes = reloaded["content"]["nodes"]
        self.assertEqual([(n["type"], n["pn"]["type"]) for n in nodes], [("text", "sticky"), ("file", "shape"), ("text", "sticky"), ("file", "image")])
        self.assertEqual(nodes[0]["color"], "#ffd60a")
        self.assertRegex(nodes[3]["file"], r"^media/[0-9a-f]{64}\.webp$")  # the picture is a media file, not embedded

        with zipfile.ZipFile(io.BytesIO(self.client.get("/api/export/markdown").content)) as archive:
            names = archive.namelist()
            markdown = archive.read(next(name for name in names if name.endswith("desk-board.md"))).decode("utf-8")
            self.assertIn("Renew the passport", markdown)
            self.assertTrue(any(name.startswith("assets/") and name.endswith(".webp") for name in names))

    PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082")

    def upload(self, body, content_type="image/png", app_header=True):
        headers = {"Content-Type": content_type}
        if app_header:
            headers["x-personal-note"] = "1"
        return self.client.post("/api/media", content=body, headers=headers)

    def test_media_upload_stores_a_picture_once_by_content_and_serves_it(self):
        first = self.upload(self.PNG)
        self.assertEqual(first.status_code, 201)
        name = first.json()["id"]
        self.assertRegex(name, r"^[0-9a-f]{64}\.png$")
        self.assertEqual(first.json()["path"], f"media/{name}")
        self.assertEqual(self.upload(self.PNG).json()["id"], name)  # the same bytes are the same file
        served = self.client.get(f"/api/media/{name}")
        self.assertEqual(served.status_code, 200)
        self.assertEqual(served.content, self.PNG)
        self.assertIn("default-src 'none'", served.headers["content-security-policy"])  # the existing policy on media files

    def test_media_upload_refuses_what_is_not_a_picture_or_not_from_the_app(self):
        self.assertEqual(self.upload(b"<html>not a picture</html>").status_code, 400)
        self.assertEqual(self.upload(b"<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>", "image/svg+xml").status_code, 400)  # no script-capable files
        self.assertEqual(self.upload(b"").status_code, 400)
        self.assertEqual(self.upload(self.PNG, app_header=False).status_code, 403)
        self.assertEqual(self.upload(b"\x89PNG\r\n\x1a\n" + b"0" * (20 * 1024 * 1024 + 1)).status_code, 413)

    def test_an_uploaded_picture_is_a_media_reference_in_the_saved_note_and_travels_with_exports(self):
        name = self.upload(self.PNG).json()["id"]
        notebook = self.client.get("/api/notebooks").json()[0]
        note = self.client.post("/api/notes", json={"title": "Pictures", "notebookId": notebook["id"]}).json()
        canvas = {"nodes": [{"id": "n1", "type": "file", "file": f"media/{name}", "x": 10, "y": 20, "width": 100, "height": 80,
                             "pn": {"type": "image", "z": 0}}], "edges": [], "pn": {"schemaVersion": 1, "page": {"columns": 1, "rows": 1}}}
        saved = self.client.put(f"/api/notes/{note['id']}", json={"title": "Pictures", "revision": note["revision"], "notebookId": notebook["id"], "content": canvas})
        self.assertEqual(saved.status_code, 200)
        stored = self.client.get(f"/api/notes/{note['id']}").json()["content"]
        self.assertEqual(stored["nodes"][0]["file"], f"media/{name}")
        with zipfile.ZipFile(io.BytesIO(self.client.get("/api/export/vault").content)) as archive:
            self.assertTrue(any(entry.endswith(f"{name}") for entry in archive.namelist()), archive.namelist())
        backup = self.client.get("/api/export/workspace").json()
        self.assertIn("data:image/png;base64,", json.dumps(backup))


if __name__ == "__main__":
    unittest.main()
