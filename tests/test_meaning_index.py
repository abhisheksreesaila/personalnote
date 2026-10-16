"""Indexing notes by meaning (F-079): the derived vectors, the background indexer, and `meaning_search`.

No network and no engine: a fake embedder (a bag of words hashed into 64 slots, so the same text always gives the same
vector and shared words give a high cosine) stands in for SearchRuntime and records everything it is asked to embed.
"""

import array
import json
import math
import sqlite3
import tempfile
import time
import unittest
import zlib
from pathlib import Path

from starlette.testclient import TestClient

from meaning_index import MeaningIndexer
from routes import create_app
from search_runtime import SearchError, SearchInputError
from services import MEANING_TEXT_CHARS, NoteService
from tests.test_secure_notes import FakeLinux

DIMS = 64


def vector_of(text: str) -> list[float]:
    slots = [0.0] * DIMS
    for word in text.lower().replace("|", " ").replace(":", " ").split():
        slots[zlib.crc32(word.encode()) % DIMS] += 1.0
    norm = math.sqrt(sum(value * value for value in slots)) or 1.0
    return [value / norm for value in slots]


class FakeEngine:
    """The part of SearchRuntime the index uses: installed(), model_id, embed(). Records every prompt it was given."""

    def __init__(self, installed=True):
        self.is_installed = installed
        self.model_id = "fake-model/64"
        self.down = False
        self.refuse = ""  # a word: an input containing it is refused as too long, the way the real engine refuses
        self.documents: list[tuple] = []
        self.queries: list[str] = []
        self.batches: list[float] = []
        self.idle_checks: list[float] = []

    def installed(self):
        return self.is_installed

    def status(self):
        return {"state": "ready" if self.is_installed else "not-installed"}

    def embed(self, texts, kind="document"):
        if self.down:
            raise SearchError("The search engine did not answer. Try again.")
        if kind == "query":
            self.queries.extend(texts)
            return [vector_of(text) for text in texts]
        if self.refuse and any(self.refuse in text for _, text in texts):
            raise SearchInputError("That note is too long for the search engine.")
        self.batches.append(time.monotonic())
        self.documents.extend(texts)
        return [vector_of(f"{title} {text}") for title, text in texts]

    def stop_if_idle(self, seconds):
        self.idle_checks.append(seconds)
        return False

    @property
    def embedded_text(self) -> str:
        return " ".join(f"{title} {text}" for title, text in self.documents)


class Clock:
    now = 1000.0

    def __call__(self):
        return self.now


class MeaningCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "notes.db"
        self.engine = FakeEngine()
        self.clock = Clock()
        self.service = NoteService(self.path, secure_platform=FakeLinux(), scrypt_cost=2**4, embedder=self.engine)
        self.indexer = MeaningIndexer(self.service, self.engine, idle=0, clock=self.clock)

    def tearDown(self):
        self.temporary.cleanup()

    def page(self, title, markdown):
        note = self.service.create_note({"title": title, "noteType": "page"})
        self.save_page(note, title, markdown)
        return self.service.get_note(note["id"])

    def save_page(self, note, title, markdown):
        current = self.service.get_note(note["id"])
        self.service.update_note(note["id"], {"title": title, "content": {"markdown": markdown, "ink": {"marks": [], "drawings": []}}, "revision": current["revision"]})
        return self.service.get_note(note["id"])

    def drain(self):
        total = 0
        while count := self.indexer.run_once():
            total += count
        return total

    def rows(self):
        with self.service.connection() as connection:
            return {row["note_id"]: dict(row) for row in connection.execute("SELECT * FROM note_embeddings")}


