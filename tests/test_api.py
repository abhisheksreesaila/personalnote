import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from starlette.testclient import TestClient

from routes import create_app


class ApiContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        database_path = Path(self.temporary_directory.name) / "personal-note.db"
        self.client = TestClient(create_app(database_path, intelligence_url=""))

    def tearDown(self):
        self.client.close()
        self.temporary_directory.cleanup()

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
                "content": {"objects": [{"type": "IText", "text": "Maya preferred September for the partner event"}]},
                "pageState": {"columns": 1, "rows": 1},
            },
        )
        self.assertEqual(update_response.status_code, 200)

        search = self.client.get("/api/search", params={"q": "partner event"}).json()
        self.assertEqual(search[0]["id"], note["id"])
        self.assertIn("Maya preferred September", search[0]["excerpt"])

        delete_response = self.client.delete(f"/api/notes/{note['id']}")
        self.assertEqual(delete_response.status_code, 204)
        self.assertEqual(self.client.get(f"/api/notes/{note['id']}").status_code, 404)

    def test_settings_capabilities_never_expose_secrets(self):
        configured_environment = {
            "GOOGLE_CLIENT_ID": "google-client-id",
            "GOOGLE_CLIENT_SECRET": "google-client-secret",
            "SESSION_SECRET": "session-secret",
            "PERSONAL_NOTE_MODEL": "small-model",
            "PERSONAL_NOTE_MODEL_KEY": "provider-secret",
        }
        with patch.dict("os.environ", configured_environment, clear=False):
            response = self.client.get("/api/settings/capabilities")

        self.assertEqual(response.status_code, 200)
        capabilities = response.json()
        self.assertEqual(capabilities["authentication"]["mode"], "development-bypass")
        self.assertTrue(capabilities["authentication"]["configured"])
        self.assertEqual(capabilities["intelligence"]["framework"], "mastra")
        self.assertEqual(capabilities["intelligence"]["provider"], "openai-compatible")
        self.assertTrue(capabilities["intelligence"]["credentialsConfigured"])
        self.assertEqual(capabilities["storage"]["engine"], "sqlite")
        serialized = response.text
        self.assertNotIn("google-client-secret", serialized)
        self.assertNotIn("session-secret", serialized)
        self.assertNotIn("provider-secret", serialized)

    def test_related_note_is_grounded_and_excludes_active_note(self):
        notebook = self.client.get("/api/notebooks").json()[0]
        source = self.client.post(
            "/api/notes",
            json={"title": "Launch timing", "notebookId": notebook["id"]},
        ).json()
        self.client.put(
            f"/api/notes/{source['id']}",
            json={
                "title": "Launch timing",
                "notebookId": notebook["id"],
                "content": {"objects": [{"type": "IText", "text": "Maya preferred a September launch because of the partner event."}]},
                "pageState": {"columns": 1, "rows": 1},
            },
        )
        active = self.client.post(
            "/api/notes",
            json={"title": "October option", "notebookId": notebook["id"]},
        ).json()

        response = self.client.post(
            "/api/intelligence/related",
            json={"noteId": active["id"], "text": "Talk to Maya about moving the launch to October."},
        )

        self.assertEqual(response.status_code, 200)
        suggestion = response.json()["suggestion"]
        self.assertEqual(suggestion["noteId"], source["id"])
        self.assertNotEqual(suggestion["noteId"], active["id"])
        self.assertIn("September launch", suggestion["excerpt"])
        self.assertEqual(suggestion["mode"], "local-retrieval")


if __name__ == "__main__":
    unittest.main()