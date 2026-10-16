"""Measure search by meaning on the real engine and write tests/fixtures/meaning-scores.json (F-080).

The fixture is what `tests/test_meaning_search.py` checks the ranking rule (`meaning_rank.py`) against, so the rule stays tied to real
scores without a network. Run it again after the model or the embedding size changes:

    PERSONAL_NOTE_SEARCH_DIR=<folder with the search download> .venv/bin/python scripts/gather_meaning_scores.py

It never touches a notebook: it embeds the notes below the way the index does (title + text, as documents) and each query as a query,
and records the cosine of every pair. `expect` lists the notes a person would call the right answer ([] = nothing should show).
"""

import json
import os
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from search_runtime import default_search_runtime  # noqa: E402

NOTES = [
    ("Sleep log", "Woke at four again. Lay there for two hours with my mind racing, dozed off near dawn, dragging through the afternoon."),
    ("Winter garage notes", "The engine will not turn over below freezing. Replace the 12V cell before December and keep jumper cables in the boot."),
    ("Budget 2026", "Cancel the streaming subscriptions nobody uses, track groceries weekly, rent is forty percent of income, aim to save 500 a month."),
    ("Lisbon plan", "Flights in February, hotel in Alfama, pastel de nata every morning, day trip to Sintra, trams are slow but pretty."),
    ("Talk prep", "Rehearse the opening twice, breathe slowly before going on, shaky hands are normal, slides for Thursday's demo to the board."),
    ("Sourdough", "Feed the starter at 8, 500g flour 350g water 10g salt, fold every 30 minutes, bake in a dutch oven at 240 degrees."),
    ("Tomato bed", "Plant seedlings after the last frost, stake them early, pinch off the side shoots, water at the roots in the morning."),
    ("Books to read", "The Overstory, Piranesi, a history of salt, Braiding Sweetgrass, the new translation of Anna Karenina."),
    ("Standup notes", "Migration finished on staging, waiting on legal for the privacy copy, Priya out Friday, retro moved to Monday."),
    ("Mum's birthday", "She likes gardening and detective novels. Maybe a good trowel set, or the boxed Christie collection. Order by the 10th."),
    ("Knee rehab", "Physio says straight leg raises, three sets of twelve, no running for six weeks, ice after the session."),
    ("Marathon training", "Long run Sunday, tempo Wednesday, easy miles otherwise. Peak week is 70 km. Taper starts three weeks out."),
    ("Postgres tips", "EXPLAIN ANALYZE before adding an index. Partial indexes for soft deletes. Vacuum settings on the big tables."),
    ("Python packaging", "Use pixi for environments, pin the lockfile, never pip install into the global interpreter."),
    ("Kitchen shelves", "Two oak shelves, hidden brackets, 18 mm thick, stud finder first, level it twice."),
    ("Passport renewal", "Form DS-82, two photos, fee 130, takes about eight weeks, expedite costs 60 more."),
    ("Dentist", "Check-up on the 14th, ask about the wisdom tooth, floss more, new toothbrush heads."),
    ("Team offsite", "Book a venue for twelve, vegetarian options, a walk in the hills, no slide decks, finish by four."),
    ("Podcast ideas", "Interview a beekeeper, a lock picker, a cartographer. Keep episodes under 30 minutes."),
    ("Guitar practice", "Scales for ten minutes, then the Travis picking exercise, learn the bridge of the song slowly with a metronome."),
    ("Lentil soup", "Onion, carrot, celery, red lentils, cumin, lemon at the end. Freezes well. Serves six."),
    ("Apartment hunting", "Needs: south facing windows, quiet street, under 1800, ten minutes from the station, allows cats."),
    ("Cat vet", "Vaccination due in March, she is losing a little weight, switch to the senior food and weigh her monthly."),
    ("Photography", "Golden hour is the first hour after sunrise. Shoot in RAW, underexpose slightly, clean the sensor."),
    ("Tax paperwork", "Collect receipts, the freelance invoices, the donation letters, the mortgage interest statement. File before April."),
    ("Chess openings", "Learn the Caro-Kann properly, study three model games, avoid gambits when tired."),
    ("Meditation", "Ten minutes in the morning, count breaths to ten and start over, do not judge the wandering."),
    ("Moving boxes", "Label by room, books in small boxes, wrap glasses in towels, keep a box of first-night essentials."),
    ("Wine notes", "The Rioja from the corner shop was excellent with lamb. A cheaper Chianti worked for pizza night."),
    ("Learning Spanish", "Practice with a tutor twice a week, read children's books, keep a list of new verbs, watch the news slowly."),
    ("Mortgage options", "Fixed for five years at 4.1 percent or a tracker at base plus 0.9. Deposit is 20 percent, the broker wants payslips and bank statements. Compare total cost over the term."),
    ("Pasta carbonara", "Guanciale, egg yolks, pecorino, black pepper. Toss off the heat so the eggs do not scramble. Save a cup of pasta water."),
    ("Insomnia ideas", "No screens after ten, cooler bedroom, magnesium, try the sleep restriction schedule for two weeks, write worries down before bed."),
    ("Bike repair", "Rear tyre keeps going flat, check the rim tape, replace the inner tube, chain needs oil, brake pads worn on the left."),
    ("Wedding speech", "Open with the story about the lost luggage, thank both families, keep it under five minutes, end with a toast."),
    ("Houseplants", "The fern wants indirect light and wet soil, the cactus wants almost nothing, repot the monstera in spring."),
    ("Job interview prep", "Prepare three stories with numbers, research the team's last product launch, ask about on-call, send a thank-you note."),
    ("Sunday meal prep", "Roast a tray of vegetables, cook a big pot of rice, grill chicken thighs, portion into boxes for the week."),
    ("Reading group", "Next meeting at Tom's on the 3rd, we are on chapter nine, bring the questions, snacks are on Ellie."),
    ("Car insurance", "Renewal quote is up 18 percent, compare three sites, check the no-claims bonus carries over, excess is 250."),
    ("Back pain", "Desk too low, stand every thirty minutes, hip flexor stretches, see the osteopath if it is still there in two weeks."),
]

