"""The rule that decides which meaning matches are shown (F-080), checked against scores the real engine gave.

`tests/fixtures/meaning-scores.json` holds 41 notes and 25 queries (meaning queries with no shared words, gibberish, stopwords,
off-topic) with the cosine of every pair, measured with EmbeddingGemma 2 at 256 dimensions by `scripts/gather_meaning_scores.py`.
"""

import json
import unittest
from pathlib import Path

from meaning_rank import MEANING_GAP, select_meaning

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "meaning-scores.json").read_text(encoding="utf-8"))
HELDOUT = json.loads((Path(__file__).parent / "fixtures" / "meaning-scores-heldout.json").read_text(encoding="utf-8"))
NOISE = ("word", "gibberish", "stopwords", "off-topic")
UNRELATED = ["Dentist", "Kitchen shelves", "Passport renewal", "Chess openings", "Podcast ideas"]


def shown(query, only=None, limit=5):
    scores = [(title, score) for title, score in query["scores"].items() if only is None or title in only]
    return [title for title, _ in select_meaning(scores, limit)]


def table(only_for=None, fixture=FIXTURE):
    """(precision, recall, queries with a right note shown, queries that should show nothing and do) over a fixture."""
    right = wrong = missed = found = silent = 0
    queries = fixture["queries"]
    for query in queries:
        titles = shown(query, only_for(query) if only_for else None)
        expected = set(query["expect"]) & (only_for(query) if only_for else set(query["scores"]))
        right += len(set(titles) & expected)
        wrong += len(set(titles) - expected)
        missed += len(expected - set(titles))
        if expected and set(titles) & expected:
            found += 1
        if not query["expect"] and not titles:
            silent += 1
    return right / (right + wrong), right / (right + missed), found, silent


class FixtureTests(unittest.TestCase):
    def test_the_fixture_is_what_the_rule_was_chosen_on(self):
        self.assertEqual(len(FIXTURE["notes"]), 41)
        self.assertEqual(len(FIXTURE["queries"]), 25)
        self.assertEqual(FIXTURE["model"], "ggml-org/embeddinggemma-2-GGUF@bfcd2987/256")
        self.assertEqual(len([q for q in FIXTURE["queries"] if q["kind"] == "meaning"]), 18)

    def test_gibberish_stopwords_off_topic_and_a_single_rare_word_show_nothing(self):
        for query in FIXTURE["queries"]:
            if query["kind"] in NOISE:
                self.assertEqual(shown(query), [], query["query"])

    def test_every_meaning_query_with_no_shared_words_shows_a_right_note(self):
        for query in FIXTURE["queries"]:
            if query["kind"] == "meaning":
                self.assertTrue(set(shown(query)) & set(query["expect"]), f"{query['query']}: {shown(query)}")

    def test_the_named_examples(self):
        by_query = {query["query"]: query for query in FIXTURE["queries"]}
        self.assertEqual(shown(by_query["money for the house loan"]), ["Mortgage options"])
        self.assertEqual(shown(by_query["what to cook for dinner"]), ["Sunday meal prep", "Wine notes"])
        self.assertEqual(shown(by_query["trouble sleeping"]), ["Insomnia ideas", "Sleep log"])
        self.assertEqual(shown(by_query["the"]), [])
        self.assertEqual(shown(by_query["hello world"]), [])

    def test_in_sample_precision_and_recall(self):
        """In sample: the rule's three numbers were chosen on these queries, so this pins them rather than proves them (see HeldOutTests)."""
        precision, recall, found, silent = table()
        self.assertEqual((round(precision, 2), round(recall, 2), found, silent), (0.76, 0.83, 18, 7))

    def test_a_note_far_below_the_best_is_not_listed_with_it(self):
        scores = [("best", 0.80), ("near", 0.77), ("far", 0.72)] + [(f"n{i}", 0.55) for i in range(9)]
        self.assertEqual([key for key, _ in select_meaning(scores, 5)], ["best", "near"])

    def test_the_limit_caps_the_list(self):
        scores = [(f"top{i}", 0.80) for i in range(6)] + [(f"n{i}", 0.55) for i in range(9)]
        self.assertEqual(len(select_meaning(scores, 5)), 5)
        self.assertEqual(len(select_meaning(scores, 2)), 2)

    def test_the_rule_is_a_gap_over_the_median_not_a_fixed_score(self):
        low = [("a", 0.60)] + [(f"n{i}", 0.45) for i in range(9)]  # a quiet notebook: 0.60 is 0.15 over the median
        high = [("a", 0.70)] + [(f"n{i}", 0.66) for i in range(9)]  # a busy one: 0.70 is only 0.04 over it
        self.assertEqual([key for key, _ in select_meaning(low, 5)], ["a"])
        self.assertEqual(select_meaning(high, 5), [])
        self.assertAlmostEqual(MEANING_GAP, 0.095)


