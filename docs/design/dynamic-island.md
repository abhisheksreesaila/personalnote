# Design handoff: the dynamic island (title pill → island)

Prototype: `dynamic-island/prototype.html` (open it in a browser; "Make something happen" plays each moment). Chosen: **Option A ·
Shrinking island** (captain, 2026-10-16: "genius… it has to be done… it has to be performant… lightweight"). Brief:
docs/briefs/chrome-islands.md (the title pill section, amended 2026-10-16).

## Resting layout: four corners, one island
- Top left: the notes button (44px circle). Top right: **search as a 44px circle** (lucide `search`), the mirror of the notes button.
  The Focus pill is gone; Focus lives in the island (below). Bottom left undo/redo, bottom right zoom, right edge the tool island.
- Top centre: the island. At rest it is only the note title, one line, 13.5px/600, ellipsis, max 300px; no save text, no ⋯.

## Moments (the island grows, says it, shrinks back)
| Moment | Face | Stays |
|---|---|---|
| A routine save | nothing changes size; the title stays | — |
| A save still pending after 3 s | spinner + "Saving" | until saved, then "Saved ✓" 1.2 s |
| Save failed | ⚠ "Couldn't save" + reason + "Try again" (danger edge) | until it saves |
| Voice recording | dark island: red dot, live level bars, "Listening", clock, "Stop" | while recording, then "Added N words" 1.5 s |
| An agent changed the note | ✦ "**Claude** edited this note" + "Show" + "Undo" (replaces the agent chip) | 4 s, or until clicked |
| A voice or search download | ↓ name + thin progress bar + % | while it runs, then "… is ready" 1.5 s |
| Focus mode | the focus strip's job: title · N words · "Leave focus Esc" | visible on hover at the top, as today |

Click the island at rest → a card (420px; 350px phone): editable title, "Saved on this Mac · when" and the notebook, then a grid:
**Focus (⌘.)** first and wide, then Print, Picture, Backup, Markdown, Obsidian, Fold all, Settings, Clear all (danger). Esc or a
click outside closes it. Everything the ⋯ menu had stays reachable; ⌘., ⌘K, ⌘P unchanged.

## Search
The top-right circle grows leftward into the search field (≈360px) in place, results drop below it, anchored top right; Esc,
picking a result or a click away shrinks it back to the circle. Same keyboard, groups and "New note" row as the omnibar today.

## Motion and weight (hard requirements)
- Mac: width/height transition 180ms ease-out with a 120ms content cross-fade; no springs, zooms or blur. Phone: spring
  (cubic-bezier(.28,1.32,.5,1), 420ms). `prefers-reduced-motion`: no transition.
- Measure once per change of face (one hidden measure, no per-frame layout). No timers or animation frames while at rest;
  the level bars run only while recording. Nothing reacts per keystroke.
- Speed test (typing p50/p99) unchanged; bundle budget held.

Agent face: message only for now. Show and Undo are deferred to a follow-up ticket (the app has no such actions yet).