class IndexingTests(MeaningCase):
    def test_a_new_note_is_embedded_with_its_title_and_text_and_stored_with_its_revision(self):
        note = self.page("Sleep log", "slept badly, woke at four")

        self.assertEqual(self.drain(), 1)

        self.assertEqual(self.engine.documents, [("Sleep log", "slept badly, woke at four")])
        row = self.rows()[note["id"]]
        self.assertEqual((row["revision"], row["model"], row["dims"], len(row["vector"])), (note["revision"], "fake-model/64", DIMS, DIMS * 4))

    def test_canvas_and_mind_map_notes_are_embedded_with_the_text_search_reads(self):
        canvas = self.service.create_note({"title": "Canvas", "noteType": "canvas"})
        self.service.update_note(canvas["id"], {"title": "Canvas", "content": {"objects": [{"type": "textbox", "text": "grocery plan for friday", "left": 10, "top": 10, "width": 300}]}, "revision": 1})
        mind = self.service.create_note({"title": "Map", "noteType": "mindmap"})
        self.service.update_note(mind["id"], {"title": "Map", "content": {"version": 1, "rootId": "r", "nodes": [{"id": "r", "parentId": None, "text": "holiday ideas", "x": 0, "y": 0}]}, "revision": 1})

        self.drain()

        with self.service.connection() as connection:
            expected = {row["title"]: row["body"] for row in connection.execute("SELECT title, body FROM note_search")}
        self.assertEqual(dict(self.engine.documents)["Canvas"], expected["Canvas"])
        self.assertIn("grocery plan for friday", expected["Canvas"])
        self.assertEqual(dict(self.engine.documents)["Map"], "holiday ideas")

    def test_a_long_note_is_cut_to_the_character_budget(self):
        self.page("Long", "word " * 5000)

        self.drain()

        self.assertEqual(len(self.engine.documents[0][1]), MEANING_TEXT_CHARS)

    def test_an_edit_embeds_the_new_text_once_and_an_untouched_note_is_not_embedded_again(self):
        note = self.page("Trip", "flights to lisbon")
        self.drain()
        self.engine.documents.clear()
        self.assertEqual(self.drain(), 0)

        self.save_page(note, "Trip", "trains to porto")
        self.assertEqual(self.drain(), 1)

        self.assertEqual(self.engine.documents, [("Trip", "trains to porto")])
        self.assertEqual(self.rows()[note["id"]]["revision"], note["revision"] + 1)

    def test_moving_a_note_to_another_notebook_does_not_embed_it_again(self):
        notebook = self.service.create_notebook({"name": "Elsewhere"})
        note = self.page("Trip", "flights to lisbon")
        self.drain()
        self.engine.documents.clear()

        moved = self.service.move_note(note["id"], {"notebookId": notebook["id"], "revision": note["revision"]})

        self.assertEqual(self.drain(), 0)
        self.assertEqual(self.engine.documents, [])
        self.assertEqual(self.rows()[note["id"]]["revision"], moved["revision"])
        self.assertEqual(self.service.meaning_counts("fake-model/64")["indexed"], 1)

    def test_deleting_a_note_removes_its_vector(self):
        note = self.page("Trip", "flights to lisbon")
        self.drain()

        self.service.delete_note(note["id"])

        self.assertEqual(self.rows(), {})

    def test_a_note_only_gets_indexed_after_it_has_been_left_alone(self):
        self.indexer.idle = 3600
        self.page("Trip", "flights to lisbon")

        self.assertEqual(self.indexer.run_once(), 0)
        self.assertEqual(self.engine.documents, [])

    def test_vectors_from_another_model_are_rebuilt(self):
        note = self.page("Trip", "flights to lisbon")
        self.drain()
        self.engine.model_id = "newer-model/64"

        self.assertEqual(self.drain(), 1)

        self.assertEqual(self.rows()[note["id"]]["model"], "newer-model/64")

    def test_a_dropped_table_is_made_again_on_the_next_start_and_filled_again(self):
        self.page("Trip", "flights to lisbon")
        self.drain()
        with self.service.connection() as connection:
            connection.execute("DROP TABLE note_embeddings")

        again = NoteService(self.path, secure_platform=FakeLinux(), embedder=self.engine)
        indexer = MeaningIndexer(again, self.engine, idle=0)

        self.assertEqual(indexer.run_once(), 1)

    def test_nothing_happens_until_the_download_is_installed(self):
        self.engine.is_installed = False
        self.page("Trip", "flights to lisbon")

        self.assertEqual(self.indexer.run_once(), 0)
        self.assertEqual(self.engine.documents, [])

    def test_status_counts_what_is_indexed_out_of_what_can_be(self):
        self.page("One", "alpha")
        self.page("Two", "beta")
        self.drain()
        self.page("Three", "gamma")

        with self.service.connection() as connection:
            total = connection.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        self.assertEqual(self.indexer.status(), {"indexed": 2, "total": total, "error": "", "failed": 0})

    def test_a_note_written_by_another_process_is_picked_up_the_same_way(self):
        other = NoteService(self.path, secure_platform=FakeLinux())  # what the CLI does: it only writes through NoteService
        note = other.create_note({"title": "From agent", "noteType": "page"})
        other.update_note(note["id"], {"title": "From agent", "content": {"markdown": "agent wrote this", "ink": {}}, "revision": 1})

        self.drain()

        self.assertIn(("From agent", "agent wrote this"), self.engine.documents)


