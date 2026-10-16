# Jam sessions: talk, and Claude grows the mind map

Status: approved
<!-- Approved 2026-10-16: the captain said "run this in autopilot and just ship it however you see fit" after reading the drafts.
2026-10-16, captain by voice after preview 8: "the brainstorming session is a wall of text … I want to talk and
brainstorm … see different branches following Tony Buzan principles … a ghost branch saying hey what about this idea and
I say yes … thumbs up, emojis … I need that very badly". Two clarify rounds; (assumed) marks calls the captain left open. -->

## Why (the mission)
- Why this exists, in one sentence: brainstorming with Claude today ends as a wall of text to re-read; a jam turns the talk into a mind map you can see whole and choose from.
- Why now: voice (Nemotron, on device) and mind-map notes already exist; the brain can be Claude Code on the captain's own machine (his Claude plan, no API key) or a model he already pays for on Azure.
- If it disappeared tomorrow: back to chat transcripts and remembering what was said.

## Who it's for
- First: the captain, at the Mac, thinking out loud about an idea (a product, a plan).
- The moment: an idea is half-formed and he wants to talk it through, see the shape and pick a direction.
- Today: Claude chat, a long transcript; the mind map is drawn by hand.

## What it does
- The core job: grow a Buzan mind map from what you say.
1. **New jam** makes a mind-map note in jam mode, with the centre idea from its title. Hold the mic and talk; your words appear as a live line.
2. **"Jam"** (the button, or saying "jam" at the end) hands that turn to Claude. Claude adds branches from what you said (short keywords, one idea per branch, curved branches, colour per main branch, an emoji where it helps: Buzan), puts 👍 or 👎 on ideas with a one-line reason on hover, and offers 1 to 3 faint **ghost branches** ("what about…"). Say or click yes and a ghost becomes real; no, and it fades.
3. Claude only **adds and reacts**: it never deletes, renames or moves your branches. Every Claude change is one undo step. The result is just the map, an ordinary mind-map note afterwards (searchable, exportable).
- **The brain is your choice** (Settings → Jam): **Claude Code** on this machine (your Claude plan), or **any OpenAI-compatible model**: Azure OpenAI (endpoint, deployment, key) or any base URL + model + key. "Claude" in this brief means whichever brain is picked. The key is kept in the system keychain, never in the database, backup or export (assumed).
- Not now: Claude speaking back (voice out), a written summary, action items to Inbox, jams on canvas or page notes, Claude growing the map while you are still talking, other people.

## How it should look and feel
- Three words: playful, calm, visible.
- Like: a Buzan hand-drawn map (thick tapering main branches, keywords on lines, colour per branch); Apple's dictation (the live line); tldraw's AI "make real" moment (one press, the thing grows).
- House style: the Personal Note skins; the mind-map editor's current look, extended with ghost branches, 👍/👎 and emojis (designer round in Stitch first).
- The one screen: the map mid-jam: your new branches growing, two ghosts waiting, the mic.

## How we'll know it worked
- The captain jams an idea for 10 minutes and ends with a map he would rather look at than the transcript.
- "Done" for v1: talk → jam → branches + ghosts + 👍/👎 in under ~10 s per turn on the Mac; accept a ghost with one click or "yes"; every Claude change undoable; works only when Claude Code is installed and signed in, and says so plainly when it isn't.

## Constraints and risks
- **One brain option is the captain's own Claude Code** (`claude -p`, run by the app on his machine, on his plan). Anthropic's terms on subscription use outside Claude Code itself shifted in 2026; running his own CLI for himself on his own machine is the case we rely on (assumed). Re-check before ever shipping this to anyone else, who would bring their own sign-in or API key.
- AGENTS.md invariant 8 ("no generative model worker … agents act only when they run the CLI") changes: one optional, opt-in local generative worker, started only by a jam turn, sending only that jam's map and transcript to the chosen brain (Claude Code or the configured OpenAI-compatible endpoint). Needs an ADR.
- The desktop app on the Mac starts with a bare PATH: find `claude` in the usual install places (assumed).
- Riskiest assumption: the brain returns good map edits fast enough per turn. Cheapest test: a script that feeds three real transcripts plus a map to `claude -p` and to an Azure deployment with the same map-edit schema, and times both, before any UI.
- Plan limits: one Claude call per "jam", never per word (that's why "when I say so").

## Decisions and trade-offs
- Lives in Personal Note, not abode or a claude.ai artifact: reuses voice and mind maps, the maps land with the notes; con: the invariant 8 change and Mac-only-where-Claude-Code-is-signed-in.
- Claude joins when you say "jam": calm and light on plan limits; con: less live magic.
- Add and react, never remove: the map stays yours; con: you tidy it yourself.
- Just the map: no wall of text, the point of the feature; con: nothing written to share.

- Brain is pluggable (Claude Code or OpenAI-compatible, incl. Azure): use what's paid for, swap models; con: two adapters to keep working and prompts tuned for both.

## Open questions
- Does saying "jam" work reliably with Nemotron, or is it the button only at first? (test in the spike)