class HeldOutTests(unittest.TestCase):
    """40 other notes and 25 other queries (gathered after the rule was fixed, never used to tune it; `gather_meaning_scores.py heldout`).

    Measured when written: precision 0.75, recall 0.94, a right note shown for 15 of 16 meaning queries, nothing shown for 7 of 9 queries
    that should show nothing. The two that showed something are arguable: "where to buy groceries" showed "Weekly shop" and "molecular
    biology of yeast" showed "Bread machine". The bounds are loose on purpose: they catch a rule that stopped working, not a drift of a few points.
    """

    def test_it_is_a_different_set(self):
        self.assertEqual(len(HELDOUT["notes"]), 40)
        self.assertEqual(len(HELDOUT["queries"]), 25)
        self.assertFalse({n["title"] for n in HELDOUT["notes"]} & {n["title"] for n in FIXTURE["notes"]})
        self.assertFalse({q["query"] for q in HELDOUT["queries"]} & {q["query"] for q in FIXTURE["queries"]})
        self.assertEqual(HELDOUT["model"], FIXTURE["model"])

    def test_the_named_examples_find_their_notes(self):
        by_query = {query["query"]: query for query in HELDOUT["queries"]}
        for query, title in (("saving for retirement", "Pension pot"), ("learning an instrument", "Piano lessons"), ("my son's homework", "Maths homework help"), ("cryptocurrency mining rigs", "GPU build")):
            self.assertIn(title, shown(by_query[query]), query)

    def test_gibberish_and_stopwords_show_nothing(self):
        for query in HELDOUT["queries"]:
            if query["kind"] in ("gibberish", "stopwords"):
                self.assertEqual(shown(query), [], query["query"])

    def test_precision_and_recall_hold_up_on_notes_and_queries_it_was_not_tuned_on(self):
        precision, recall, found, silent = table(fixture=HELDOUT)
        self.assertGreaterEqual(precision, 0.6)
        self.assertGreaterEqual(recall, 0.8)
        self.assertGreaterEqual(found, 13)  # of 16
        self.assertGreaterEqual(silent, 6)  # of 9


class SmallNotebookTests(unittest.TestCase):
    """Under 8 notes a median says little (one right note is a third of 3), so the typical median stands in for it."""

    def test_a_notebook_of_six_still_finds_the_right_note_and_stays_quiet_for_noise(self):
        def only(query):
            return set(UNRELATED + query["expect"][:1])

        precision, recall, found, silent = table(only)
        self.assertEqual((round(precision, 2), round(recall, 2), found, silent), (1.0, 0.83, 15, 7))

    def test_two_notes_with_one_clear_match(self):
        self.assertEqual(select_meaning([("match", 0.78), ("other", 0.56)], 5), [("match", 0.78)])
        self.assertEqual(select_meaning([("a", 0.66), ("b", 0.62)], 5), [])


if __name__ == "__main__":
    unittest.main()