class SecureNoteTests(MeaningCase):
    def test_a_secure_note_never_reaches_the_engine_and_its_vector_goes_when_it_is_made_secure(self):
        secret = self.page("Cards", "my pin is quokkaphrase")
        plain = self.page("Plain", "tea and toast")
        self.drain()
        self.assertIn(secret["id"], self.rows())

        self.service.mark_secure(secret["id"], passphrase="correct horse battery")
        self.engine.documents.clear()
        self.save_page_secure_edit(secret)
        self.drain()

        self.assertNotIn(secret["id"], self.rows())
        self.assertIn(plain["id"], self.rows())
        self.assertNotIn("quokkaphrase", self.engine.embedded_text)
        self.assertNotIn("Cards", self.engine.embedded_text)

    def test_a_secure_note_made_before_indexing_is_never_embedded(self):
        secret = self.page("Cards", "my pin is quokkaphrase")
        self.service.mark_secure(secret["id"], passphrase="correct horse battery")

        self.drain()

        self.assertEqual(self.engine.documents, [])
        self.assertEqual(self.rows(), {})

    def test_a_note_made_secure_while_its_batch_is_out_gets_no_vector(self):
        secret = self.page("Cards", "my pin is quokkaphrase")
        work = self.service.meaning_work("fake-model/64", 0, 4)
        self.service.mark_secure(secret["id"], passphrase="correct horse battery")

        self.service.store_meaning("fake-model/64", [(work[0], vector_of("anything"))])

        self.assertEqual(self.rows(), {})

    def test_meaning_search_leaves_out_secure_notes(self):
        secret = self.page("Cards", "my pin is quokkaphrase")
        self.page("Plain", "pin quokkaphrase tea")
        self.drain()
        self.service.mark_secure(secret["id"], passphrase="correct horse battery")

        found = [note_id for note_id, _ in self.service.meaning_search("quokkaphrase pin")]

        self.assertNotIn(secret["id"], found)

    def save_page_secure_edit(self, note):
        """An unlocked secure note is edited: the words are sealed, and no vector may appear."""
        current = self.service.get_note(note["id"])
        self.service.update_note(note["id"], {"title": "Cards", "content": {"markdown": "my pin is quokkaphrase again", "ink": {}}, "revision": current["revision"]})


class EngineDownTests(MeaningCase):
    def test_notes_still_save_the_status_shows_the_error_and_indexing_resumes_when_the_engine_is_back(self):
        self.engine.down = True
        note = self.page("Trip", "flights to lisbon")

        self.assertEqual(self.indexer.run_once(), 0)
        self.assertEqual(self.indexer.status()["error"], "The search engine did not answer. Try again.")
        self.save_page(note, "Trip", "trains to porto")  # saving never waits on the engine
        self.assertEqual(self.service.get_note(note["id"])["content"]["markdown"], "trains to porto")

        self.engine.down = False
        self.assertEqual(self.indexer.run_once(), 0, "still backing off")
        self.clock.now += 31
        self.assertEqual(self.indexer.run_once(), 1)
        self.assertEqual(self.indexer.status()["error"], "")
        self.assertEqual(self.engine.documents, [("Trip", "trains to porto")])

    def test_the_wait_doubles_while_the_engine_stays_down(self):
        self.engine.down = True
        self.page("Trip", "flights to lisbon")
        self.indexer.run_once()
        self.clock.now += 31
        self.indexer.run_once()

        self.clock.now += 31
        self.engine.down = False
        self.assertEqual(self.indexer.run_once(), 0, "the second wait is 60 s")
        self.clock.now += 30
        self.assertEqual(self.indexer.run_once(), 1)

    def test_the_background_thread_indexes_by_itself_and_stops(self):
        self.page("Trip", "flights to lisbon")
        indexer = MeaningIndexer(self.service, self.engine, idle=0, poll=0.05)
        indexer.start()
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not self.rows():
                time.sleep(0.02)
        finally:
            indexer.stop()
        self.assertEqual(len(self.rows()), 1)


