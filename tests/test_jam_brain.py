"""Jam brain (F-086): validation of what a brain proposes, the two adapters, and finding `claude` on a bare PATH."""

import copy
import json
import os
import stat
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

import jam_brain
from jam_brain import (AddBranch, ClaudeCodeBrain, Ghost, JamError, OpenAICompatibleBrain, React, find_claude,
                       propose)

MAP = {
    "version": 1,
    "title": "Pet shop app",
    "rootId": "root",
    "nodes": [
        {"id": "root", "parentId": None, "text": "Pet shop app"},
        {"id": "a", "parentId": "root", "text": "Customers"},
    ],
}


class FakeBrain:
    def __init__(self, answer):
        self.answer, self.seen = answer, None

    def complete(self, system, user):
        self.seen = (system, user)
        return self.answer if isinstance(self.answer, str) else json.dumps(self.answer)


def run(edits, **kw):
    return propose(copy.deepcopy(MAP), kw.get("said", "we sell to dog owners"), FakeBrain({"edits": edits}))


class ValidationTests(unittest.TestCase):
    def test_good_answer_becomes_typed_edits(self):
        result = run([
            {"op": "add_branch", "parent_id": "a", "text": "Dog owners", "emoji": "🐕", "id": "n1"},
            {"op": "add_branch", "parent_id": "n1", "text": "Weekend walkers"},
            {"op": "react", "node_id": "a", "vote": "up", "reason": "Clear first audience"},
            {"op": "ghost", "parent_id": "root", "text": "Delivery", "why": "Owners hate carrying heavy food"},
        ])
        self.assertEqual(result.edits, [
            AddBranch("a", "Dog owners", "🐕", "n1"),
            AddBranch("n1", "Weekend walkers", "", ""),
            React("a", "up", "Clear first audience"),
            Ghost("root", "Delivery", "Owners hate carrying heavy food"),
        ])

    def test_prompt_carries_the_map_and_the_words_and_teaches_buzan(self):
        brain = FakeBrain({"edits": []})
        propose(MAP, "we sell to dog owners", brain)
        system, user = brain.seen
        self.assertIn("Customers", user)
        self.assertIn("we sell to dog owners", user)
        self.assertIn("Never remove, rename or move", system)
        self.assertIn("JSON only", system)

    def test_fenced_or_chatty_json_is_accepted(self):
        text = 'Sure!\n```json\n{"edits": [{"op": "ghost", "parent_id": "root", "text": "Pricing", "why": "Not yet said"}]}\n```'
        result = propose(MAP, "hi", FakeBrain(text))
        self.assertEqual(result.edits, [Ghost("root", "Pricing", "Not yet said")])

    def assertRejected(self, edits, message):
        with self.assertRaises(JamError) as caught:
            run(edits)
        self.assertIn(message, str(caught.exception))

    def test_removing_renaming_or_moving_is_refused(self):
        for op in ("delete", "remove", "rename", "move", "update"):
            self.assertRejected([{"op": op, "node_id": "a", "text": "x"}], f'tried "{op}"')

    def test_unknown_ids_are_refused(self):
        self.assertRejected([{"op": "add_branch", "parent_id": "zzz", "text": "Dogs"}], "unknown node ('zzz')")
        self.assertRejected([{"op": "react", "node_id": "zzz", "vote": "up", "reason": "ok"}], "unknown node ('zzz')")
        self.assertRejected([{"op": "ghost", "parent_id": "zzz", "text": "Dogs", "why": "ok"}], "unknown node ('zzz')")

    def test_new_branch_cannot_reuse_an_existing_id(self):
        self.assertRejected([{"op": "add_branch", "parent_id": "root", "text": "Dogs", "id": "a"}], "reused the id 'a'")

    def test_a_branch_cannot_hang_on_an_id_that_comes_later(self):
        self.assertRejected([
            {"op": "add_branch", "parent_id": "n1", "text": "Dogs"},
            {"op": "add_branch", "parent_id": "root", "text": "Cats", "id": "n1"},
        ], "unknown node ('n1')")

    def test_over_long_text_is_refused(self):
        self.assertRejected([{"op": "add_branch", "parent_id": "a", "text": "one two three four five"}], "longer than 4 words")
        self.assertRejected([{"op": "add_branch", "parent_id": "a", "text": "x" * 41}], "too long")
        self.assertRejected([{"op": "react", "node_id": "a", "vote": "up", "reason": "r" * 81}], "reaction reason that is too long")

    def test_bad_vote_is_refused(self):
        self.assertRejected([{"op": "react", "node_id": "a", "vote": "meh", "reason": "ok"}], '"up" or "down"')

    def test_too_many_edits_and_ghosts_are_refused(self):
        many = [{"op": "add_branch", "parent_id": "a", "text": f"idea {i}"} for i in range(13)]
        self.assertRejected(many, "13 edits; at most 12")
        ghosts = [{"op": "ghost", "parent_id": "a", "text": f"idea {i}", "why": "maybe"} for i in range(4)]
        self.assertRejected(ghosts, "more than 3 suggestions")

    def test_twelve_edits_are_fine(self):
        run([{"op": "add_branch", "parent_id": "a", "text": f"idea {i}"} for i in range(12)])

    def test_not_json_is_a_plain_error_and_the_map_is_untouched(self):
        before = copy.deepcopy(MAP)
        with self.assertRaises(JamError) as caught:
            propose(MAP, "hi", FakeBrain("I think you should add dogs."))
        self.assertEqual(str(caught.exception), "The brain did not answer with map edits (it did not return JSON).")
        self.assertEqual(MAP, before)

    def test_missing_edit_list_and_empty_transcript(self):
        with self.assertRaises(JamError):
            propose(MAP, "hi", FakeBrain({"nodes": []}))
        with self.assertRaises(JamError) as caught:
            propose(MAP, "   ", FakeBrain({"edits": []}))
        self.assertIn("say something first", str(caught.exception))

    def test_one_bad_edit_rejects_the_whole_answer(self):
        with self.assertRaises(JamError):
            run([{"op": "add_branch", "parent_id": "a", "text": "Fine"}, {"op": "delete", "node_id": "a"}])