# (query, kind, [titles of the notes that are the right answer])
QUERIES = [
    ("why am I always exhausted", "meaning", ["Sleep log", "Insomnia ideas"]),
    ("how do I get the car running in the cold", "meaning", ["Winter garage notes"]),
    ("ways to spend less money each month", "meaning", ["Budget 2026"]),
    ("somewhere warm to travel in winter", "meaning", ["Lisbon plan"]),
    ("feeling anxious before a presentation", "meaning", ["Talk prep"]),
    ("money for the house loan", "meaning", ["Mortgage options"]),
    ("what to cook for dinner", "meaning", ["Lentil soup", "Pasta carbonara", "Sunday meal prep"]),
    ("trouble sleeping", "meaning", ["Insomnia ideas", "Sleep log"]),
    ("my elbow hurts after exercise", "meaning", ["Knee rehab"]),
    ("gift for my grandmother", "meaning", ["Mum's birthday"]),
    ("flat tyre", "meaning", ["Bike repair"]),
    ("things to say at my friend's marriage", "meaning", ["Wedding speech"]),
    ("keeping my plants alive", "meaning", ["Houseplants", "Tomato bed"]),
    ("how to prepare for being asked questions by a hiring manager", "meaning", ["Job interview prep"]),
    ("sore shoulders from sitting all day", "meaning", ["Back pain"]),
    ("cheaper premiums for my vehicle", "meaning", ["Car insurance"]),
    ("learning another language", "meaning", ["Learning Spanish"]),
    ("lighthouse", "word", []),
    ("asdkjh qwpoe zxmn", "gibberish", []),
    ("the", "stopwords", []),
    ("hello world", "stopwords", []),
    ("a b c", "stopwords", []),
    ("quantum chromodynamics", "off-topic", []),
    ("medieval siege warfare", "off-topic", []),
    ("tax returns for my freelance work", "meaning", ["Tax paperwork"]),
]


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b))


def main():
    folder = os.environ.get("PERSONAL_NOTE_SEARCH_DIR")
    if not folder:
        sys.exit("Set PERSONAL_NOTE_SEARCH_DIR to a folder holding the search download.")
    runtime = default_search_runtime(Path(folder) / "x.db", pid_name="engine-gather.pid")
    try:
        documents = runtime.embed(NOTES, kind="document")
        queries = [runtime.embed([query], kind="query")[0] for query, _, _ in QUERIES]
        model = runtime.model_id
    finally:
        runtime.shutdown()
    fixture = {
        "about": "Real-engine scores for the ranking rule in meaning_rank.py (F-080). Regenerate with scripts/gather_meaning_scores.py.",
        "model": model,
        "gathered": date.today().isoformat(),
        "notes": [{"title": title, "text": text} for title, text in NOTES],
        "queries": [
            {"query": query, "kind": kind, "expect": expect, "scores": {title: round(cosine(vector, doc), 4) for (title, _), doc in zip(NOTES, documents)}}
            for (query, kind, expect), vector in zip(QUERIES, queries)
        ],
    }
    target = ROOT / "tests" / "fixtures" / "meaning-scores.json"
    target.write_text(json.dumps(fixture, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(NOTES)} notes, {len(QUERIES)} queries -> {target}")


if __name__ == "__main__":
    main()
