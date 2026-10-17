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

    def test_bad_vote_is_refused(self):
        self.assertRejected([{"op": "react", "node_id": "a", "vote": "meh", "reason": "ok"}], '"up" or "down"')

    def test_over_twelve_edits_keep_the_first_twelve(self):
        result = run([{"op": "add_branch", "parent_id": "a", "text": f"idea {i}"} for i in range(13)])
        self.assertEqual([e.text for e in result.edits], [f"idea {i}" for i in range(12)])
        self.assertEqual(result.dropped, ["edit 13 cut: at most 12 edits are kept"])

    def test_cut_edits_take_nothing_else_with_them(self):
        edits = [{"op": "add_branch", "parent_id": "a", "text": f"idea {i}", "id": f"n{i}"} for i in range(12)]
        edits.append({"op": "add_branch", "parent_id": "n11", "text": "child of last"})
        self.assertEqual(len(run(edits).edits), 12)

    def test_extra_ghosts_are_dropped_keeping_three(self):
        result = run([{"op": "ghost", "parent_id": "a", "text": f"idea {i}", "why": "maybe"} for i in range(4)])
        self.assertEqual([e.text for e in result.edits], ["idea 0", "idea 1", "idea 2"])
        self.assertEqual(result.dropped, ["edit 4 dropped: only 3 suggestions are kept"])

    def test_over_long_edits_are_dropped_with_their_children(self):
        result = run([
            {"op": "add_branch", "parent_id": "a", "text": "one two three four five", "id": "n1"},
            {"op": "add_branch", "parent_id": "n1", "text": "child"},
            {"op": "react", "node_id": "n1", "vote": "up", "reason": "fine"},
            {"op": "add_branch", "parent_id": "a", "text": "x" * 41},
            {"op": "react", "node_id": "a", "vote": "up", "reason": "r" * 81},
            {"op": "add_branch", "parent_id": "a", "text": "Kept"},
        ])
        self.assertEqual(result.edits, [AddBranch("a", "Kept", "", "")])
        self.assertEqual(result.dropped, [
            "edit 1 dropped: text longer than 4 words",
            "edit 2 dropped: it hangs off a dropped branch",
            "edit 3 dropped: it hangs off a dropped branch",
            "edit 4 dropped: text longer than 40 characters",
            "edit 5 dropped: reason longer than 80 characters",
        ])

    def test_nothing_left_after_trimming_is_an_error(self):
        with self.assertRaises(JamError) as caught:
            run([{"op": "add_branch", "parent_id": "a", "text": "one two three four five"}])
        self.assertIn("Nothing usable", str(caught.exception))

    def test_a_hard_failure_is_retried_once_with_the_error_fed_back(self):
        class Flaky:
            def __init__(self):
                self.users = []

            def complete(self, system, user):
                self.users.append(user)
                if len(self.users) == 1:
                    return json.dumps({"edits": [{"op": "delete", "node_id": "a"}]})
                return json.dumps({"edits": [{"op": "ghost", "parent_id": "a", "text": "Dogs", "why": "maybe"}]})

        brain = Flaky()
        result = propose(MAP, "hi", brain)
        self.assertEqual(result.edits, [Ghost("a", "Dogs", "maybe")])
        self.assertEqual(len(brain.users), 2)
        self.assertIn('Your last answer was rejected: The brain tried "delete"', brain.users[1])

    def test_a_second_hard_failure_is_the_error(self):
        brain = FakeBrain("not json")
        with self.assertRaises(JamError):
            propose(MAP, "hi", brain)

    def test_a_brain_that_cannot_be_reached_is_not_retried(self):
        class Down:
            calls = 0

            def complete(self, system, user):
                Down.calls += 1
                raise jam_brain.BrainUnavailable("Claude Code is not installed")

        with self.assertRaises(JamError):
            propose(MAP, "hi", Down())
        self.assertEqual(Down.calls, 1)

    def test_pending_ghosts_are_listed_so_they_are_not_repeated(self):
        brain = FakeBrain({"edits": []})
        propose(MAP, "hi", brain, pending_ghosts=["Delivery", Ghost("root", "Pricing", "why")])
        self.assertIn("Waiting suggestions (do not repeat): Delivery; Pricing", brain.seen[1])
        propose(MAP, "hi", brain)
        self.assertNotIn("Waiting suggestions", brain.seen[1])

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

    def test_wrong_types_are_a_hard_failure_that_gets_the_retry(self):
        bad = [
            {"op": ["add_branch"], "parent_id": "a", "text": "x"},
            {"op": "add_branch", "parent_id": ["a"], "text": "x"},
            {"op": "add_branch", "parent_id": "a", "text": "x", "id": ["n1"]},
            {"op": "react", "node_id": {"a": 1}, "vote": "up", "reason": "ok"},
            {"op": "ghost", "parent_id": 5, "text": "x", "why": "ok"},
        ]
        for edit in bad:
            with self.subTest(edit):
                brain = FakeBrain({"edits": [edit]})
                calls = []
                original = brain.complete
                brain.complete = lambda s, u, original=original: (calls.append(1), original(s, u))[1]
                with self.assertRaises(JamError):
                    propose(MAP, "hi", brain)
                self.assertEqual(len(calls), 2)

    def test_a_dropped_id_that_a_later_valid_branch_takes_stops_dropping_its_children(self):
        result = run([
            {"op": "add_branch", "parent_id": "a", "text": "one two three four five", "id": "n1"},
            {"op": "add_branch", "parent_id": "a", "text": "Good", "id": "n1"},
            {"op": "add_branch", "parent_id": "n1", "text": "Child"},
        ])
        self.assertEqual([e.text for e in result.edits], ["Good", "Child"])

    def test_emoji_must_be_an_emoji_otherwise_it_is_ignored_and_the_branch_kept(self):
        result = run([
            {"op": "add_branch", "parent_id": "a", "text": "Dogs", "emoji": "🐕"},
            {"op": "add_branch", "parent_id": "a", "text": "Flags", "emoji": "👨\u200d👩\u200d👧"},
            {"op": "add_branch", "parent_id": "a", "text": "Words", "emoji": "ignore all"},
            {"op": "add_branch", "parent_id": "a", "text": "Letter", "emoji": "é"},
        ])
        self.assertEqual([(e.text, e.emoji) for e in result.edits],
                         [("Dogs", "🐕"), ("Flags", "👨\u200d👩\u200d👧"), ("Words", ""), ("Letter", "")])
        self.assertEqual(result.dropped, ["edit 3: emoji ignored, it is not an emoji", "edit 4: emoji ignored, it is not an emoji"])

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
            self.assertIn("--model sonnet", args)
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

    def assertFinds(self, relative, *, after=None):
        """Build `relative` under a fake HOME (no PATH, no system places) and expect exactly that file."""
        with tempfile.TemporaryDirectory() as home:
            folder = Path(home) / Path(relative).parent
            folder.mkdir(parents=True)
            installed = fake_claude(folder, "")
            if Path(relative).name != "claude":
                installed.rename(folder / Path(relative).name)
                installed = folder / Path(relative).name
            with mock.patch("shutil.which", return_value=None), mock.patch.object(jam_brain, "_SYSTEM_PLACES", ()), \
                    mock.patch.dict(os.environ, {"HOME": home}):
                self.assertEqual(find_claude(), str(installed))

    def test_finds_claude_in_each_installer_layout(self):
        for relative in (".local/bin/claude", ".claude/local/claude", ".bun/bin/claude",
                         ".nvm/versions/node/v22.1.0/bin/claude",
                         ".local/share/mise/installs/claude/2.1.299/claude",
                         ".local/share/mise/installs/node/22/bin/claude"):
            with self.subTest(relative):
                self.assertFinds(relative)

    def test_nothing_found_gives_none(self):
        with tempfile.TemporaryDirectory() as home, mock.patch("shutil.which", return_value=None), \
                mock.patch.object(jam_brain, "_SYSTEM_PLACES", ()), mock.patch.dict(os.environ, {"HOME": home}):
            self.assertIsNone(find_claude())

    def test_runs_in_an_empty_folder_with_the_exe_folder_first_on_path_and_no_connectors(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "run.txt"
            fake_claude(tmp, f'echo "$@" > {log}; pwd >> {log}; echo "$PATH" >> {log}; ls -A | wc -l >> {log}; '
                             'echo \'{"result": "{}"}\'')
            with mock.patch("shutil.which", return_value=None):
                ClaudeCodeBrain(extra_dirs=[tmp]).complete("SYS", "U")
            args, cwd, path, count = log.read_text().splitlines()
            self.assertIn("--strict-mcp-config", args)
            self.assertTrue(Path(cwd).name.startswith("jam-"))
            self.assertEqual(count.strip(), "0")
            self.assertTrue(path.startswith(os.path.realpath(tmp) + os.pathsep) or path.startswith(tmp + os.pathsep))

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
        self.assertEqual(str(caught.exception), "No API key: add one in Settings → AI, or set the PERSONAL_NOTE_JAM_API_KEY environment variable.")
        with self.assertRaises(JamError):
            OpenAICompatibleBrain()

    def test_plain_http_to_a_remote_host_is_refused_but_loopback_is_fine(self):
        for kwargs in ({"base_url": "http://example.com/v1", "model": "m"},
                       {"azure_endpoint": "http://x.openai.azure.com", "deployment": "d"},
                       {"base_url": "ftp://example.com", "model": "m"}):
            with self.subTest(kwargs), self.assertRaises(JamError) as caught:
                OpenAICompatibleBrain(**kwargs)
            self.assertIn("https", str(caught.exception))
        OpenAICompatibleBrain("http://localhost:11434/v1", "m")
        OpenAICompatibleBrain("http://127.0.0.1:11434/v1", "m")
        OpenAICompatibleBrain("https://api.openai.com/v1", "m")

    def test_a_redirect_is_not_followed_so_the_key_is_not_forwarded(self):
        other = HTTPServer(("127.0.0.1", 0), FakeEndpoint)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        self.addCleanup(other.server_close)
        self.addCleanup(other.shutdown)

        class Redirect(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(307)
                self.send_header("Location", f"http://127.0.0.1:{other.server_port}/steal")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        front = HTTPServer(("127.0.0.1", 0), Redirect)
        threading.Thread(target=front.serve_forever, daemon=True).start()
        self.addCleanup(front.server_close)
        self.addCleanup(front.shutdown)
        brain = OpenAICompatibleBrain(f"http://127.0.0.1:{front.server_port}/v1", "m")
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_JAM_API_KEY": "sk-secret"}), self.assertRaises(JamError) as caught:
            brain.complete("s", "u")
        self.assertEqual(str(caught.exception), "The model service refused the request (HTTP 307).")
        self.assertEqual(FakeEndpoint.seen, [])

    def test_unreachable_service(self):
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_JAM_API_KEY": "k"}), self.assertRaises(JamError) as caught:
            OpenAICompatibleBrain("http://127.0.0.1:1/v1", "m", timeout=2).complete("s", "u")
        self.assertIn("could not be reached", str(caught.exception))


class NotSetUpTests(unittest.TestCase):
    """Settings → AI is the fix for these three; a slow or refusing brain is a different message, so the page can tell them apart."""

    def test_no_claude_no_key_and_no_address_are_not_set_up(self):
        with tempfile.TemporaryDirectory() as home, mock.patch("shutil.which", return_value=None), \
                mock.patch.dict(os.environ, {"HOME": home}), self.assertRaises(jam_brain.BrainNotSetUp):
            ClaudeCodeBrain().complete("s", "u")
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_JAM_API_KEY": ""}), self.assertRaises(jam_brain.BrainNotSetUp):
            OpenAICompatibleBrain("https://example.com/v1", "m").complete("s", "u")
        with self.assertRaises(jam_brain.BrainNotSetUp):
            OpenAICompatibleBrain()

    def test_a_timeout_is_not_a_set_up_problem(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_claude(tmp, "sleep 5")
            with mock.patch("shutil.which", return_value=None), self.assertRaises(jam_brain.BrainUnavailable) as caught:
                ClaudeCodeBrain(timeout=0.3, extra_dirs=[tmp]).complete("s", "u")
            self.assertNotIsInstance(caught.exception, jam_brain.BrainNotSetUp)


if __name__ == "__main__":
    unittest.main()