def fake_claude(directory, body):
    path = Path(directory) / "claude"
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


class ClaudeCodeTests(unittest.TestCase):
    def test_runs_print_mode_without_tools_and_reads_the_result_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "args.txt"
            fake_claude(tmp, f'echo "$@" > {log}; cat > {log}.stdin; '
                             'echo \'{"is_error": false, "result": "{\\"edits\\": []}"}\'')
            brain = ClaudeCodeBrain(extra_dirs=[tmp])
            with mock.patch("shutil.which", return_value=None):
                self.assertEqual(brain.complete("SYS", "USER TEXT"), '{"edits": []}')
            args = log.read_text()
            self.assertIn("-p --output-format json --tools  --no-session-persistence", args)
            self.assertIn("--system-prompt SYS", args)
            self.assertEqual(Path(str(log) + ".stdin").read_text(), "USER TEXT")

    def test_error_result_and_timeout_and_missing_are_plain_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_claude(tmp, 'echo \'{"is_error": true, "result": "Not logged in"}\'; exit 1')
            with mock.patch("shutil.which", return_value=None), self.assertRaises(JamError) as caught:
                ClaudeCodeBrain(extra_dirs=[tmp]).complete("s", "u")
            self.assertEqual(str(caught.exception), "Claude Code did not answer: Not logged in")
            fake_claude(tmp, "sleep 5")
            with mock.patch("shutil.which", return_value=None), self.assertRaises(JamError) as caught:
                ClaudeCodeBrain(timeout=0.3, extra_dirs=[tmp]).complete("s", "u")
            self.assertIn("took longer than 0 seconds", str(caught.exception))
        with mock.patch("jam_brain.find_claude", return_value=None), self.assertRaises(JamError) as caught:
            ClaudeCodeBrain().complete("s", "u")
        self.assertIn("Claude Code is not installed", str(caught.exception))

    def test_finds_claude_outside_a_bare_path(self):
        with tempfile.TemporaryDirectory() as home:
            local_bin = Path(home) / ".local" / "bin"
            local_bin.mkdir(parents=True)
            installed = fake_claude(local_bin, "")
            with mock.patch("shutil.which", return_value=None), mock.patch.dict(os.environ, {"HOME": home}):
                self.assertEqual(find_claude(), str(installed))
            mise = Path(home) / ".local" / "share" / "mise" / "installs" / "node" / "22" / "bin"
            mise.mkdir(parents=True)
            installed.unlink()
            mise_claude = fake_claude(mise, "")
            with mock.patch("shutil.which", return_value=None), mock.patch.dict(os.environ, {"HOME": home}):
                found = find_claude()
            # A machine-wide install (/usr/local/bin, /opt/homebrew/bin) may legitimately win on a dev box.
            self.assertIn(found, (str(mise_claude), "/usr/local/bin/claude", "/opt/homebrew/bin/claude"))

    def test_path_hit_wins(self):
        with mock.patch("shutil.which", return_value="/somewhere/claude"):
            self.assertEqual(find_claude(), "/somewhere/claude")


