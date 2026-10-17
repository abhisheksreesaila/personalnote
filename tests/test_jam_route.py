"""Jam sessions (F-092): POST /api/jam/turn. One brain call per turn, off the event loop, one at a time; the plugin and
header guards; plain words for every failure; the map is never touched by the server."""

import json
import tempfile
import threading
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from jam_brain import BrainNotSetUp, BrainUnavailable
from plugin_settings import PluginSettings
from routes import create_app

H = {"x-personal-note": "1"}
MAP = {"version": 1, "title": "Pet shop", "rootId": "root", "nodes": [
    {"id": "root", "parentId": None, "text": "Pet shop"}, {"id": "a", "parentId": "root", "text": "Customers"}]}
ANSWER = {"edits": [
    {"op": "add_branch", "parent_id": "a", "text": "Dog owners", "emoji": "🐕", "id": "n1"},
    {"op": "react", "node_id": "a", "vote": "up", "reason": "Clear first audience"},
    {"op": "ghost", "parent_id": "root", "text": "Delivery", "why": "Heavy food is a pain to carry"}]}


class FakeBrain:
    def __init__(self, answer=ANSWER, error=None, gate=None):
        self.answer, self.error, self.gate, self.seen, self.thread = answer, error, gate, [], None

    def complete(self, system, user):
        self.seen.append(user)
        self.thread = threading.current_thread()
        if self.gate:
            self.gate.wait(5)
        if self.error:
            raise self.error
        return json.dumps(self.answer)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.plugins = PluginSettings(self.dir / "plugins")
        self.plugins.set_enabled("jam", True)
        self.brain = FakeBrain()
        self.client = TestClient(create_app(self.dir / "notes.db", plugins=self.plugins, brain=lambda: self.brain))

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def turn(self, **body):
        return self.client.post("/api/jam/turn", json={"map": MAP, "transcript": "we sell to dog owners", **body}, headers=H)


class TurnTests(Base):
    def test_a_turn_answers_with_the_edits_in_page_words(self):
        response = self.turn(ghosts=["Loyalty card"])
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["edits"], [
            {"op": "add_branch", "parentId": "a", "text": "Dog owners", "emoji": "🐕", "id": "n1"},
            {"op": "react", "nodeId": "a", "vote": "up", "reason": "Clear first audience"},
            {"op": "ghost", "parentId": "root", "text": "Delivery", "why": "Heavy food is a pain to carry"}])
        self.assertIn("Loyalty card", self.brain.seen[0])  # the waiting ghost is not offered twice
        self.assertIn("we sell to dog owners", self.brain.seen[0])

    def test_the_brain_runs_off_the_event_loop(self):
        self.turn()
        self.assertNotEqual(self.brain.thread, threading.main_thread())

    def test_the_server_does_not_touch_the_map(self):
        before = json.dumps(MAP)
        self.turn()
        self.assertEqual(json.dumps(MAP), before)
        self.assertEqual(self.client.get("/api/notes").json(), [])


class GuardTests(Base):
    def test_a_page_other_than_ours_is_refused(self):
        response = self.client.post("/api/jam/turn", json={"map": MAP, "transcript": "hi"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.brain.seen, [])

    def test_off_by_default_and_the_reason_is_plain(self):
        self.plugins.set_enabled("jam", False)
        response = self.turn()
        self.assertEqual((response.status_code, response.json()),
                         (409, {"error": "Jam sessions is switched off. Turn it on in Settings → Plugins."}))
        self.assertEqual(self.brain.seen, [])

    def test_mind_maps_off_means_no_jam(self):
        self.plugins.set_enabled("mindmap", False)
        self.assertEqual(self.turn().status_code, 409)
        self.assertEqual(self.brain.seen, [])

    def test_bad_requests_are_400_and_never_reach_the_brain(self):
        for body in ({"map": "x", "transcript": "hi"}, {"map": {"nodes": "x"}, "transcript": "hi"},
                     {"map": MAP, "transcript": 5}, {"map": MAP, "transcript": "   "},
                     {"map": MAP, "transcript": "hi", "ghosts": "x"}, {"map": MAP, "transcript": "x" * 6001},
                     {"map": {"nodes": [{"id": 1}]}, "transcript": "hi"}):
            response = self.client.post("/api/jam/turn", json=body, headers=H)
            self.assertEqual(response.status_code, 400, body)
            self.assertIn("error", response.json())
        self.assertEqual(self.brain.seen, [])


class FailureTests(Base):
    def test_no_brain_set_up_points_at_settings(self):
        self.brain.error = BrainNotSetUp("Claude Code is not installed here. Install it and sign in, or pick another brain in Settings.")
        response = self.turn()
        self.assertEqual((response.status_code, response.json()),
                         (409, {"error": "Claude Code is not installed here. Install it and sign in, or pick another brain in Settings.", "setup": True}))

    def test_a_brain_that_fails_says_so_plainly(self):
        self.brain.error = BrainUnavailable("Claude Code took longer than 90 seconds; try again.")
        response = self.turn()
        self.assertEqual((response.status_code, response.json()), (502, {"error": "Claude Code took longer than 90 seconds; try again."}))

    def test_a_removal_is_refused_and_the_page_hears_why(self):
        self.brain.answer = {"edits": [{"op": "remove", "node_id": "a"}]}
        response = self.turn()
        self.assertEqual(response.status_code, 502)
        self.assertIn("not allowed", response.json()["error"])

    def test_a_brain_not_built_yet_is_no_brain_set_up(self):
        def unset():
            raise BrainNotSetUp("Set a base URL and model, or an Azure endpoint and deployment, for this brain.")
        client = TestClient(create_app(self.dir / "two.db", plugins=self.plugins, brain=unset))
        response = client.post("/api/jam/turn", json={"map": MAP, "transcript": "hi"}, headers=H)
        self.assertEqual((response.status_code, response.json()["setup"]), (409, True))
        client.close()


class OneAtATimeTests(Base):
    def test_a_second_turn_while_one_is_out_is_refused_then_allowed(self):
        gate = threading.Event()
        self.brain.gate = gate
        first = {}
        worker = threading.Thread(target=lambda: first.update(r=self.turn()))
        worker.start()
        for _ in range(100):
            if self.brain.seen:
                break
            threading.Event().wait(0.02)
        second = self.turn()
        self.assertEqual((second.status_code, second.json().get("busy")), (409, True))
        gate.set()
        worker.join(5)
        self.assertEqual(first["r"].status_code, 200)
        self.assertEqual(self.turn().status_code, 200)
        self.assertEqual(len(self.brain.seen), 2)


if __name__ == "__main__":
    unittest.main()
