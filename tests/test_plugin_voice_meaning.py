"""Voice and Search by meaning as built-in plugins (F-091): off starts nothing, answers plainly and keeps the data; on again needs no restart."""

import contextlib
import io
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from starlette.testclient import TestClient

import personal_note_cli
from plugin_settings import PluginSettings
from routes import create_app
from tests.test_meaning_index import FakeEngine, vector_of

H = {"x-personal-note": "1"}
OFF_MEANING = "Search by meaning is switched off. Turn it on in Settings → Plugins."
OFF_VOICE = "Voice is switched off. Turn it on in Settings → Plugins."


class Engine(FakeEngine):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.stops = 0
        self.installs = 0

    def stop_engine(self):
        self.stops += 1

    def start_install(self):
        self.installs += 1
        return {"state": "downloading"}

    def cancel_install(self):
        return {"state": "not-installed"}


class Voice:
    """The part of VoiceRuntime the routes use."""

    def __init__(self):
        self.stops = 0
        self.installs = 0
        self.engines = 0
        self.cancels = 0

    def status(self):
        return {"state": "ready"}

    def start_install(self):
        self.installs += 1
        return {"state": "downloading"}

    def start_engine(self):
        self.engines += 1
        return {"state": "ready", "endpoint": "ws://127.0.0.1:1/x"}

    def cancel_install(self):
        self.cancels += 1
        return {"state": "not-installed"}

    def stop_engine(self):
        self.stops += 1


def indexer_threads():
    return [thread for thread in threading.enumerate() if thread.name == "meaning-index" and thread.is_alive()]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.settings = PluginSettings(self.dir / "plugins")
        self.engine, self.voice = Engine(), Voice()
        self.apps = []

    def tearDown(self):
        for app in self.apps:
            app.state.indexer.stop()
        self.tmp.cleanup()

    def start(self):
        app = create_app(self.dir / "notes.db", search=self.engine, voice=self.voice, plugins=self.settings)
        self.apps.append(app)
        return app, TestClient(app)

    def switch(self, client, plugin, on):
        return client.post(f"/api/plugins/{plugin}", json={"enabled": on}, headers=H)


class SettingsTests(Base):
    def test_all_three_are_on_until_switched_off(self):
        self.assertEqual(self.settings.view(), {"mindmap": True, "voice": True, "meaning": True, "jam": False})

    def test_the_choice_is_remembered(self):
        self.settings.set_enabled("voice", False)
        self.assertEqual(PluginSettings(self.dir / "plugins").view(), {"mindmap": True, "voice": False, "meaning": True, "jam": False})


class MeaningOffTests(Base):
    def test_on_the_indexer_thread_runs(self):
        before = len(indexer_threads())
        self.start()
        self.assertEqual(len(indexer_threads()), before + 1)

    def test_off_at_startup_no_indexer_thread_starts(self):
        before = len(indexer_threads())
        self.settings.set_enabled("meaning", False)
        self.start()
        self.assertEqual(len(indexer_threads()), before)

    def test_switching_off_stops_the_thread_and_the_engine(self):
        _, client = self.start()
        before = len(indexer_threads())
        self.assertEqual(self.switch(client, "meaning", False).json()["plugins"]["meaning"], False)
        self.assertEqual((len(indexer_threads()), self.engine.stops), (before - 1, 1))

    def test_switching_on_again_starts_the_thread_without_a_restart(self):
        _, client = self.start()
        self.switch(client, "meaning", False)
        before = len(indexer_threads())
        self.switch(client, "meaning", True)
        self.assertEqual(len(indexer_threads()), before + 1)

    def test_the_route_answers_an_empty_list_and_never_asks_the_engine(self):
        _, client = self.start()
        self.switch(client, "meaning", False)
        self.assertEqual(client.get("/api/search/meaning", params={"q": "tired woke slept"}).json(), [])
        self.assertEqual(self.engine.queries, [])

    def test_strict_says_why_in_plain_words(self):
        _, client = self.start()
        self.switch(client, "meaning", False)
        response = client.get("/api/search/meaning", params={"q": "tired", "strict": 1})
        self.assertEqual((response.status_code, response.json()), (409, {"error": OFF_MEANING}))

    def test_no_download_while_off(self):
        _, client = self.start()
        self.switch(client, "meaning", False)
        response = client.post("/api/search-meaning/install", headers=H)
        self.assertEqual((response.status_code, response.json(), self.engine.installs), (409, {"error": OFF_MEANING}, 0))

    def test_the_vectors_are_kept_and_work_again_when_switched_on(self):
        app, client = self.start()
        service = app.state.note_service
        note = service.create_note({"title": "Sleep log", "noteType": "page"})
        service.update_note(note["id"], {"title": "Sleep log", "content": {"markdown": "tired woke slept badly early", "ink": {"marks": [], "drawings": []}}, "revision": note["revision"]})
        work = service.meaning_work(self.engine.model_id, 0, 4)
        service.store_meaning(self.engine.model_id, [(item, vector_of(f"{item['title']} {item['text']}")) for item in work])
        self.switch(client, "meaning", False)
        self.assertEqual(service.meaning_counts(self.engine.model_id)["indexed"], 1)
        self.switch(client, "meaning", True)
        found = client.get("/api/search/meaning", params={"q": "tired woke slept badly early"}).json()
        self.assertEqual([item["title"] for item in found], ["Sleep log"])