class FakeEndpoint(BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeEndpoint.seen.append((self.path, {k.lower(): v for k, v in self.headers.items()}, body))
        status, payload = (401, {"error": "bad key"}) if self.headers.get("api-key") == "wrong" else (
            200, {"choices": [{"message": {"content": '{"edits": []}'}}]})
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class OpenAICompatibleTests(unittest.TestCase):
    def setUp(self):
        FakeEndpoint.seen = []
        self.server = HTTPServer(("127.0.0.1", 0), FakeEndpoint)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def test_plain_endpoint_shape(self):
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_JAM_API_KEY": "sk-test"}):
            out = OpenAICompatibleBrain(self.url + "/v1", "gpt-x").complete("SYS", "USER")
        self.assertEqual(out, '{"edits": []}')
        path, headers, body = FakeEndpoint.seen[0]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual(headers["authorization"], "Bearer sk-test")
        self.assertEqual(body["model"], "gpt-x")
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual(body["messages"], [{"role": "system", "content": "SYS"}, {"role": "user", "content": "USER"}])

    def test_azure_shape(self):
        brain = OpenAICompatibleBrain(azure_endpoint=self.url, deployment="jam1", api_version="2024-10-21")
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_JAM_API_KEY": "az-key"}):
            brain.complete("SYS", "USER")
        path, headers, body = FakeEndpoint.seen[0]
        self.assertEqual(path, "/openai/deployments/jam1/chat/completions?api-version=2024-10-21")
        self.assertEqual(headers["api-key"], "az-key")
        self.assertNotIn("authorization", headers)
        self.assertNotIn("model", body)

    def test_errors_are_plain_and_never_show_the_key(self):
        brain = OpenAICompatibleBrain(azure_endpoint=self.url, deployment="jam1")
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_JAM_API_KEY": "wrong"}), self.assertRaises(JamError) as caught:
            brain.complete("s", "u")
        self.assertEqual(str(caught.exception), "The model service refused the request (HTTP 401).")
        with mock.patch.dict(os.environ, {}, clear=True), self.assertRaises(JamError) as caught:
            brain.complete("s", "u")
        self.assertEqual(str(caught.exception), "No API key: set the PERSONAL_NOTE_JAM_API_KEY environment variable.")
        with self.assertRaises(JamError):
            OpenAICompatibleBrain()

    def test_unreachable_service(self):
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_JAM_API_KEY": "k"}), self.assertRaises(JamError) as caught:
            OpenAICompatibleBrain("http://127.0.0.1:1/v1", "m", timeout=2).complete("s", "u")
        self.assertIn("could not be reached", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
