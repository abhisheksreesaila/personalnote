"""Measure search by meaning on the real engine and write tests/fixtures/meaning-scores.json (F-080).

The fixture is what `tests/test_meaning_rank.py` checks the ranking rule (`meaning_rank.py`) against, so the rule stays tied to real
scores without a network. Run it again after the model or the embedding size changes:

    PERSONAL_NOTE_SEARCH_DIR=<folder with the search download> .venv/bin/python scripts/gather_meaning_scores.py [heldout]

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


# The held-out set (F-080): written after the rule was chosen, on other notes and other queries, and never used to tune it.
# `python scripts/gather_meaning_scores.py heldout` writes tests/fixtures/meaning-scores-heldout.json.
HELDOUT_NOTES = [
    ("Pension pot", "Employer matches up to 5 percent, the index fund is the default, check the old workplace plan, aim for half my salary by sixty-seven."),
    ("Piano lessons", "Thursday evenings, Mrs Okafor, practise the Clementi sonatina, scales hands together, buy a metronome for the keyboard."),
    ("Maths homework help", "Fractions and long division tonight, Leo gets stuck on word problems, use the number line, ask his teacher about the spelling test too."),
    ("GPU build", "Six cards on an open frame, 1600W supply, hashrate per watt, electricity is the whole margin, ethereum is gone so pick another coin."),
    ("Garden fence", "Replace three rotten panels, concrete posts, treat the timber, neighbour agreed to split the cost."),
    ("Roof leak", "Water stain above the bathroom, call the roofer, check the flashing around the chimney, photo for the insurer."),
    ("Anniversary dinner", "Book the little place by the canal for the 12th, ask for the corner table, buy flowers on the way."),
    ("Thesis outline", "Chapter two needs the literature review rewritten, supervisor wants more on method, deadline for the draft is the end of March."),
    ("Bread machine", "Basic white setting, 400g flour, a spoon of sugar, remove the paddle before the last rise."),
    ("Dog training", "Sit and stay before the walk, treats in the left pocket, do not let him pull, puppy class is on Saturdays."),
    ("Airport transfer", "Train from the central station at 6:10, then the shuttle, check the baggage allowance, passport in the front pocket."),
    ("Spreadsheet formulas", "XLOOKUP instead of VLOOKUP, SUMIFS for the monthly totals, freeze the header row, name the ranges."),
    ("Allergy tablets", "Take one each morning from March, eyes itch worst when the birch is out, check with the pharmacist about drowsiness."),
    ("Sprint retro", "Deploys were too slow, flaky tests blocked two merges, praise for the onboarding doc, action: split the test suite."),
    ("Charity run", "Ten kilometres in June, sponsorship page is live, thank everyone who donated, wear the orange shirt."),
    ("Wi-fi router", "Move it out of the cupboard, change the channel, update the firmware, guest network for visitors."),
    ("Rental agreement", "Notice period is two months, deposit protected in a scheme, no pets without written consent, rent review each January."),
    ("Watercolour class", "Wet on wet for the sky, keep the paper taped, burnt sienna and ultramarine make a good grey, bring a big brush."),
    ("Grandad's stories", "The ship to Canada in 1957, the winter he worked at the mill, how he met Nan at a dance in Leeds."),
    ("Language exchange", "Meet Marta on Tuesdays, half an hour in German then half in English, bring photos to talk about."),
    ("Cold brew", "Coarse grind, one to eight with water, steep for sixteen hours in the fridge, dilute when serving."),
    ("Vaccination record", "Tetanus booster due next year, keep the yellow card, travel clinic needs it six weeks before flying."),
    ("Standing desk", "Set the height so the elbows are at ninety degrees, anti-fatigue mat, alarm every hour to move."),
    ("Board game night", "Bring Catan and the expansion, Sam is bringing snacks, teach the new rules before starting."),
    ("Solar panels", "Quote is 6400 for four kilowatts, payback in nine years, south roof is shaded after three, ask about the battery."),
    ("Student loan", "Repayments start when earnings pass the threshold, interest is added from the first day, no point overpaying yet."),
    ("Sourcing coffee beans", "Roaster in town does Ethiopian and Colombian, buy whole beans, use within a month of the roast date."),
    ("Yoga routine", "Sun salutations to start, hold pigeon pose for a minute each side, finish with five minutes lying still."),
    ("Moth problem", "Wardrobe smells of cedar again, hang the lavender bags, wash the wool jumpers at forty, check the loft boxes."),
    ("Choir rehearsal", "Altos on Wednesdays at seven, new piece in Latin, the concert is in December, bring a pencil for the markings."),
    ("Boiler service", "Annual check due in October, pressure drops weekly so bleed the radiators, engineer is called Dev."),
    ("Kids' birthday party", "Twelve children, a magician at three, pass the parcel, cake with dinosaurs, allergies: Ruby cannot have nuts."),
    ("Podcast notes: sleep science", "Dr Walker says consistent wake times matter more than the hours, caffeine lasts eight hours in the body."),
    ("Neighbour's noise", "Music past midnight twice last week, note the dates, talk to him first before contacting the council."),
    ("Hiking trip", "Three days along the coast path, booking huts early, waterproof socks, a paper map in case the phone dies."),
    ("Resume updates", "Add the migration project, trim the first job to two lines, put numbers on everything, a single page."),
    ("Weekly shop", "Oats, eggs, spinach, tinned tomatoes, olive oil, washing powder, the good cheddar, bin bags."),
    ("Car MOT", "Booked for the 20th, tyres borderline at the front, check the wiper blades, bring the logbook."),
    ("Mindful walking", "Leave the headphones at home, notice five sounds, slow down at the bridge, notebook in the pocket."),
    ("Learning to swim", "Lessons on Sunday mornings, practise breathing out underwater, float on the back first, goggles that fit."),
]

HELDOUT_QUERIES = [
    ("saving for retirement", "meaning", ["Pension pot"]),
    ("learning an instrument", "meaning", ["Piano lessons"]),
    ("my son's homework", "meaning", ["Maths homework help"]),
    ("cryptocurrency mining rigs", "meaning", ["GPU build"]),
    ("fixing a hole above the bathroom", "meaning", ["Roof leak"]),
    ("a romantic meal out", "meaning", ["Anniversary dinner"]),
    ("writing my dissertation", "meaning", ["Thesis outline"]),
    ("puppy obedience", "meaning", ["Dog training"]),
    ("getting to the airport", "meaning", ["Airport transfer"]),
    ("hay fever", "meaning", ["Allergy tablets"]),
    ("paying back my university debt", "meaning", ["Student loan"]),
    ("generating my own electricity", "meaning", ["Solar panels"]),
    ("practising German with a friend", "meaning", ["Language exchange"]),
    ("things to remember about the lease", "meaning", ["Rental agreement"]),
    ("clothes eaten by insects", "meaning", ["Moth problem"]),
    ("how to sleep better according to experts", "meaning", ["Podcast notes: sleep science"]),
    ("where to buy groceries", "word", []),
    ("asdfgh jklzxc", "gibberish", []),
    ("and", "stopwords", []),
    ("what is the", "stopwords", []),
    ("test", "stopwords", []),
    ("ancient egyptian pyramids", "off-topic", []),
    ("molecular biology of yeast", "off-topic", []),
    ("championship football results", "off-topic", []),
    ("tax on foreign property", "off-topic", []),
]


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b))


def main():
    heldout = "heldout" in sys.argv[1:]
    notes_in, queries_in = (HELDOUT_NOTES, HELDOUT_QUERIES) if heldout else (NOTES, QUERIES)
    folder = os.environ.get("PERSONAL_NOTE_SEARCH_DIR")
    if not folder:
        sys.exit("Set PERSONAL_NOTE_SEARCH_DIR to a folder holding the search download.")
    runtime = default_search_runtime(Path(folder) / "x.db", pid_name="engine-gather.pid")
    try:
        documents = runtime.embed(notes_in, kind="document")
        queries = [runtime.embed([query], kind="query")[0] for query, _, _ in queries_in]
        model = runtime.model_id
    finally:
        runtime.shutdown()
    fixture = {
        "about": ("Held-out " if heldout else "") + "real-engine scores for the ranking rule in meaning_rank.py (F-080). Regenerate with scripts/gather_meaning_scores.py" + (" heldout." if heldout else "."),
        "model": model,
        "gathered": date.today().isoformat(),
        "notes": [{"title": title, "text": text} for title, text in notes_in],
        "queries": [
            {"query": query, "kind": kind, "expect": expect, "scores": {title: round(cosine(vector, doc), 4) for (title, _), doc in zip(notes_in, documents)}}
            for (query, kind, expect), vector in zip(queries_in, queries)
        ],
    }
    target = ROOT / "tests" / "fixtures" / ("meaning-scores-heldout.json" if heldout else "meaning-scores.json")
    target.write_text(json.dumps(fixture, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(notes_in)} notes, {len(queries_in)} queries -> {target}")


if __name__ == "__main__":
    main()
