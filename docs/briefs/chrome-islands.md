# Floating islands: less chrome around the note

Status: approved
<!-- 2026-10-15: the captain asked for Stitch-style chrome (one button for the notes, a side dock with fewer controls), picked
the Stitch screens labelled "APPROVED 1" and "APPROVED 2 - FOCUS MODE", and said "go ahead". Calls the screens leave open
are marked (assumed); the captain can overturn any of them.
2026-10-16, after using preview 8: the notes panel sits beside the note on a wide window (it covered the page and looked
lopsided), the eraser joins the island's main tools, and the title pill is to become contextual like a dynamic island
(prototype first). Later that day the captain chose prototype Option A (docs/design/dynamic-island.md), moved Focus
into the island and made search a top-right circle that expands, so the four corners mirror each other. -->

## Why (the mission)
- Why this exists, in one sentence: the note should own the screen; today a sidebar that's always open, a top bar of buttons and a 17-control dock surround it.
- Why now: the app works well; what's left is clutter, and the touch version later needs bigger, fewer targets.
- If it disappeared tomorrow: the notebook keeps feeling like a busy tool instead of paper on a desk.

## Who it's for
- First: the captain on the Mac with keyboard and mouse; later the same layout with a finger or pencil.
- The moment: writing and sketching on a note with nothing else in view, and finding another note with one button.

## What it does
Everything floats as small rounded islands over the dotted desk, inset from the window edge (Stitch "APPROVED 1").
1. **One notes button.** A round button at the top left opens the notes panel (today's sidebar: Quick note, Inbox, Projects, Areas, Resources, Archive, skin dots) as a floating panel over the desk; the button, Esc or a click on the desk closes it. Closed by default; open or closed is remembered on this machine (assumed). Opening a note keeps the panel open on a wide window and closes it on a narrow one (assumed). The icon is a panel icon, never a hamburger.
2. **A title pill at the top centre** (from "APPROVED 2"): the note title (editable, as now) and the save state ("Saved", or the error in its place). A ⋯ button in the pill holds share/export, clear all, fold all and settings (assumed: the approved screens drop those buttons, so they move here instead of vanishing). The breadcrumb goes (the notebook shows in the notes panel) (assumed).
3. **Top right: Focus and search.** A Focus button (today's focus mode, ⌘. still works) beside the search pill (today's omnibar, ⌘K still works) (assumed: search moves back to the top right, as both screens show).
4. **A side tool island** on the right edge, vertically centred: select, text, pen, eraser, shape, sticky; one colour dot showing the current colour, which opens today's colour and width options; a **+** that opens the rest (hand, highlighter, connect, image, prettify); and the round mic at the foot. Every tool keeps its keyboard shortcut and hold-for-options. Mind-map notes show their own actions in the same island.
5. **Corner islands:** undo/redo bottom left; zoom (−, %, +, fit) bottom right. The page minimap leaves the resting view (assumed; its page count moves into the fit button's tooltip).
- Not now: the phone layout (bottom tool island and notes sheet are drafted in `docs/design/chrome-islands/phone-*.png`, built later); a formatting bubble on selected text and a word-count footer from "APPROVED 2" (new capabilities, separate brief); a version-history button.

## How it should look and feel
- Three words: quiet, paper, within reach.
- Like Google Stitch's canvas chrome and Figma/tldraw's side tool rail.
- The screen that matters most: a canvas note at rest with the panel closed ("APPROVED 1").
- Motion on the laptop: short fades only (taste file).

## How we'll know it worked
- At rest on 1280×800 only the note, five small islands and the paper are visible.
- Every action that was on screen before is still reachable in one or two clicks, and every shortcut still works.
- Typing speed (speed test row) and every verify-* script still pass.
