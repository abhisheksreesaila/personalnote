"""Jam brain spike (F-086): feed spoken transcripts through a brain, print the edits as a tree and seconds per turn.

    python scripts/jam_spike.py claude [--model sonnet]
    python scripts/jam_spike.py openai --base-url https://api.openai.com/v1 --model gpt-4.1-mini
    python scripts/jam_spike.py azure --endpoint https://NAME.openai.azure.com --deployment DEPLOY [--api-version 2024-10-21]

The openai and azure brains read the key from PERSONAL_NOTE_JAM_API_KEY (never printed). Add --only product|trip|decision.
"""

import argparse
import copy
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import jam_brain  # noqa: E402

SESSIONS = {
    "product": ("Dog food delivery", [
        "Okay so the idea is a subscription for dog food, like you tell us the breed and the weight and we send the right "
        "amount every month. The problem is people run out on a Sunday and the pet shop is shut, and big bags are heavy "
        "to carry. I think the first customers are people with big dogs in flats, because they cannot drive to a shop easily.",
        "Pricing, hmm, maybe a bit more than the supermarket but you can pause or skip. And we need a vet to sign off the "
        "feeding plans, otherwise nobody trusts it. Oh and the packaging, it should be one box that folds flat so the courier "
        "does not hate us.",
    ]),
    "trip": ("Japan in April", [
        "We want to go to Japan for two weeks in April for the cherry blossom. Tokyo for the first five days, then Kyoto, "
        "and I would love to see Hiroshima too but that might be too much. Budget is around five thousand pounds for two of us.",
        "Flights are the big cost so we should book early. For Kyoto I want a proper ryokan for at least one night, and my "
        "partner wants to do a day hike, maybe Mount Koya. We need to sort the rail pass question, I heard it got more expensive.",
    ]),
    "decision": ("Leave my job?", [
        "I have been at the company for six years and I am bored. There is a startup offer, less salary but equity, and "
        "my manager just offered me a team lead role here. The mortgage is the thing, we cannot drop below four thousand a month.",
        "What scares me is that the startup is only eight months old and I would be the first backend hire. But I would learn "
        "so much more and I actually like the founder. If I stay I would manage people and write less code, which I do not love.",
    ]),
}


def apply(map_json, edits):
    """Spike-only applier: adds the branches (ghosts and reactions are only shown, not stored)."""
    out = copy.deepcopy(map_json)
    for number, e in enumerate(edits.branches, len(out["nodes"])):
        out["nodes"].append({"id": e.id or f"auto-{number}", "parentId": e.parent_id, "text": f"{e.emoji} {e.text}".strip()})
    return out


def print_tree(map_json, edits, new_ids):
    votes = {r.node_id: r for r in edits.reactions}
    ghosts = {}
    for g in edits.ghosts:
        ghosts.setdefault(g.parent_id, []).append(g)

    def walk(node_id, depth):
        node = next(n for n in map_json["nodes"] if n["id"] == node_id)
        vote = votes.get(node_id)
        mark = f"  [thumbs {vote.vote}: {vote.reason}]" if vote else ""
        print("    " + "  " * depth + f"- {node['text']}{' (new)' if node_id in new_ids else ''}{mark}")
        for g in ghosts.get(node_id, []):
            print("    " + "  " * (depth + 1) + f"- ? {g.text}  (ghost: {g.why})")
        for child in [n for n in map_json["nodes"] if n.get("parentId") == node_id]:
            walk(child["id"], depth + 1)

    walk(map_json["rootId"], 0)


def make_brain(args):
    if args.brain == "claude":
        return jam_brain.ClaudeCodeBrain(model=args.model)
    if args.brain == "azure":
        return jam_brain.OpenAICompatibleBrain(azure_endpoint=args.endpoint, deployment=args.deployment,
                                               api_version=args.api_version)
    return jam_brain.OpenAICompatibleBrain(args.base_url, args.model)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("brain", choices=["claude", "openai", "azure"])
    ap.add_argument("--model")
    ap.add_argument("--base-url")
    ap.add_argument("--endpoint")
    ap.add_argument("--deployment")
    ap.add_argument("--api-version", default="2024-10-21")
    ap.add_argument("--only", choices=list(SESSIONS))
    args = ap.parse_args()
    brain = make_brain(args)
    times = []
    for name, (title, turns) in SESSIONS.items():
        if args.only and args.only != name:
            continue
        print(f"\n== {name}: {title}")
        current = {"version": 1, "title": title, "rootId": "root",
                   "nodes": [{"id": "root", "parentId": None, "text": title}]}
        pending = []
        for number, said in enumerate(turns, 1):
            start = time.monotonic()
            try:
                edits = jam_brain.propose(current, said, brain, pending)
            except jam_brain.JamError as exc:
                print(f"  turn {number}: ERROR {exc}")
                continue
            seconds = time.monotonic() - start
            times.append(seconds)
            pending = list(edits.ghosts)
            before = {n["id"] for n in current["nodes"]}
            current = apply(current, edits)
            new_ids = {n["id"] for n in current["nodes"]} - before
            print(f"  turn {number}: {seconds:.1f}s  {len(edits.branches)} branches, "
                  f"{len(edits.reactions)} reactions, {len(edits.ghosts)} ghosts")
            for note in edits.dropped:
                print(f"    (trimmed: {note})")
            print_tree(current, edits, new_ids)
    if times:
        print(f"\n{len(times)} turns, mean {sum(times) / len(times):.1f}s, max {max(times):.1f}s")


if __name__ == "__main__":
    main()
