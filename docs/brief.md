# Product brief

Status: approved
<!-- Written with you by /clarify. Only you approve it: the line above changes from
     draft to approved when you say so. Claude doesn't start designing or building a new
     product or feature until it's approved. A new feature gets its own brief in
     docs/briefs/<feature>.md, same sections, shorter. -->

## Why (the mission)
- Why this exists, in one sentence: the best second brain, with an interface no notes app has — draw.io-style page growth: drag anything past the page edge and a new page appears, keep going and it's effectively infinite, delete it and the pages collapse back to one — and that agents can work with as easily as I can.
- Why now, and why you: I already work through agents (Claude Code) and voice every day; my notes are the one place they can't reach, and no notes app does expand/shrink.
- If it disappeared tomorrow, who would miss it and what would they do instead? Me. I'd go back to scattered notes plus draw.io for anything spatial, with nothing agents can read.

## Who it's for
- The one person it's for first, in one line: me — a solo founder running many projects who thinks spatially and works through agents. Selling it comes later, after it has earned daily use.
- The moment they reach for it (their trigger): thinking through a project where writing and sketching mix, or when Claude Code needs my context. (assumed)
- What they use today, and what's wrong with it: Obsidian-style notes (linear, no real canvas) and draw.io (spatial, but not a notebook, not searchable, not agent-readable).

## What it does
- The core job, as one verb phrase: think on a page that grows into a canvas, and let my agents read and write it.
- What v1 does (3 things at most):
  1. Silky-smooth expand/shrink canvas (page growth already exists): fast typing plus drop, move and connect objects, with pages adding and removing as content moves.
  2. Agent access through a CLI (search, read, write notes) — Claude Code is the first client.
  3. Fast search across everything.
- What it deliberately does not do (out of scope): sync, iOS, browser extension, Mac menu bar capture, encryption vault, meeting-note automation, generated interfaces (CopilotKit), skins marketplace, selling. All are later phases, in that rough order: capture + PARA → encrypted items → sync + iOS.

## How it should look and feel
- Three words for how it should feel: minimal, colorful, delightful — compact and fun, unmistakably a notebook; Apple-level craft.
- Apps or sites it should feel like, and what to borrow from each: draw.io (expand/shrink, connectors), Obsidian (agent hooks, fast local), Tony Buzan's iMindMap (mind maps as a built-in note type).
- House style (Terminal Ledger) or explore a new direction? Explore a new direction with the designer. Built on theme tokens so 2–3 skins ship in v1 (assumed); custom skins later.
- The one screen that matters most, and what someone does on it: the note canvas — type, drop and connect objects, and watch pages grow and shrink. It has to stand out. Second: a cover/landing page that feels like a notebook's cover.

## How we'll know it worked
- The behaviour or number that says it's working: I open it every working day for 2 weeks, and Claude Code reads or writes my notes at least once a day in that time.
- What "done" means for v1: canvas stays smooth with connectors and hundreds of objects across many pages; agents can search, read and write notes through the CLI; new look with 2–3 skins; then the 2-week daily-use test passes. (assumed)

## Constraints and risks
- Money, time, data, tenancy, compliance, anything else that limits us: solo founder across 10–15 projects; single user, no tenancy in v1; personal data stays local.
- The riskiest assumption, and the cheapest way to test it: the current canvas engine (Fabric.js) stays silky with connectors and hundreds of objects across many pages. Test with a throwaway stress prototype before building more on it; switch engines if it fails.

## Decisions and trade-offs
- Expand/shrink = draw.io page growth (already built): pages add as objects cross the edge and collapse when emptied; v1 work is making it smooth and adding connectors, not inventing it.
- For me first, not a product yet: every choice gets tested on real daily use; slower path to revenue.
- V1 wedge is expanding canvas + agent CLI: this is the part no other app has, and much of it exists here already; quick capture, meetings and encryption wait.
- Local desktop app, sync later: fast, private, agents can reach the local database directly; phone and browser capture wait for sync.
- New visual direction instead of the current dark shell or house style: the look can match how new the interface is; costs design time before building.
- Keep Fabric.js (stress test 2026-09-30: 600 objects / 12 pages / 50 connectors stays at ~60fps once the canvas is window-sized with pan/zoom via viewportTransform; today's page-grid-sized canvas drops to 3–4fps and blanks at high retina zoom): no engine switch; costs a canvas-layout rework before new canvas features.
- Reverses the old v1 brief (docs/PRODUCT-BRIEF.md) on agent access: agents are now a first-class client.

## Open questions
- None. Deferred: capture everywhere + PARA, encrypted items, meeting notes, sync + iOS, voice-driven queries, CopilotKit.
