import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from starlette.testclient import TestClient

from intelligence_client import enrichment_timeout
from routes import create_app


class ApiContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        database_path = Path(self.temporary_directory.name) / "personal-note.db"
        self.app = create_app(database_path, intelligence_url="")
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.temporary_directory.cleanup()

    def workspace_request(self, body: dict, authenticated: bool = True):
        headers = (
            {"Authorization": f"Bearer {self.app.state.workspace_token}"}
            if authenticated
            else {}
        )
        return self.client.post("/api/workspace/v1", json=body, headers=headers)

    def test_workspace_protocol_discovers_queries_and_gets_grounded_blocks(self):
        fixtures = json.loads(
            (Path(__file__).parent / "fixtures" / "workspace_protocol.json").read_text(
                encoding="utf-8"
            )
        )
        unauthorized = self.workspace_request(fixtures["describeRequest"], False)
        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(unauthorized.json()["error"]["code"], "authentication_required")

        description_response = self.workspace_request(fixtures["describeRequest"])
        self.assertEqual(description_response.status_code, 200)
        description = description_response.json()["result"]
        self.assertEqual(description["operations"], [
            "workspace.describe", "resource.get", "workspace.query"
        ])
        self.assertEqual(description["scopes"], ["workspace:read"])

        notebook = self.client.get("/api/notebooks").json()[0]
        note = self.client.post(
            "/api/notes", json={"title": "Launch notes", "notebookId": notebook["id"]}
        ).json()
        text_blocks = [
            {"type": "IText", "text": "🚀 Maya preferred September for the partner event.", "left": 72, "top": 80},
            {"type": "IText", "text": "The partner event needs a revised launch brief.", "left": 72, "top": 140},
        ]
        update = self.client.put(
            f"/api/notes/{note['id']}",
            json={
                "title": "Launch notes",
                "notebookId": notebook["id"],
                "revision": note["revision"],
                "content": {"objects": text_blocks},
                "pageState": {"columns": 1, "rows": 1},
            },
        )
        self.assertEqual(update.status_code, 200)
        self.assertEqual(update.json()["revision"], note["revision"] + 1)

        stale = self.client.put(
            f"/api/notes/{note['id']}",
            json={
                "title": "Stale title",
                "revision": note["revision"],
                "content": {"objects": text_blocks},
            },
        )
        self.assertEqual(stale.status_code, 409)

        query_request = fixtures["queryRequest"] | {
            "input": {"query": "partner event", "limit": 1}
        }
        first_page = self.workspace_request(query_request)
        self.assertEqual(first_page.status_code, 200)
        first_result = first_page.json()["result"]
        self.assertEqual(len(first_result["items"]), 1)
        self.assertIsNotNone(first_result["nextCursor"])
        first_item = first_result["items"][0]
        source_ref = first_item["sourceRefs"][0]
        expected_hash = hashlib.sha256(source_ref["excerpt"].encode("utf-8")).hexdigest()
        self.assertEqual(source_ref["valueHash"], f"sha256:{expected_hash}")
        span_length = source_ref["textSpan"]["end"] - source_ref["textSpan"]["start"]
        self.assertEqual(span_length, len(source_ref["excerpt"].encode("utf-16-le")) // 2)

        second_page = self.workspace_request(
            query_request | {
                "requestId": "req_query_next",
                "input": {
                    "query": "partner event",
                    "limit": 1,
                    "cursor": first_result["nextCursor"],
                },
            }
        ).json()["result"]
        self.assertEqual(len(second_page["items"]), 1)
        self.assertNotEqual(
            first_item["resource"]["id"], second_page["items"][0]["resource"]["id"]
        )

        resource_response = self.workspace_request({
            "protocolVersion": "1",
            "requestId": "req_resource",
            "operation": "resource.get",
            "input": {"id": first_item["resource"]["id"]},
        })
        resource = resource_response.json()["result"]["resource"]
        self.assertEqual(resource["kind"], "block")
        self.assertEqual(resource["data"]["blockKind"], "text")
        self.assertIn("partner event", resource["data"]["text"])
        self.assertNotIn("objects", resource_response.text)

        with self.app.state.note_service.connection() as connection:
            changes = connection.execute(
                "SELECT change_type, revision FROM workspace_changes WHERE resource_id = ? ORDER BY sequence",
                (note["resourceId"],),
            ).fetchall()
        self.assertEqual(
            [(row["change_type"], row["revision"]) for row in changes],
            [("created", 1), ("updated", 2)],
        )

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
        self.assertEqual(self.client.get("/api/search", params={"q": "partner event"}).json(), [])

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

    def test_enrichment_timeout_is_bounded_and_tolerates_invalid_values(self):
        with patch.dict("os.environ", {"INTELLIGENCE_ENRICH_TIMEOUT": "invalid"}):
            self.assertEqual(enrichment_timeout(), 4.0)
        with patch.dict("os.environ", {"INTELLIGENCE_ENRICH_TIMEOUT": "99"}):
            self.assertEqual(enrichment_timeout(), 10.0)

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

        with patch(
            "routes.enrich_related_note",
            new=AsyncMock(side_effect=AssertionError("fast lane called the worker")),
        ):
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
        timing = response.json()["timing"]
        self.assertGreaterEqual(timing["retrievalMs"], 0)
        self.assertGreaterEqual(timing["enrichmentMs"], 0)
        self.assertGreaterEqual(timing["serverMs"], timing["retrievalMs"])
        self.assertEqual(timing["mode"], "local-retrieval")
        self.assertIn("retrieval;dur=", response.headers["server-timing"])

        enriched = self.client.post(
            "/api/intelligence/related/enrich",
            json={"noteId": active["id"], "text": "Talk to Maya about moving the launch to October."},
        )
        self.assertEqual(enriched.status_code, 200)
        self.assertEqual(enriched.json()["suggestion"]["noteId"], source["id"])
        self.assertEqual(enriched.json()["timing"]["mode"], "local-retrieval")

        entities = self.client.post(
            "/api/intelligence/entities",
            json={"noteId": active["id"], "text": "Talk to Maya about moving the launch."},
        ).json()
        self.assertEqual(entities["people"][0]["name"], "Maya")
        self.assertEqual(entities["people"][0]["sourceCount"], 1)
        self.assertEqual(entities["people"][0]["sources"][0]["noteId"], source["id"])
        self.assertIn("Maya preferred", entities["people"][0]["sources"][0]["context"])


    def test_page_scan_unifies_calendar_people_and_related(self):
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
            "/api/intelligence/scan",
            json={
                "noteId": active["id"],
                "text": "Talk to Maya about moving the launch to October. schedule something at 9 AM",
                "segments": [
                    "Talk to Maya about moving the launch to October.",
                    "schedule something at 9 AM",
                ],
                "focusSegments": ["schedule something at 9 AM"],
                "textObjectCount": 2,
                "focusedTextCount": 1,
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        scan = payload["scan"]
        self.assertEqual(scan["related"]["noteId"], source["id"])
        self.assertEqual(scan["people"][0]["name"], "Maya")
        self.assertTrue(scan["calendarDrafts"])
        self.assertTrue(scan["calendarDrafts"][0]["priority"])
        self.assertTrue(scan["actions"]["canTidy"])
        self.assertIn("retrieval;dur=", response.headers["server-timing"])


if __name__ == "__main__":
    unittest.main()