class OneBadNoteTests(MeaningCase):
    def test_a_note_the_engine_refuses_is_skipped_and_never_blocks_the_others(self):
        self.engine.refuse = "TOOLONG"
        bad = self.page("Oldest", "TOOLONG " * 10)  # first in line: the same batch would be picked again for ever
        good = [self.page(f"Note {i}", f"words {i}") for i in range(5)]

        self.assertEqual(self.drain(), 5)

        self.assertEqual(set(self.rows()), {note["id"] for note in good})
        self.assertEqual(self.indexer.status()["failed"], 1)
        self.assertEqual(self.indexer.status()["error"], "")

    def test_a_refused_note_is_not_tried_again_until_it_changes(self):
        self.engine.refuse = "TOOLONG"
        bad = self.page("Oldest", "TOOLONG " * 10)
        self.drain()
        asked = len(self.engine.batches)

        self.assertEqual(self.indexer.run_once(), 0)
        self.assertEqual(len(self.engine.batches), asked)

        self.save_page(bad, "Oldest", "short now")
        self.assertEqual(self.drain(), 1)
        self.assertIn(bad["id"], self.rows())
        self.assertEqual(self.indexer.status()["failed"], 0)

    def test_an_engine_that_is_down_does_not_blame_the_notes(self):
        self.engine.down = True
        self.page("One", "alpha")
        self.page("Two", "beta")
        self.indexer.run_once()

        self.engine.down = False
        self.clock.now += 31
        self.assertEqual(self.drain(), 2)
        self.assertEqual(self.indexer.status()["failed"], 0)


class QuietTests(MeaningCase):
    def test_the_default_waits_for_the_person_to_stop_typing(self):
        self.page("Trip", "flights to lisbon")
        patient = MeaningIndexer(self.service, self.engine)  # defaults

        self.assertEqual(patient.run_once(), 0)
        self.assertEqual(self.engine.documents, [])

    def test_nothing_is_read_while_nothing_has_changed(self):
        self.page("Trip", "flights to lisbon")
        calls = []
        real = self.service.meaning_work
        self.service.meaning_work = lambda *a, **k: (calls.append(1), real(*a, **k))[1]

        self.indexer.tick()  # indexes the note
        self.indexer.tick()  # nothing is left: reads the notes once more and settles
        settled = len(calls)
        for _ in range(5):
            self.indexer.tick()
        self.assertEqual(len(calls), settled)

        self.clock.now += 61  # the slow safety poll still looks
        self.indexer.tick()
        self.assertEqual(len(calls), settled + 1)

    def test_a_change_from_anywhere_wakes_the_index(self):
        self.page("Trip", "flights to lisbon")
        while self.indexer.tick():
            pass
        other = NoteService(self.path, secure_platform=FakeLinux())  # the CLI is another process
        note = other.create_note({"title": "From agent", "noteType": "page"})
        other.update_note(note["id"], {"title": "From agent", "content": {"markdown": "agent wrote this", "ink": {}}, "revision": 1})

        self.assertEqual(self.indexer.tick(), 1)
        self.assertIn(("From agent", "agent wrote this"), self.engine.documents)

    def test_a_note_still_waiting_to_be_idle_keeps_the_index_looking(self):
        self.indexer.idle = 3600
        self.page("Trip", "flights to lisbon")
        for _ in range(4):
            self.indexer.tick()
        self.indexer.idle = 0

        self.assertEqual(self.indexer.tick(), 1)

    def test_the_engine_is_offered_a_rest_once_the_index_has_caught_up_and_not_before(self):
        self.page("Trip", "flights to lisbon")
        self.indexer.tick()
        self.assertEqual(self.engine.idle_checks, [], "still working")
        self.indexer.tick()
        self.assertEqual(self.engine.idle_checks, [300.0])

    def test_the_thread_rests_between_batches(self):
        for index in range(6):
            self.page(f"Note {index}", f"words {index}")
        indexer = MeaningIndexer(self.service, self.engine, idle=0, poll=0.05, batch=2, pause=0.3)
        indexer.start()
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and len(self.rows()) < 6:
                time.sleep(0.02)
        finally:
            indexer.stop()
        gaps = [later - earlier for earlier, later in zip(self.engine.batches, self.engine.batches[1:])]
        self.assertEqual(len(self.engine.batches), 3)
        self.assertTrue(all(gap >= 0.27 for gap in gaps), gaps)

    def test_stopping_waits_for_a_batch_in_flight_and_nothing_runs_afterwards(self):
        self.page("Trip", "flights to lisbon")
        indexer = MeaningIndexer(self.service, self.engine, idle=0, poll=0.01)
        indexer.start()
        indexer.stop()

        self.assertFalse(indexer._thread.is_alive())
        before = len(self.engine.batches)
        time.sleep(0.1)
        self.assertEqual(len(self.engine.batches), before)

    def test_the_engine_cannot_start_after_the_app_has_shut_it_down_even_when_a_batch_was_in_flight(self):
        from tests.test_search_runtime import SearchTestCase

        class Case(SearchTestCase):
            def runTest(self):
                pass

        case = Case()
        case.setUp()
        try:
            runtime = case.runtime()
            case.install(runtime)
            service = NoteService(Path(case.temporary.name) / "n.db", secure_platform=FakeLinux(), embedder=runtime)
            note = service.create_note({"title": "Trip", "noteType": "page"})
            service.update_note(note["id"], {"title": "Trip", "content": {"markdown": "flights", "ink": {}}, "revision": 1})
            indexer = MeaningIndexer(service, runtime, idle=0)
            real = runtime._choose_port
            runtime._choose_port = lambda: (runtime.shutdown(), real())[1]  # the app closes just as the batch starts the engine

            self.assertEqual(indexer.run_once(), 0)

            self.assertFalse(runtime.status()["running"])
            self.assertFalse((runtime.root / "engine.pid").exists())
        finally:
            case.tearDown()


