# Plan

<!-- Tickets, one per vertical slice (each independently shippable and testable).
Status is one of: todo, doing, review, done, blocked. Update it as work moves.
A blocked ticket gets a "Blocked:" line saying exactly what the person has to do.
Format:

## F-001 Tenant signup [done]
Brief: docs/brief.md · Design: docs/design/signup.md · Needs: none
- [x] a new visitor can create a tenant with an email and password
- [x] the tenant gets its own SQLite database
- [ ] a duplicate email shows a clear error

## F-002 Stripe billing [blocked]
Blocked: set STRIPE_SECRET_KEY in Railway, then say go.
- [ ] pricing page uses register_billing_routes
-->

## F-002 Window-sized canvas (smoothness rework) [done]
Brief: docs/brief.md · Design: docs/design/personal-note.md (Engine) · Needs: none
- [x] the canvas is sized to the window; pan and zoom move the view instead of resizing the canvas
- [x] pages still grow when an object crosses an edge and fold back when emptied, without resizing the canvas
- [x] a 600-object, 12-page benchmark note drags, pans and zooms at ~60fps (benchmark script checked in)
- [x] high zoom on retina never paints blank
- [x] print and export output are unchanged
Open: ~60fps verified at normal density; retina zoom-out on a full 600-object note needs a check on real Mac hardware (and objectCaching re-measure).

## F-003 Skins: Crayon default, Paper and Night [done]
Design: docs/design/personal-note.md · Needs: none
- [x] skin tokens live as CSS custom properties per skin; Crayon is the default
- [x] switching skin from the sidebar swatches recolors the app with a 400ms crossfade and is remembered
- [x] print output stays white paper regardless of skin
Open: Night keeps ivory paper on screen (invariant 9); captain to decide on dark paper.

## F-004 New canvas chrome [done]
Design: docs/design/personal-note.md (Layout) · Needs: F-003
- [x] sidebar with Quick note (⌘N), Inbox and Projects / Areas / Resources / Archive notebooks with colored dots
- [x] top bar with note title, "Saved on this Mac" state, search pill (⌘K) and share/export
- [x] floating bottom dock with tools, ink swatches, undo and the hold-to-talk mic
- [x] page minimap with page count, and zoom control
- [x] a ghost "+ Page N" appears while dragging past the edge; dragged objects lift with tilt and shadow
- [x] keyboard panning (arrows, PageUp/PageDown, Home/End; Space is the temporary hand since F-017) and a scroll indicator, since the window-sized canvas (F-002) has no native scrolling

## F-005 Connectors [done]
Needs: F-002
- [x] a connector tool draws an arrow between two objects
- [x] connectors follow both ends live while either object is dragged, including across new pages
- [x] connectors save, reload, undo and export with the note

## F-006 Agent CLI, ready for Claude Code [done]
Needs: none
- [x] `personal-note` search, read (as plain text) and write/append work against the live notebook without breaking revisions
- [x] an agent write shows up in the open app without a reload
- [x] while an agent is reading or writing a note, the app shows the "Claude Code is reading" chip and cursor flag
- [x] AGENTS.md invariant 8 and the product docs updated: agent access is now in scope

## F-007 Cover page (Crayon) [done]
Design: Crayon cover artboard · Needs: F-003
- [x] landing page with the fanned PARA notebooks hero, "a page that grows" steps, "your agents can read it too", skins, final call to open the notebook (no Mac download yet)
- [x] works at phone width without horizontal scroll

## F-008 Agent sync polish [todo]
Needs: F-006, F-002
- [ ] undo right after an agent's text is merged in does not remove the agent's text (record a history snapshot after merge)
- [ ] the agent cursor flag does not cause stutter while dragging on a 600-object note (place it at most once per frame, cache the target block)
- [ ] the flag clears immediately when switching notes
- [ ] the flag follows pan and zoom on the window-sized canvas
- [ ] when a save gives objects new ids, the open app learns them (no duplicate objects or connectors on next sync)
- [ ] duplicate id inside one note that also clashes elsewhere keeps its connector on the first holder

