"""Settings → AI (F-093): save and load, the key never leaves the keychain, validation, the header guard, the test call."""

import json
import os
import stat
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

from starlette.testclient import TestClient

import jam_brain
from ai_settings import AISettings
from routes import create_app
from secret_store import SecretStore

SECRET = "sk-test-0123456789abcdef"
H = {"x-personal-note": "1"}
AZURE = {"provider": "azure", "endpoint": "https://example.openai.azure.com", "deployment": "gpt-4o", "apiVersion": "2024-10-21"}


class FakeBrain:
    def __init__(self, error=None):
        self.error, self.seen = error, None

    def complete(self, system, user):
        self.seen = (system, user)
        if self.error:
            raise self.error
        return '{"ok": true}'


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.ai = AISettings(self.dir / "ai", SecretStore("t", "api-key", folder=self.dir / "ai"))
        self.client = TestClient(create_app(self.dir / "notes.db", ai=self.ai))

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def files_without_the_secret_file(self):
        return b"".join(p.read_bytes() for p in self.dir.rglob("*") if p.is_file() and p.suffix != ".secret")


class SettingsTests(Base):
    def test_defaults_before_anything_is_saved(self):
        view = self.client.get("/api/ai/settings").json()
        self.assertEqual({k: view[k] for k in ("provider", "claudeModel", "apiVersion", "keySaved", "endpoint", "baseUrl")},
                         {"provider": "claude-code", "claudeModel": "sonnet", "apiVersion": "2024-10-21", "keySaved": False,
                          "endpoint": "", "baseUrl": ""})
        self.assertIn(view["claudeCodeFound"], (True, False))

    def test_save_then_load_and_the_key_is_only_ever_saved(self):
        saved = self.client.post("/api/ai/settings", json={**AZURE, "apiKey": SECRET}, headers=H)
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["keySaved"], True)
        self.assertEqual(saved.json()["deployment"], "gpt-4o")
        again = self.client.get("/api/ai/settings")
        self.assertEqual((again.json()["provider"], again.json()["endpoint"], again.json()["keySaved"]),
                         ("azure", "https://example.openai.azure.com", True))
        for body in (saved.text, again.text):
            self.assertNotIn(SECRET, body)
        self.assertNotIn(SECRET.encode(), self.files_without_the_secret_file())  # not the settings file, not the database
        secret_file = self.dir / "ai" / "api-key.secret"
        self.assertEqual(secret_file.read_text(), SECRET)
        self.assertEqual(stat.S_IMODE(secret_file.stat().st_mode), 0o600)

    def test_saving_without_a_key_keeps_the_saved_key(self):
        self.client.post("/api/ai/settings", json={**AZURE, "apiKey": SECRET}, headers=H)
        view = self.client.post("/api/ai/settings", json={**AZURE, "deployment": "other"}, headers=H).json()
        self.assertEqual((view["keySaved"], view["deployment"]), (True, "other"))

    def test_org_slash_model_is_fine(self):
        view = self.client.post("/api/ai/settings", json={"provider": "openai", "baseUrl": "https://example.com/v1", "model": "org/model-1"}, headers=H).json()
        self.assertEqual(view["model"], "org/model-1")

    def test_changing_provider_or_host_drops_the_saved_key_but_a_new_key_or_the_same_host_keeps_it(self):
        self.client.post("/api/ai/settings", json={**AZURE, "apiKey": SECRET}, headers=H)
        same = self.client.post("/api/ai/settings", json={**AZURE, "deployment": "d2"}, headers=H).json()
        self.assertEqual((same["keySaved"], same["keyDropped"]), (True, False))
        moved = self.client.post("/api/ai/settings", json={**AZURE, "endpoint": "https://other.openai.azure.com"}, headers=H).json()
        self.assertEqual((moved["keySaved"], moved["keyDropped"]), (False, True))
        self.client.post("/api/ai/settings", json={**AZURE, "apiKey": SECRET}, headers=H)
        renewed = self.client.post("/api/ai/settings", json={"provider": "openai", "baseUrl": "https://example.com/v1", "model": "m", "apiKey": "new-key-1"}, headers=H).json()
        self.assertEqual((renewed["keySaved"], renewed["keyDropped"]), (True, False))
        self.assertEqual(self.ai.secret.load(), "new-key-1")

    def test_remove_key(self):
        self.client.post("/api/ai/settings", json={**AZURE, "apiKey": SECRET}, headers=H)
        removed = self.client.delete("/api/ai/key", headers=H)
        self.assertEqual((removed.status_code, removed.json()["keySaved"]), (200, False))
        self.assertFalse((self.dir / "ai" / "api-key.secret").exists())
        self.assertEqual(self.client.get("/api/ai/settings").json()["provider"], "azure")  # the other choices stay

    def test_changing_things_needs_the_app_header(self):
        for call in (lambda: self.client.post("/api/ai/settings", json={**AZURE, "apiKey": SECRET}),
                     lambda: self.client.delete("/api/ai/key"), lambda: self.client.post("/api/ai/test")):
            self.assertEqual(call().status_code, 403)
        self.assertFalse(self.ai.path.exists())
        self.assertFalse(self.ai.has_key())

    def test_bad_fields_are_refused_with_a_plain_message_and_nothing_is_saved(self):
        cases = [
            ({"provider": "gemini"}, "Pick Claude Code"),
            ({"provider": "azure", "endpoint": "http://example.com"}, "must start with https://"),
            ({"provider": "openai", "baseUrl": "https://user:pw@example.com"}, "without a login"),
            ({"provider": "azure", "deployment": "a b/../c?"}, "deployment name has characters"),
            ({"provider": "azure", "deployment": "../../x"}, "deployment name has characters"),
            ({"provider": "azure", "deployment": "org/dep"}, "deployment name has characters"),
            ({"provider": "openai", "model": "../../x"}, "model name has characters"),
            ({"provider": "openai", "model": "/etc/x"}, "model name has characters"),
            ({"provider": "openai", "model": "m" * 101}, "model name has characters"),
            ({"provider": "azure", "apiVersion": "x y"}, "API version has characters"),
            ({"provider": "claude-code", "claudeModel": "gpt"}, "sonnet, haiku or opus"),
            ({"provider": "openai", "baseUrl": 5}, "must be text"),
            ({"provider": "azure", "apiKey": "two words"}, "does not look like an API key"),
            ({"provider": "azure", "apiKey": "k" * 601}, "does not look like an API key"),
        ]
        for body, message in cases:
            with self.subTest(body=str(body)[:40]):
                response = self.client.post("/api/ai/settings", json=body, headers=H)
                self.assertEqual(response.status_code, 400)
                self.assertIn(message, response.json()["error"])
        self.assertFalse(self.ai.path.exists())
        self.assertFalse(self.ai.has_key())

    def test_plain_http_is_fine_for_this_computer(self):
        view = self.client.post("/api/ai/settings", json={"provider": "openai", "baseUrl": "http://127.0.0.1:9/v1/", "model": "m"}, headers=H).json()
        self.assertEqual(view["baseUrl"], "http://127.0.0.1:9/v1")

    def test_a_damaged_settings_file_falls_back_to_the_defaults(self):
        self.ai.folder.mkdir(parents=True)
        self.ai.path.write_text("{not json")
        self.assertEqual(self.client.get("/api/ai/settings").json()["provider"], "claude-code")

    def test_neither_the_database_nor_a_backup_nor_an_export_carry_the_key_or_the_choices(self):
        self.client.post("/api/ai/settings", json={**AZURE, "apiKey": SECRET}, headers=H)
        for path in ("/api/export/workspace", "/api/export/markdown", "/api/export/vault"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            self.assertNotIn(SECRET.encode(), response.content)
            self.assertNotIn(b"example.openai.azure.com", response.content)
        self.assertNotIn(b"example.openai.azure.com", (self.dir / "notes.db").read_bytes())


class BrainTests(Base):
    def test_brain_follows_the_settings_and_uses_the_saved_key(self):
        self.client.post("/api/ai/settings", json={**AZURE, "apiKey": SECRET}, headers=H)
        request = self.ai.brain().request_for("s", "u")
        self.assertEqual(request.full_url, "https://example.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21")
        self.assertEqual(request.get_header("Api-key"), SECRET)

    def test_the_environment_key_overrides_the_saved_one(self):
        self.client.post("/api/ai/settings", json={**AZURE, "apiKey": SECRET}, headers=H)
        with mock.patch.dict(os.environ, {jam_brain.JAM_KEY_ENV: "from-env"}):
            self.assertEqual(self.ai.brain().request_for("s", "u").get_header("Api-key"), "from-env")

    def test_claude_code_provider_uses_the_chosen_model(self):
        self.client.post("/api/ai/settings", json={"provider": "claude-code", "claudeModel": "haiku"}, headers=H)
        brain = self.ai.brain()
        self.assertEqual((type(brain).__name__, brain.model), ("ClaudeCodeBrain", "haiku"))


class TestEndpointTests(Base):
    def test_switching_to_another_service_never_sends_the_old_key(self):
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                seen.append(dict(self.headers))
                self.send_response(401)
                self.send_header("Content-Length", "0")
                self.end_headers()

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            self.client.post("/api/ai/settings", json={**AZURE, "apiKey": SECRET}, headers=H)
            self.client.post("/api/ai/settings", json={"provider": "openai", "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "model": "m"}, headers=H)
            body = self.client.post("/api/ai/test", headers=H).json()
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(body, {"ok": False, "error": "No API key: add one in Settings → AI, or set the PERSONAL_NOTE_JAM_API_KEY environment variable."})
        self.assertEqual(seen, [])

    def test_ok_returns_the_seconds_and_sends_one_tiny_prompt(self):
        fake = FakeBrain()
        with mock.patch.object(self.ai, "brain", lambda timeout=90: fake):
            body = self.client.post("/api/ai/test", headers=H).json()
        self.assertEqual(body["ok"], True)
        self.assertIsInstance(body["seconds"], float)
        self.assertEqual(fake.seen[1], "ping")
        self.assertIn("JSON", fake.seen[0])  # Azure refuses json mode when the word JSON is nowhere in the messages

    def test_a_failure_is_the_brains_own_plain_message(self):
        fake = FakeBrain(jam_brain.BrainUnavailable("The model service refused the request (HTTP 401)."))
        with mock.patch.object(self.ai, "brain", lambda timeout=90: fake):
            body = self.client.post("/api/ai/test", headers=H).json()
        self.assertEqual(body, {"ok": False, "error": "The model service refused the request (HTTP 401)."})

    def test_not_set_up_yet_says_what_is_missing(self):
        self.client.post("/api/ai/settings", json={"provider": "azure"}, headers=H)
        self.assertEqual(self.client.post("/api/ai/test", headers=H).json(),
                         {"ok": False, "error": "Set a base URL and model, or an Azure endpoint and deployment, for this brain."})

    def test_a_real_call_to_a_loopback_server_carries_the_saved_key_and_never_returns_it(self):
        seen = {}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                seen["key"] = self.headers.get("api-key")
                seen["path"] = self.path
                self.rfile.read(int(self.headers["Content-Length"]))
                data = json.dumps({"choices": [{"message": {"content": "{\"ok\": true}"}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            self.client.post("/api/ai/settings", json={**AZURE, "endpoint": f"http://127.0.0.1:{server.server_port}", "apiKey": SECRET}, headers=H)
            response = self.client.post("/api/ai/test", headers=H)
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(response.json()["ok"], True)
        self.assertNotIn(SECRET, response.text)
        self.assertEqual(seen["key"], SECRET)
        self.assertEqual(seen["path"], "/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21")


if __name__ == "__main__":
    unittest.main()
