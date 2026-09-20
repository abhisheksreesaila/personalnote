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
        self.assertEqual(backup["version"], 1)
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

        original_object_id = exported_note["content"]["objects"][0]["semanticId"]
        imported_note = self.client.get(f"/api/notes/{imported.json()['noteIds'][0]}").json()
        self.assertNotEqual(imported_note["content"]["objects"][0]["semanticId"], original_object_id)
        self.assertEqual(notebook["name"], "My Notes")

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


if __name__ == "__main__":
    unittest.main()