## F-009 Canvas polish after the rework [todo]
Needs: F-002
- [ ] autosave on a 600-object note no longer freezes a frame for 100ms+ (defer or slim serialization)
- [ ] after fold-back or undo the view settles inside the content without a later snap
- [x] the writing guide draws under the text, not over it (moot: guide removed in F-016)
- [ ] on a real retina Mac: zoom-out on the 600-object note stays smooth; decide objectCaching for ink paths
- [ ] large transparent images in WebKit (Mac app) stay PNG because WebP encoding falls back; check and handle
- [ ] verify-objects sticky-lock check asserts the sticky count
- [ ] a note whose save keeps failing doesn't trap you: a second click switches anyway, or "Leave without saving"
- [ ] stale-load guard also after loadFromJSON / mind-map mount
- [ ] pointer tracking clears only the moving pointer's own id (pen + mouse at once)
- [ ] JS bundle is near its 230 KiB budget: trim or split before adding features
- [ ] landing button hover uses the new softer blue (#2459B8), not #0059D6
- [ ] startup error: check notify-send exit status; avoid stacking zenity then kdialog
- [ ] media/ files no note references are cleaned up (every ink/shape save writes new SVGs)
- [ ] saving doesn't parse every other note to reserve block ids (ids table or revision-keyed cache)

## F-010 Save pending edits on close [done]
- [x] edits made just before a reload or close are saved (flush on pagehide / hidden, keepalive under 64 KiB)
- [x] a close-time save never overwrites a newer revision (uses the last confirmed revision)
Known limit: if a save is in flight at close, later edits can be lost; notes over ~60 KiB save on close best-effort. Notes with pictures are that large, so in a browser tab they save on close best-effort (the desktop app waits for the save).

## F-011 Desktop app [done]
Brief: docs/brief.md (local desktop app, v1) · Needs: none
Decision: pywebview native window around the existing local server (no Rust toolchain; Python backend stays in-process). Fabric.js stays: the stress test showed the speed problem was canvas sizing, not the engine.
- [x] one command (`npm run desktop`) opens Personal Note in its own native window, not a browser tab, with the local server on a free loopback port; closing the window stops it cleanly
- [x] the app and `bin/personal-note` use the same notebook database by default, stored in the user's app-data folder; an existing `data/personal-note.db` is kept and used, never moved or deleted
- [x] microphone (hold-to-talk) works inside the window where the OS allows it, with a visible message where it doesn't
- [x] on macOS a double-clickable Personal Note.app can be built with one script (verified on a Mac by the captain); on Linux a launcher entry is provided
- [x] cold start to a usable canvas is measured and reported
Open: Mac .app build and Mac/Linux microphone to be checked by the captain on real hardware.

## F-012 Match the mockup [done]
Design: Crayon-Canvas artboard (canvas link in docs/design/personal-note.md) · Needs: F-004
Captain: "the mock-up was way better"; buttons not as intended; nothing to drop on the canvas.
- [x] Crayon paper is white on screen as in the mockup (print unchanged; Paper and Night keep their paper)
- [x] a note opens zoomed to show whole pages on the dotted desk, with page edges, page labels, and the ghost "+ Page" visible while dragging past an edge
- [x] the dock has Sticky note, Shape and Image tools like the mockup; stickies and shapes save, undo, connect and print
- [x] dock, top bar, sidebar and zoom buttons match the mockup's sizes, radii, glass and states, checked side by side with screenshots in all three skins
Note: notes with more than ~150 objects open on the first page instead of the zoomed-out desk, to keep panning at 60fps.

## F-013 Snappy and tidy [done]
Captain, after first use of the desktop app: page grow/shrink "feels sluggish… has to be rapid, no animation"; two settings buttons are redundant (keep top right); monospace should be the default; Clear all needs a quick place.
- [x] pages appear and fold away instantly when objects cross or leave an edge (no grow/fold animation); zoom, zoom-to-fit and minimap jumps are instant too
- [x] one settings entry point, top right; the sidebar gear is gone and its settings live in the same panel
- [x] new text defaults to monospace (existing notes unchanged)
- [x] Clear all is one click from the top right, and can be undone right after (Undo in a toast and Ctrl/⌘+Z)
- [x] Delete note is undoable for 8 s; switching notes saves the outgoing note first

## F-014 Fastest engine for the Linux app [done]
Captain: "the chromium window feels fast, use that for the launcher."
Needs: F-013
- [x] the same canvas benchmark is measured in the current desktop window (WebKitGTK) and in a Chromium app window on this machine, with GPU (superseded: captain chose Chromium by feel)
- [x] the Linux launcher uses Chromium when installed, keeping one-window and single-instance behavior; save-on-close narrowed (save ~250ms after the last edit plus keepalive flush) but not guaranteed: notes over ~60 KiB can lose edits made in the last fraction of a second before closing
- [x] stable origin: the desktop app prefers port 3138 so saved preferences and the microphone permission survive restarts

Captain accepted (2026-09-30): "Chromium was a better launcher"; close-time limit for large notes stays documented.

## F-015 Speed meter and engine badge [done]
Captain: "I don't know whether it's a Chromium window or NPM window… put some sort of a speedometer."
- [x] a shortcut toggles a small meter showing frames per second and the slowest recent frame while drawing, dragging and zooming
- [x] the meter names the engine the window runs on (Chromium, WebKit, Firefox) and whether it's the desktop app or a browser window
- [x] the meter is off by default, costs nothing when off, and its on/off choice is remembered
- [x] `npm start` uses the project's own Python environment when it exists

## F-016 Remove the writing guide [done]
Captain: "no need for a translucent line underneath the text… remove and save some cycles of drawing time."
- [x] no ruled guide lines appear while editing text, on desktop or phone
- [x] the code that placed and redrew them is gone, not just hidden

## F-017 Red skin default and quick select/hand switching [done]
Captain: "not the blue one… I like the red one, which looked like Claude"; "I have to click between the arrow tool and the hand tool… there has to be an easy shortcut."
- [x] Paper (the red skin) is the default for a first launch; a skin the user already picked is kept
- [x] hold Space to pan with the hand, release to go back to the previous tool; V selects the arrow, H the hand; middle-mouse drag pans from any tool
- [x] Space no longer pages the canvas (arrows and PageUp/PageDown still do), and none of this fires while typing

## F-018 Softer blue [done]
Captain: "blue should be slightly dimmer, red is good."
- [x] the Crayon (blue) skin's accent is a notch softer, still meeting 4.5:1 for text on and beside it; red and Night unchanged

## F-019 Mac and Linux packages from GitHub [done]
Captain: "how do we package for mac / linux… no windows. just mac and linux is good enough."
- [x] a GitHub Actions workflow builds a macOS app (zipped Personal Note.app, unsigned) and a Linux bundle on each version tag and attaches them to a GitHub Release
- [x] the Linux bundle runs without the repo, npm or a virtualenv: unpack, run its install script, launch from the menu (uses the system Chromium)
- [x] the Mac app opens with right-click › Open the first time and keeps notes in Application Support
- [x] README explains installing from a Release on both systems; Windows is out of scope
Open: first tag proves the GitHub build and the Mac app (captain checks on a Mac).

## F-020 Voice on Mac and Linux, one-click [doing]
Captain (after using the Mac app): "the voice did not work… we can have a plugin for voice where we download the same NVIDIA model… like the VS Code speech extension."
Today: local voice = NVIDIA NeMo-Speech.cpp + nemotron-3.5-asr-streaming-0.6b, with Windows-only setup scripts; Mac/Linux fall back to browser dictation, which the app windows don't provide.
- [ ] NeMo-Speech.cpp builds for Linux x86_64 and macOS arm64 (Metal where supported) in GitHub Actions, published as downloadable voice engine files on the release
- [ ] Settings › Voice shows status and a "Download voice" button: fetches the engine for this OS and the Nemotron model (size shown, resumable, checksum-verified) into the app-data folder; no terminal needed
- [ ] when voice is installed, the app starts the engine with the window and stops it on close (loopback only, its own port); hold-to-talk streams text into the note on Mac and Linux
- [ ] the mic works inside the Mac app window (permission prompt appears) and the Linux Chromium window
- [ ] when voice isn't ready, the mic says why and what to do; audio is never stored (invariant 4)
Code reviewed and merged. Still to prove on real runs: CI builds both engines; hold-to-talk with the real engine on Linux and Mac; Mac mic prompt.

## F-021 Organic mind-map branches [done]
Captain (screenshot of a child above the centre): the branch "twists itself… it has to be flatter… thicker at the beginning and tapers down… when you rotate it spatially entangles itself" — wants Tony Buzan / iMindMap / Ayoa style.
- [x] a branch leaves its parent heading toward the child and meets the child on the side facing the parent: one smooth bend, never an S, for children in any direction (above, below, behind)
- [x] the ribbon tapers steadily from parent to child, measured across the curve, with no pinch or crossing edges
- [x] dragging a node around its parent (including straight above or below) sweeps the branch smoothly with no flips; saved map JSON format unchanged
More mind-map features to come from the captain's detailed list (Ayoa / iMindMap).

## F-022 Native Mac window [done]
Captain: web apps "don't use… the bar with the three lights… How can we make it feel like a native app."
- [x] on macOS the app's content extends under a transparent title bar; the top bar (breadcrumb, title, search, settings) sits beside the traffic lights, and that strip drags the window
- [x] the Mac menu bar has File (New note, Quick note, Export…), Edit (Undo, Redo, Cut, Copy, Paste, Select All), View (Zoom in/out/fit, Skins, Speed meter), Window and Help, with standard ⌘ shortcuts that work in text and on the canvas
- [x] Linux and browser windows are unchanged
Open: captain checks on a Mac (title bar look, drag, menus survive app switching, shortcuts).

## F-023 Media library [todo]
Captain: "if they drag files onto this… what happens to the media… does it compress and store, or does it store as an object separately?"
- [ ] dropped images and files are stored once as separate files in the app's data folder; notes hold small references
- [ ] other files (PDF etc.) appear as cards that open on double-click
- [ ] existing notes with embedded images migrate safely; backup/export include media; agent CLI read/append unaffected

## F-024 LeaferJS parity and performance scout [done]
Decision: docs/adr/0001-canvas-engine-leaferjs.md. Captain: "from a feel-wise, Leaf.js is my answer… feature parity… it should be a great editor… see what optimizations we have with respect to GPU… how it performs with our core budget."
- [x] feature parity matrix: every canvas feature Personal Note has today (and a great editor needs) vs Fabric vs Leafer (built in / plugin / app code / missing), with effort
- [x] measured optimizations on our scene (shadow/text caching, worker or OffscreenCanvas rendering, culling, layer splits, Leafer render config) with before/after numbers
- [x] core startup budget check with Leafer in place of Fabric
- [x] a migration plan as vertical-slice tickets: document model, Leafer adapter, note migration, feature-by-feature cutover, removal of Fabric
Report: docs/research/f024-leafer.md (migration slices P-01…P-12 there; awaiting captain approval to schedule).

## LeaferJS migration (approved 2026-10-01; detail: docs/research/f024-leafer.md §4)
Captain: "it should be snappier, faster, savable through a SQLite database, the media should be saved differently so that you can point to it… the editing should feel fast… we'll add plugins as and when." Fabric stays the default until F-035.

## F-025 Engine-independent document model (P-01) [done]
- [x] plain JS document types (text, sticky, shape, ink, image, connector, group), page state, schemaVersion; images reference media by id (prepares F-023)
- [x] lossless fromFabric/toFabric round-trip on fixtures covering every object type and real-shaped notes; Python mirror with the same fixtures
Decided: reading order for plain text is by box top edge; F-026 moves note_text/CLI read to the same rule.
## F-026 Notes stored as JSON Canvas (Obsidian) + Markdown (P-02) [done]
Decision: docs/adr/0002-note-format-json-canvas.md. Captain: "let's use that Obsidian format… get the feature parity… and we'll do the same thing for the plugins."
- [x] the document model serializes to and from JSON Canvas 1.0 with `pn` extensions, render-equivalent round trip; the files pass the JSON Canvas spec check (opening in Obsidian itself not yet tried) (text, images, arrows, ink/shape SVGs visible)
- [x] SQLite stores the JSON Canvas per note; search, the agent CLI read/append and Markdown export use the Markdown projection (reading order by top edge)
- [x] existing notes convert once; the old database file is kept aside untouched
- [x] backup/import and an Obsidian vault export/import round-trip
Merged into `leafer` at ea09499. Mind maps still stored as before (follow-up per ADR 0002); vault import is CLI/API only.
## F-027 Leafer renders notes (P-03) [done]
Direction change: no dual engine; Leafer work accumulates on the `leafer` integration branch until parity, then replaces Fabric on main (F-035/F-036). Main stays usable meanwhile.
Merged into `leafer` at d6683b1.
- [ ] follow-up: parity script matches both directions and catches a missing thin stroke at dpr 1 (limit ~15-20% or a corrected comment)
- [ ] follow-up: a headless test that uniform strokes double in width at view scale 2; check Leafer strokeScaleFixed on non-uniform x/y scale
## F-028 Select, move, transform, delete, z-order, lock, nudge on Leafer (P-04) [done]
Merged into `leafer` at e43fffc. Select/move/resize/turn/nudge/delete/z-order/lock, routed through undo. Save after an edit no longer freezes (per-object encode cache, Blob body): max frame 16.8 ms on 645 objects. Connectors following a moved object is F-032.
## F-029 Text and stickies editing on Leafer, IME fix (P-05) [doing]
## F-030 Undo/redo on the document model (P-06) [done]
Merged into `leafer` at ea54a5f. Patch-based history (~1.5 KB/step on 600 objects, undo ~9 ms in app); undo never reverts or corrupts an agent's write (three-way per field, steps never span a merge).
## F-031 Pen, highlighter, eraser on Leafer (P-07) [doing]
## F-032 Pages, connectors, drag lift and ghost on Leafer (P-08) [todo]
## F-033 Images (media library, F-023), export, print on Leafer (P-09) [todo]
## F-034 Performance pass and agent sync on Leafer (P-10) [todo]
- [ ] undo/redo redraws only changed objects instead of reloading the scene (now ~21 ms median on 616 objects vs 9 ms before F-028)
- [ ] Leafer first draw vs redraw differs by 12 px at a sticky edge (Leafer-internal); recheck after upgrades
- [ ] an agent change arriving while you edit in Leafer mode merges in without discarding unsaved local edits (today the remote redraw replaces them; fine only while Leafer was read-only)
Includes a speed test in the Mac app before shipping.
## F-035 Phones and pencil, Leafer becomes default (P-11) [todo]
## F-036 Remove Fabric (P-12) [todo]
## F-037 Blog post: how we made it fast [todo]
Captain: the 500/1,000/100,000-object engine test "shows the care… make it a story… publish it in the blog… the test is not a throwaway."
- [ ] the engine race (docs/story/engine-race/) stays runnable and is kept up to date as Leafer lands
- [ ] before/after numbers from the real app on Fabric vs Leafer (same notes, same machine, Mac and Linux)
- [ ] a published post telling the story: Fabric limits, the race, why Leafer, the open note format, with the interactive race embedded
## F-038 WebGPU rendering: research for later [todo]
Captain: "explore the idea of using WebGPU… if Leafer JS supports something, to consider in the future." Not before Leafer parity (F-036).
- [ ] what Leafer offers or plans for WebGPU/WebGL, and what else could use it (e.g. bitmap tiles, ink, minimap)
- [ ] WebGPU availability in our windows: Chromium app window (Linux) and WKWebView (Mac)
- [ ] the engine race gains a WebGPU lane if a candidate exists, with numbers vs today's Leafer
