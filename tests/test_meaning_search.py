"""Search finds by meaning (F-080): the API route, the ranking rule and the CLI, with a fake embedder and temporary databases.

The fake embedder is a bag of words, so the scores are known: for the query below, a note titled "Sleep log" whose text is
"tired woke slept badly early" scores 0.845, with " again" added 0.791, "Sleep diary" with "tired woke slept badly" 0.730,
with "tired woke slept" 0.600, and an unrelated trip note 0.169.
"""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from starlette.testclient import TestClient

import personal_note_cli
from meaning_index import MeaningIndexer
from routes import create_app
from tests.test_meaning_index import FakeEngine, vector_of
from tests.test_secure_notes import FakeLinux

QUERY = "tired woke slept badly early"


def cosine(query, text):
    return sum(a * b for a, b in zip(vector_of(query), vector_of(text)))


class MeaningSearchCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "notes.db"
        self.engine = FakeEngine()
        self.app = create_app(self.path, search=self.engine, secure_platform=FakeLinux())
        self.app.state.indexer.stop()  # the test indexes by hand, so nothing runs behind it
        self.service = self.app.state.note_service
        self.client = TestClient(self.app)
        self.indexer = MeaningIndexer(self.service, self.engine, idle=0)

    def tearDown(self):
        self.client.close()
        self.temporary.cleanup()

    def page(self, title, markdown, notebook_id=None):
        note = self.service.create_note({"title": title, "noteType": "page", "notebookId": notebook_id})
        self.service.update_note(note["id"], {"title": title, "content": {"markdown": markdown, "ink": {"marks": [], "drawings": []}}, "revision": note["revision"]})
        return self.service.get_note(note["id"])

    def index(self):
        while self.indexer.run_once():
            pass

    def ask(self, query=QUERY, **params):
        return self.client.get("/api/search/meaning", params={"q": query, **params})


class MeaningRouteTests(MeaningSearchCase):
    def test_it_returns_the_closest_notes_with_title_notebook_and_score_best_first(self):
        health = self.service.create_notebook({"name": "Health", "color": "#2f9d8f", "category": "areas"})
        sleep = self.page("Sleep log", "tired woke slept badly early", health["id"])
        self.page("Trip", "flights to lisbon and a hotel")
        self.index()

        response = self.ask()

        self.assertEqual(response.status_code, 200)
        (found,) = response.json()
        self.assertEqual({key: found[key] for key in ("id", "title", "notebook")}, {"id": sleep["id"], "title": "Sleep log", "notebook": "Health"})
        self.assertAlmostEqual(found["score"], cosine(QUERY, "Sleep log tired woke slept badly early"), places=4)

    def test_a_note_in_the_inbox_names_the_inbox(self):
        self.page("Sleep log", "tired woke slept badly early")
        self.index()
        self.assertEqual([item["notebook"] for item in self.ask().json()], ["Inbox"])

    def test_only_notes_within_0_04_of_the_best_and_above_0_65_are_listed_best_first(self):
        best = self.page("Sleep log", "tired woke slept badly early")
        tied = self.page("Sleep diary", "tired woke slept badly early")  # 0.845 too
        self.page("Sleep log", "tired woke slept badly early again")  # 0.791: above the floor, but 0.054 below the best
        self.page("Sleep diary", "tired woke slept badly")  # 0.730
        self.page("Trip", "flights to lisbon and a hotel")  # 0.169: below the floor
        self.index()

        self.assertCountEqual([item["id"] for item in self.ask().json()], [best["id"], tied["id"]])

    def test_when_even_the_best_is_under_the_floor_nothing_is_listed(self):
        self.page("Sleep diary", "tired woke slept")  # 0.600
        self.page("Trip", "flights to lisbon and a hotel")
        self.index()
        self.assertEqual(self.ask().json(), [])

    def test_limit_caps_the_list(self):
        for _ in range(4):
            self.page("Sleep log", "tired woke slept badly early")
        self.index()
        self.assertEqual(len(self.ask(limit=2).json()), 2)
        self.assertEqual(len(self.ask().json()), 4)

    def test_secure_notes_never_appear(self):
        secret = self.page("Sleep log", "tired woke slept badly early")
        other = self.page("Sleep log", "tired woke slept badly early")
        self.index()
        self.service.mark_secure(secret["id"], passphrase="correct horse battery")

        self.assertEqual([item["id"] for item in self.ask().json()], [other["id"]])

    def test_without_the_download_it_is_an_empty_list_and_the_engine_is_never_asked(self):
        self.page("Sleep log", "tired woke slept badly early")
        self.index()
        self.engine.is_installed = False

        response = self.ask()

        self.assertEqual((response.status_code, response.json()), (200, []))
        self.assertEqual(self.engine.queries, [])

    def test_an_engine_that_is_down_gives_an_empty_list_not_an_error(self):
        self.page("Sleep log", "tired woke slept badly early")
        self.index()
        self.engine.down = True
        response = self.ask()
        self.assertEqual((response.status_code, response.json()), (200, []))

    def test_a_blank_query_is_an_empty_list_without_asking_the_engine(self):
        self.assertEqual(self.ask("   ").json(), [])
        self.assertEqual(self.engine.queries, [])


class MeaningCliTests(MeaningSearchCase):
    def setUp(self):
        super().setUp()
        self.stopped = []
        self.engine.shutdown = lambda: self.stopped.append(True)

    def run_cli(self, *arguments):
        output = io.StringIO()
        with mock.patch.object(personal_note_cli, "search_engine", return_value=self.engine), contextlib.redirect_stdout(output):
            code = personal_note_cli.main(["--database", str(self.path), *arguments])
        return code, output.getvalue()

    def test_meaning_returns_the_same_ranking_as_the_route_as_json(self):
        self.page("Sleep log", "tired woke slept badly early")
        self.page("Trip", "flights to lisbon and a hotel")
        self.index()

        code, text = self.run_cli("search", "--meaning", QUERY)

        self.assertEqual(code, 0)
        self.assertEqual(json.loads(text), self.ask().json())
        self.assertEqual([item["title"] for item in json.loads(text)], ["Sleep log"])
        self.assertEqual(self.stopped, [True])  # the engine the command started does not outlive it

    def test_text_prints_one_line_per_note_with_its_score(self):
        note = self.page("Sleep log", "tired woke slept badly early")
        self.index()
        code, text = self.run_cli("search", "--meaning", QUERY, "--text")
        self.assertEqual((code, text), (0, f"#{note['id']} Sleep log [Inbox] - 0.85\n"))

    def test_without_the_download_it_says_so_and_exits_with_an_error(self):
        self.engine.is_installed = False
        code, text = self.run_cli("search", "--meaning", "tired")
        self.assertEqual((code, json.loads(text)), (2, {"ok": False, "error": "Search by meaning is not installed. Download it in the app's Settings."}))
        self.assertEqual(self.engine.queries, [])

    def test_a_down_engine_is_a_clear_error(self):
        self.engine.down = True
        code, text = self.run_cli("search", "--meaning", "tired")
        self.assertEqual((code, json.loads(text)), (2, {"ok": False, "error": "The search engine did not answer. Try again."}))

    def test_the_word_search_is_unchanged(self):
        note = self.page("Sleep log", "tired woke slept badly early")
        code, text = self.run_cli("search", "slept")
        self.assertEqual((code, [item["id"] for item in json.loads(text)]), (0, [note["id"]]))


if __name__ == "__main__":
    unittest.main()