class SwitchDoesNotStallTheApp(Base):
    def test_a_note_saves_promptly_while_a_slow_switch_off_is_in_progress(self):
        import threading
        import time

        app, _ = self.start()
        real_stop = app.state.indexer.stop
        app.state.indexer.stop = lambda: (time.sleep(1.5), real_stop())  # a batch in flight that takes a while to finish
        with TestClient(app) as client:  # one event loop for every request, as in the real server
            switching = threading.Thread(target=lambda: self.switch(client, "meaning", False))
            switching.start()
            time.sleep(0.3)
            began = time.monotonic()
            saved = client.post("/api/notes", json={"title": "Saved while switching"})
            took = time.monotonic() - began
            switching.join(10)
        self.assertEqual(saved.status_code, 201)
        self.assertLess(took, 0.8)


class MeaningCliTests(Base):
    def run_cli(self, *arguments):
        output = io.StringIO()
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_PLUGINS_DIR": str(self.dir / "plugins")}), \
                mock.patch.object(personal_note_cli, "search_engine", side_effect=AssertionError("no engine while off")), \
                mock.patch.object(personal_note_cli, "running_app", side_effect=AssertionError("no app call while off")), \
                contextlib.redirect_stdout(output):
            code = personal_note_cli.main(["--database", str(self.dir / "cli.db"), *arguments])
        return code, json.loads(output.getvalue())

    def test_search_meaning_while_off_exits_2_with_the_reason(self):
        self.settings.set_enabled("meaning", False)
        self.assertEqual(self.run_cli("search", "--meaning", "tired"), (2, {"ok": False, "error": OFF_MEANING}))


class VoiceOffTests(Base):
    def test_capabilities_follow_the_switch(self):
        _, client = self.start()
        self.assertTrue(client.get("/api/settings/capabilities").json()["modules"]["voice"]["available"])
        self.switch(client, "voice", False)
        self.assertFalse(client.get("/api/settings/capabilities").json()["modules"]["voice"]["available"])

    def test_switching_off_stops_the_engine_and_cancels_a_download(self):
        _, client = self.start()
        self.switch(client, "voice", False)
        self.assertEqual((self.voice.stops, self.voice.cancels), (1, 1))

    def test_nothing_is_started_or_downloaded_while_off(self):
        _, client = self.start()
        self.switch(client, "voice", False)
        install = client.post("/api/voice/install", headers=H)
        engine = client.post("/api/voice/engine/start", headers=H)
        self.assertEqual([(r.status_code, r.json()) for r in (install, engine)], [(409, {"error": OFF_VOICE})] * 2)
        self.assertEqual((self.voice.installs, self.voice.engines), (0, 0))

    def test_on_again_starts_the_engine_lazily(self):
        _, client = self.start()
        self.switch(client, "voice", False)
        self.switch(client, "voice", True)
        self.assertEqual(client.post("/api/voice/engine/start", headers=H).status_code, 200)
        self.assertEqual(self.voice.engines, 1)

    def test_the_status_is_still_readable_while_off(self):
        _, client = self.start()
        self.switch(client, "voice", False)
        self.assertEqual(client.get("/api/voice/status").json(), {"state": "ready"})


if __name__ == "__main__":
    unittest.main()
