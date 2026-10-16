"""Which meaning matches are worth showing (F-080). Pure: no database, no engine.

A cosine score means little alone: it depends on the notebook and on the query (a stopword or gibberish scores 0.65-0.72 against some
note, a right answer 0.66-0.83). What tells a right note apart is how far it stands above the notebook's ordinary score for that same
query, so the rule works on that gap. Chosen from real EmbeddingGemma 2 scores (256 dimensions): 41 notes, 25 queries, in
`tests/fixtures/meaning-scores.json` (`scripts/gather_meaning_scores.py` makes it), which `tests/test_meaning_rank.py` checks:

- a note is shown only if it scores at least MEANING_GAP over the median score of all the notebook's notes for the query: right
  answers stood 0.103-0.268 above it (the best of each query), noise (gibberish, "the", "hello world", off-topic) at most 0.088;
  the gap sits between the two;
- and at least MEANING_BAND of the best score, so a weaker note is not listed next to a strong one (0.04 gave the best precision of the bands
  tried, 0.04 to 0.08, with the same recall);
- and at least MEANING_FLOOR in absolute terms, a safety net for a notebook whose median is oddly low.

Under SMALL_COLLECTION notes the median says little (with 3 notes, one right one is a third of them), so the typical median of the
fixture, SMALL_BASELINE, stands in for it: a small notebook shows a note scoring at least 0.60 + 0.095.
"""

import statistics

MEANING_GAP = 0.095
MEANING_BAND = 0.04
MEANING_FLOOR = 0.55
SMALL_COLLECTION = 8
SMALL_BASELINE = 0.60


def select_meaning(scores, limit=5):
    """`scores` is [(key, cosine)] for every searchable note, any order. Returns the ones to show, best first, at most `limit`."""
    if not scores:
        return []
    ranked = sorted(scores, key=lambda pair: -pair[1])
    baseline = statistics.median(score for _, score in ranked) if len(ranked) >= SMALL_COLLECTION else SMALL_BASELINE
    best = ranked[0][1]
    bar = max(baseline + MEANING_GAP, best - MEANING_BAND, MEANING_FLOOR)
    return [(key, score) for key, score in ranked if score >= bar][:limit]