class SearchTests(MeaningCase):
    def test_meaning_search_ranks_by_cosine_and_returns_the_scores(self):
        sleep = self.page("Sleep log", "tired every morning, woke at four, slept badly")
        self.page("Trip", "flights to lisbon and a hotel")
        self.page("Dinner", "pasta with tomatoes")
        self.drain()

        found = self.service.meaning_search("slept badly and tired", limit=2)

        self.assertEqual(len(found), 2)
        self.assertEqual(found[0][0], sleep["id"])
        query = vector_of("slept badly and tired")
        expected = sum(a * b for a, b in zip(query, vector_of("Sleep log tired every morning, woke at four, slept badly")))
        self.assertAlmostEqual(found[0][1], expected, places=5)
        self.assertGreater(found[0][1], found[1][1])

    def test_the_query_goes_to_the_engine_as_a_query_and_without_an_engine_there_are_no_results(self):
        self.page("Sleep log", "tired")
        self.drain()
        self.service.meaning_search("sleep")
        self.assertEqual(self.engine.queries, ["sleep"])

        bare = NoteService(self.path, secure_platform=FakeLinux())
        self.assertEqual(bare.meaning_search("sleep"), [])

    def test_a_few_thousand_vectors_are_searched_quickly_in_plain_python(self):
        with self.service.connection() as connection:
            for index in range(3000):
                connection.execute("INSERT INTO notes (resource_id, title) VALUES (?, ?)", (f"res_bulk_{index}", f"n{index}"))
            ids = [row[0] for row in connection.execute("SELECT id FROM notes WHERE resource_id LIKE 'res_bulk_%'")]
            for note_id in ids:
                connection.execute(
                    "INSERT INTO note_embeddings (note_id, revision, model, dims, vector, text_hash) VALUES (?, 1, 'fake-model/64', ?, ?, 'h')",
                    (note_id, DIMS, array.array("f", vector_of(f"word{note_id % 50} other{note_id % 7}")).tobytes()),
                )
            connection.commit()

        started = time.perf_counter()
        found = self.service.meaning_search("word3 other3", limit=5)
        elapsed = time.perf_counter() - started

        self.assertEqual(len(found), 5)
        self.assertLess(elapsed, 1.0, f"3000 vectors took {elapsed:.3f}s")


class BackupTests(unittest.TestCase):
    def test_backup_and_export_do_not_carry_the_vectors(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = FakeEngine()
            app = create_app(Path(folder) / "notes.db", search=engine)
            app.state.indexer.stop()
            service = app.state.note_service
            note = service.create_note({"title": "Sleep log", "noteType": "page"})
            service.update_note(note["id"], {"title": "Sleep log", "content": {"markdown": "tired", "ink": {}}, "revision": 1})
            indexer = MeaningIndexer(service, engine, idle=0)
            self.assertEqual(indexer.run_once(), 1)
            vector_bytes = service.meaning_search("tired", 1)
            self.assertEqual(len(vector_bytes), 1)

            client = TestClient(app)
            backup = client.get("/api/export/workspace").text
            self.assertNotIn("note_embeddings", backup)
            self.assertNotIn("vector", backup)
            self.assertNotIn("embedding", backup.lower())
            self.assertEqual(json.loads(backup)["version"], 3)

            status = client.get("/api/search-meaning/status").json()
            self.assertEqual(status["index"]["indexed"], 1)
            self.assertEqual(status["index"]["error"], "")


if __name__ == "__main__":
    unittest.main()
