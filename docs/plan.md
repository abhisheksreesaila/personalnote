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
- [ ] verify-leafer-text's base-after-switch check can't reach its guard (switch waits for the save); drive the unload-save path instead
- [ ] today's app (Fabric): an agent's rewrite or deletion arriving while you have unsaved edits is overwritten by the local version (mergeRemoteAppends keeps local, appends only new). Use the three-way merge F-029 adds for Leafer.
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
## F-029 Text and stickies editing on Leafer, IME fix (P-05) [done]
Merged into `leafer` at 39992fc. Textarea overlay (native IME), words saved as you type (one undo step per session; a mid-session agent merge splits it in two, accepted). Three-way agent merge (src/core/document/merge.js): agent rewrites/deletions/appends and the user's typing all survive. Prettify and voice-into-text disabled on Leafer until F-035.
## F-030 Undo/redo on the document model (P-06) [done]
Merged into `leafer` at ea54a5f. Patch-based history (~1.5 KB/step on 600 objects, undo ~9 ms in app); undo never reverts or corrupts an agent's write (three-way per field, steps never span a merge).
## F-031 Pen, highlighter, eraser on Leafer (P-07) [done]
Merged into `leafer` at 79aa1c2. Live stroke on its own layer; one stroke or erase pass = one undo step; eraser takes ink only and leaves locked strokes (differs from Fabric, captain may overrule); an agent merge cancels an erase pass in progress. Up/left page growth and fold-back are F-032.
## F-032 Pages, connectors, drag lift and ghost on Leafer (P-08) [done]
Merged into `leafer` at dbc8cbc. Instant growth on all four sides and fold-back, in the edit's undo step; page shift is a frame op so undo after an agent merge stays on the grid; connectors follow live and saved; lift and ghost. View never snaps; it jumps (instantly) only when no page is in view.
## F-033 Images (media library, F-023), export, print on Leafer (P-09) [done]
Merged into `leafer` at 14ea4a1. Pictures stored as content-addressed media (POST /api/media, streamed 20 MB cap, no SVG); export/print rendered offscreen by Leafer and pixel-matched to Fabric; print keeps app chrome out (fixed a blank extra PDF page). Zoom control and minimap step aside from selection handles. F-023 non-image file cards still to build.
## F-034 Performance pass and agent sync on Leafer (P-10) [review]
- [ ] preview 5 Mac run (docs/story/mac-runs/2026-10-04-preview5.md): fix zoom hitches (no on-the-spot page over one frame; realistic-note zoom p95 97 vs classic 31.5), real splitting of idle page builds (155 ms bands → spikes in undo/typing/pen), pan right after an edit on big notes (45 vs classic 26). Then v0.4.0 (merge leafer → main) with the captain's go.
Merged into `leafer` at c5f1305. Undo redraws only changes; zoomed-out page bitmaps, DPR cap 2, baked shadows; save/sync hardening; speed test runs as a separate instance (View > Speed test…, `npm run speedtest`). Numbers in docs/story/engine-race/leafer-optimizations.md. First Mac run (preview 2): pen/typing/drag-one smooth; pan/zoom p95 90–113 ms, drag 40 at 135 ms. Fixes in v0.4.0-preview.3: gesture transform (default), pages grow while typing, render-mode comparison in the speed test. Preview 3 Mac run: page bitmaps at every zoom gave a perfect 17 ms; gesture transform was worse than classic on WebKit. Preview 4: hybrid default (bitmaps while navigating, vectors while editing, 1x group drag), toolbar dimming fixed. Preview 5: mixed start (ready pages show at once), fixes for the idle-build collision and eviction that could switch bitmaps off. Before v0.4.0: hybrid checks must be proven by mutation; waiting on the captain's Mac run of preview 5.
- [ ] leaving a note doesn't re-send its unchanged content (an extra write per switch; can show a false "Could not save" after an agent edits a note you only viewed)
- [ ] history combine(): a later op's page shift must also shift earlier ops' `after` for objects it doesn't name (two prepends in one step; unit test from F-032 review)
- [ ] merge arriving before our PUT response updates leaferServerShift uses the old server frame (narrow race)
- [ ] pen at dpr 2: pointer-to-frame p95 ~40 ms with 33-83 ms frames after pointer-down/mid-stroke in headless; confirm on the Mac and fix if real
- [x] an agent change arriving mid-erase or mid-stroke can't commit against a doc it wasn't planned on (F-031)
- [ ] undo/redo redraws only changed objects instead of reloading the scene (now ~21 ms median on 616 objects vs 9 ms before F-028)
- [ ] Leafer first draw vs redraw differs by 12 px at a sticky edge (Leafer-internal); recheck after upgrades
- [x] an agent change arriving while you edit in Leafer mode merges in without discarding unsaved local edits (F-029 three-way merge)
- [ ] research optimizations from F-024: baked sticky shadows, per-page bitmaps below 60% zoom with vectors detached, cull off-screen pages, DPR capped at 2; before/after numbers kept for the blog (F-037)
Includes a speed test in the Mac app before shipping.
## F-035 Phones and pencil, Leafer becomes default (P-11) [doing]
- [x] finger and phone select/move/resize, pinch/pan, keyboard-aware text editor, Pencil draws while fingers pan (finger drawing back after 10 s or on tapping Draw)
- [x] voice dictation into text and Prettify work in Leafer mode (Prettify skips locked texts)
Merged into `leafer` at f40cc31, except the default flip.
- [ ] the default flip to Leafer, after the captain's Mac speed test (F-034)
- [ ] check the Pencil palm behaviour and on-screen keyboard on a real iPad/iPhone
## F-036 Remove Fabric (P-12) [done]
Released as v0.4.0-preview.2 (pre-release). Merged into `leafer` at 686aefe: Fabric gone (JS gzip 364.7 → 189.9 KiB, under budget), legacy notes still read and convert. Restored on Leafer after a full feature inventory against main: shape tool, Clear all, dictation placement, agent flag, listening outline, Text tool on open. Undo no longer switches to Text (deliberate). Leafer → main waits on the captain's Mac speed test.
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
## Milestone 1: two-layer pages (approved 2026-10-11; brief docs/briefs/two-layer-pages.md, ADR 0003, feel: prototype branch `prototype/two-layers`)
Order: F-040 → F-041 → F-042 → F-043 → F-044 → F-045 → F-046. Frontend tickets share `src/page/`, so they go one after another.
## F-040 Page note: write Markdown, saved [done]
Brief: docs/briefs/two-layer-pages.md · Needs: none
- [x] New note creates a page note by default (canvas and mind map stay in the menu); existing notes open as before
- [x] a page note opens in CodeMirror 6 (lazy-loaded, like the mind map), typing saves, reload shows the same text, revision conflicts behave like other notes
- [x] stored as note type `page`, content `{version, markdown, ink}`, content_format `page`; search finds its words; backup/import round-trips it; Markdown export writes its Markdown
- [x] CLI: `create --type page --text`, `read` prints the Markdown, `append` adds a paragraph at the end
- [x] the page editor is its own lazy chunk with its own size budget; the main app stays under 240 KiB gzip
Reviewed: PASS (05ddb80, fixes 4251f00).
## F-041 The paper look [done]
Brief: Look and feel · Needs: F-040
- [x] page notes look like the prototype: ivory paper (860 px sheet) on a warm desk, Literata 18 px / 1.65, Bricolage headings, Figtree controls, faint "Page N" marks every 1080 px
- [x] heading marks (#) and list marks are quiet; the page grows as you write
- [x] the app chrome uses the same warm palette by default (other skins still selectable)
Reviewed: PASS (fce7fae).
## F-042 Marks on words [done]
Brief: What it does 2 · Needs: F-040
- [x] Write/Draw switch (Esc returns to writing); pen, red, highlighter, eraser; Pencil always draws, fingers scroll; drag on empty margins draws in Write mode
- [x] a mark on words anchors to its word and follows it through typing, split/merge, wrapping and zoom; a margin mark follows its line
- [x] deleting the words deletes the mark; one undo history for text and ink
- [x] marks are saved and come back after reload
Reviewed: PASS after fixes (1bb4e9f, 7e66333).
## F-043 Drawings on empty space [done]
Built together with F-044 in one commit: the drawing's Link/Fold buttons and its block widget are the same code.
Brief: What it does 2 · Needs: F-042
- [x] drawing on empty space creates a standalone drawing in the flow (linked to no word); more strokes join it; it grows as you draw past its edge; the page grows past its bottom
- [x] shapes (rectangle, ellipse) and text objects (word art: placed text, sizes S–XL) inside drawings
- [x] saved, undoable, erasable
Reviewed: PASS after fixes (7e66333, bc82e41).
## F-044 Link and fold [done]
Brief: What it does 3 · Needs: F-043
- [x] "Link to text" then a click on a word links a drawing; it moves under that paragraph; the word turns into a teal link
- [x] clicking the word folds/unfolds the drawing with a smooth ~0.6 s slide; text and marks below glide; Fold all / Unfold all
- [x] a linked drawing is deleted with its word (undo restores both); fold state is saved with the note
Reviewed: PASS after fixes (7e66333, bc82e41).
## F-045 Agents and pages [done]
Fixes after review: a179cab (multi-hunk merge, wait for saves, UTF-16 positions), 9756c37 (long notes).
Brief: What it does, also in v1 · Needs: F-040 (backend), F-044 (UI)
- [x] CLI `write` replaces a page's Markdown with a revision check; the server re-finds each mark and linked drawing by its quoted words; marks it can't place become loose ink, never deleted
- [x] the open page reloads an agent's change when you have no unsaved edits; loose ink shows in a tray on the page
- [x] an agent writing to a page you are typing in never traps or loses your typing (today a page conflicts like a mind map: every save 409s and switching notes is refused; F-040 review)
Reviewed: PASS (9756c37).
## F-046 Preview build for the captain [done]
Needs: F-040..F-045
- [x] runs as a local web server (`npm run dev`) for a first play (skipped for the captain's first try at their request: straight to the Mac build)
- [x] Mac and Linux packages published as a GitHub pre-release: v0.5.0-preview.1 https://github.com/abhisheksreesaila/personalnote/releases/tag/v0.5.0-preview.1
## F-047 Page follow-ups [todo]
Found while building Milestone 1; none blocks using pages.
- [ ] voice dictation into a page (the mic is hidden on pages today; it types into canvas notes)
- [ ] after an agent write conflicts with a save, "Could not save" can flash until the merged save lands (F-045 review)
- [ ] zoom on pages; check pen, IME and the fold slide in the Mac app (WebKit) and on an iPad
- [ ] pages keep their ivory look under the Night skin: decide whether pages follow skins
- [ ] merge edge cases: you and an agent inserting different text at the same spot keep both; deleting a line an agent just edited drops the agent's edit (typing wins). Show a notice when an agent edit is dropped
- [ ] agents can't draw yet (create drawings or marks through the CLI): later, with Milestone 2

## Milestone 1, second pass: the two layers inside the canvas (captain, 2026-10-12, after preview 1; ADR 0004)
Captain: "all the existing functionality should remain.. only add should be 2 layer stuff we discussed, so that its text native but can be drawn." Choice: inside the canvas (one note type).
Order: F-048 → F-049 → F-050 → F-051 → F-052 → F-053. All touch the canvas scene, so one after another.
## F-048 Markdown text on the canvas [done]
Reviewed: PASS after fixes (4239908).
Review 1 (a7ec7e1): NEEDS WORK, fixed: last letter of a long broken word, backslashes in code, plain-text check now runs, resize rewraps live.
Brief: docs/briefs/two-layer-pages.md · ADR 0004 · Needs: none
- [x] New note opens a canvas again (a411316)
- [x] a new text is Markdown (`format: 'markdown'`) and is drawn formatted: headings, bold, italic, inline code, strikethrough, links, bullet/numbered/task lists, quotes, code blocks, rules; older texts look exactly as before
- [x] a new text made with the Text tool wraps at the page's right margin, so writing flows down and the pages grow as before
- [x] save, reload, undo, backup/import, Markdown export, search and print keep it (print draws the same nodes)
- [x] selection, move, resize (rewraps), delete, style controls and every verify script still pass (scripts/verify-markdown-text.mjs; text and pages checks updated for Markdown)
## F-049 Writing in place [done]
Reviewed: PASS (233550b).
Needs: F-048
- [x] editing a Markdown text keeps it formatted while you type (heading sizes, emphasis); the Markdown marks of the line being typed show, others stay hidden; the ink marks on the words stay on screen and follow them
- [x] input methods, spellcheck, paste, undo of a typing session, page growth while typing, voice dictation and Prettify work as with plain text (verify-leafer-text/voice/pages/phone pass with the new editor)
## F-050 Ink on words [done]
Reviewed: PASS after fixes (233550b).
Review (4239908): NEEDS WORK, fixed: a stroke is a mark only when its points enclose or run over words and stay near them (a big arrow or diagonal stays ink).
Needs: F-049
- [x] a pen or highlighter stroke over a Markdown text's words becomes a mark of that text; it follows its words through typing, rewrap, resize and move
- [x] deleting the words deletes the mark; the eraser removes marks; one undo step each; saved and reloaded
- [x] strokes elsewhere stay ordinary ink, exactly as today
## F-051 Link and fold [done]
Reviewed: PASS after fixes (233550b, selection kept when no link words change).
Review (4239908): NEEDS WORK, fixed: deleting the text unlinks and shows what was folded into it; teal words redrawn after undo, redo, merges and deletes; a fold in flight can't be doubled and lands on the current object; reduced motion respected; Select all skips folded objects; link words look the same in the editor.
Needs: F-050
- [x] any object (ink, shape, sticky, image, text, group) can be linked to a word of a Markdown text (selection bar: Link to words, then click the word); the word turns teal
- [x] clicking the word folds the object away into the word and opens it again with a smooth ~0.6 s slide; Fold all / Open all in the top bar
- [x] fold state is saved; deleting the word unlinks and shows the object (undo restores both)
## F-052 Agents and Markdown text [done]
Reviewed: PASS after fixes (233550b).
Review (4239908): NEEDS WORK, fixed: dot marks kept; one-letter words found by their context; lost marks become ink where last drawn with their real size; the text's height and pages follow the new words.
Needs: F-050
- [x] the CLI reads and writes a canvas note's Markdown texts (`notes write`, `--object`; `append` adds Markdown text); marks and links re-find their words after an agent edit, never lost (a mark whose words are gone becomes ink beside the text)
- [x] the open note merges an agent's change as it does today (object-level canvas merge, unchanged)
## F-053 Preview build 2 [done]
Needs: F-048..F-051 (F-052 if ready)
- [x] the Page type leaves the New note menu (old page notes still open)
- [x] Mac and Linux packages as a GitHub pre-release: v0.5.0-preview.2 https://github.com/abhisheksreesaila/personalnote/releases/tag/v0.5.0-preview.2
## F-055 Preview 2 fixes: selecting text, underlines that stay [done]
Reviewed: PASS (follow-ups: middle-button pan and touch on the words being typed as before; the editor layer never scrolls; underline vs handwriting boundary tests).
Shipped in v0.5.0-preview.3 https://github.com/abhisheksreesaila/personalnote/releases/tag/v0.5.0-preview.3
Known: verify-leafer-hybrid's group-drag and typing-grid checks fail intermittently on the released code too (2 of 4 runs); needs its own look.
Captain (2026-10-12, after preview 2): with the Text tool the words could be typed but not selected with the mouse; an underline under the text stayed behind when the text moved.
Needs: F-049, F-050
- [x] with the Text tool, a mouse drag or double-click selects words in the text being typed (the editor sits above the pointer layer)
- [x] an underline drawn under the last (or only) line of a Markdown text is a mark of its words and moves with the text
## F-054 Focus write mode [done]
Superseded by F-059 Editor first (brief docs/briefs/editor-first-and-secure-notes.md, approved 2026-10-13): the editor feel becomes the default rather than a separate mode.
Captain (2026-10-12): "the editor (writing has to be zippy)., we need a focus write mode, where drawing is off, so people can write as fast you can."

## F-056 Secure unlock spike (Mac) [done]
Run on the captain's Mac 2026-10-13: "Touch ID: yes", "Keychain: key stored and read back OK", and a screenshot during the 10 seconds showed the window blank.
Reviewed: PASS after fixes (0bc2774). Shipped in v0.5.0-preview.4 https://github.com/abhisheksreesaila/personalnote/releases/tag/v0.5.0-preview.4
Brief: docs/briefs/editor-first-and-secure-notes.md · Needs: none
Riskiest assumption first: Touch ID, the keychain and screen-share exclusion from the pywebview app on macOS.
- [x] the Mac app can ask for Touch ID (falling back to the Mac password) and learn yes or no (captain's Mac, 2026-10-13: "Touch ID: yes")
- [x] a random key is stored in and read back from the login keychain, only after that Touch ID yes
- [x] the window can be kept out of screen sharing and screenshots, and let back in
- [x] a Help menu item (Test secure unlock…) runs all three on the captain's Mac and shows the result; off a Mac the platform module reports "passphrase" (the Linux app has no menu)
## F-057 Secure notes: locked words on disk [done]
Reviewed: PASS after fixes (4cb1dab). Keychain access control: app-enforced Touch ID kept; the stable self-signed signature (release workflow) stops the keychain asking again after updates.
Needs: F-056
Carry from the F-056 review: the spike's keychain item has no access control (Touch ID first is enforced by the app only), and an ad-hoc signed build asks for the keychain password again after each update; decide kSecAttrAccessControl (biometry) and signing here.
- [x] a whole note can be marked secure; its content is encrypted at rest (AES-GCM, key from the keychain on Mac, from a passphrase on Linux); its title stays readable (assumed)
- [x] search, Markdown export and the agent CLI never see its words; backups carry it still encrypted
- [x] a one-time recovery key is shown when the first secure note is made, and it opens the notes on another machine
## F-058 Secure notes: lock, unlock, never on a shared screen [done]
Reviewed: PASS after fixes (a56f0c8). Captain's Mac, v0.5.0-preview.5: Touch ID opens a secure note; a screenshot shows the window blank. Sleep lock not yet reported.
Design: docs/design/secure-notes.md (Option B, quiet cover; captain 2026-10-13)
Needs: F-057 · Design first (designer skill)
Carry from F-057: the app's api() must send the x-personal-note header when reading an unlocked secure note (otherwise it only sees the locked view); reload a note after unlock before saving it; show the recovery key once with a clear warning; after a recovery unlock on Linux, ask for a passphrase for this machine.
- [x] a secure note shows its own colour and a lock in the note list, and opens locked
- [x] one touch (Touch ID) unlocks it; while it is open the window is kept out of screen sharing
- [x] it locks again when you leave it, after 5 quiet minutes, or when the Mac sleeps
## F-059 Editor first [done]
Reviewed: PASS after fixes (once per tool pick, pen-then-shape, stickies stay put, glide gives way to the person, stale opens ignored). Captain signed off 2026-10-13: single-key tools, Space and arrow pan, Ctrl+A, Quick note and the speed meter need Esc first while the caret is in a note; the pen and highlighter open the page at their first drawing (underlines stay at 100%); the page edges stay.
Needs: none
- [x] a note with writing (or an empty one) opens at 100% with the caret at the end of its writing (an empty note: a new Markdown text at the top of the first page, made at the first word); the page map and zoom stay quiet while writing; a note of drawings and phones open as before
- [x] shape, sticky and connector zoom out to the whole page as they are picked; the pen and highlighter at their first drawing; Esc or opening writing returns to 100%
- [x] every tool stays in the dock; typing no slower (speed test headline row, same machine back to back: before p95 46 ms key to frame, after 19 ms; the detail tables are noisy both ways; the Mac measure is the one that counts)
## F-060 Text outline hugs the words [done]
Reviewed: PASS (after fixes: a turned text doesn't jump; arrows meet the words on every commit). Captain 2026-10-13: the small gap above the first line (line spacing) is fine.
Needs: none
- [x] a Markdown text's box and outline are as wide as its words (lines still wrap at its width; a resize sets that width; arrows, snapping and folds meet the words); while typing, lines sit exactly where the canvas draws them (they jumped by 4 px a line before)
- [x] no empty space above the first line beyond the line spacing (captain: fine)
- [x] the outline shows when the text is picked with the Select tool, never while writing in it
## F-061 Code colours (only if free) [todo]
Needs: none
- [ ] code inside ``` fences is coloured by its language (from the fence, or guessed), on the canvas and in the editor, loaded only when a code block appears
- [ ] dropped if it costs any typing speed or a noticeable bundle increase
## F-062 A text's underline stays with it after a move [blocked]
Blocked: not reproduced headlessly (drags, typing, every render mode, WebKitGTK); guard checks in verify-markdown-text (reviewed PASS) and a cleared live pen canvas are in. Tell me whether you dragged the text or typed so the word shifted, whether it jumped back by itself or on a click, and send a screen recording if it happens again.
Reported on the Mac (preview 4): underline a word, move the text; the underline moves with it, then a couple of seconds later jumps back to where it was.
- [ ] after moving a text, its marks stay on its words, also after a few seconds and after reopening the note
## F-063 The notebook dialog lets you back out [done]
Reported on the Mac (preview 4): a new notebook's dialog could not be cancelled. Reviewed: PASS (4f31486); checked in Chromium (WebKit does not start on the build machine).
- [x] Cancel, X and Esc close it with the name empty, and make no notebook
- [x] Enter with a name creates it (it used to cancel)
## F-064 A real Inbox [done]
Reviewed: PASS after fixes (dd7e581). Backups are format 3; an older build opening the database files Inbox notes into a notebook (ARCHITECTURE.md).
Brief: docs/briefs/para-sidebar.md · Design: docs/design/para-sidebar.md · Needs: design
- [x] new notes and quick notes land in Inbox (one built-in place, not a notebook you can rename or delete) until filed; existing notes stay where they are
- [x] Inbox's count is its unfiled notes and it empties as notes are filed; a note made with a notebook's + goes into that notebook
- [x] agents (CLI), backups and import know the Inbox (an imported note keeps its notebook, or lands in Inbox)
## F-065 File by drag [blocked]
Blocked: in v0.5.0-preview.5 on the Mac, drag an Inbox note onto a notebook and a notebook onto Archive, and tell me whether both landed.
Reviewed: PASS (dd7e581) in Chromium; waits on a real drag in the Mac app (WebKit) in v0.5.0-preview.5. A note dropped on the Inbox shelf unfiles it.
Brief: docs/briefs/para-sidebar.md · Design: docs/design/para-sidebar.md · Needs: F-064
- [x] drag a note from Inbox or any notebook onto a notebook to move it; the row lifts and the target highlights
- [x] drag a notebook onto Projects, Areas, Resources or Archive to change its section
- [x] the Archive lid opens as something drops in and closes after; all motion under 200 ms, plain CSS
- [ ] works with the mouse in the Mac app's web view (WebKit) as in the browser
## F-066 Sections fold smoothly [done]
Brief: docs/briefs/para-sidebar.md · Design: docs/design/para-sidebar.md · Needs: none
- [x] Inbox, Projects, Areas, Resources and Archive each fold and unfold with a chevron, smoothly; the folded state is remembered on this machine
- [x] a folded section springs open after about half a second of hovering while dragging
## F-067 Name a notebook in place [done]
The + opens the inline row; its colour dot (or Shift+click on +) opens the full dialog.
Brief: docs/briefs/para-sidebar.md · Design: docs/design/para-sidebar.md · Needs: none
- [x] a section's + adds a notebook row named in place (Enter keeps it, Esc drops it); the dialog stays for colour and editing
## F-068 A notebook folds its own notes [done]
Reviewed: PASS after fixes (d8f9447). A click folds or opens a notebook's notes; several can be open, remembered per machine; opening a note opens its notebook; a fold click doesn't change the selection.
Reported on the Mac (preview 5): an open notebook's notes can only be hidden by folding the whole section.
- [x] clicking an open notebook's row folds its notes (clicking again opens them), with the same smooth fold as sections
- [x] the note being written stays reachable (its notebook opens when the note is opened from search or the breadcrumb)
## F-069 Text wraps at the page edge while typing [done]
Reported on the Mac (preview 5): typing runs past the page's right edge and only wraps when typing stops.
- [x] while typing, a Markdown text wraps at the same width it will have when typing ends (never wider than the page)
- [x] a subtle mark shows the right edge the words wrap at while writing
- [x] a text started near the margin, classic text boxes and point texts also wrap at the margin while typed (an existing text keeps its place; centred legacy texts are left alone)
## F-070 Double-tap ⌘ toggles pen and text [done]
Brief: docs/briefs/focus-search-switch.md · Design: none needed (pill only) · Needs: none
Reviewed: PASS after fixes (wheel zoom cancels a tap, pill at top centre, caret spot kept through the space-bar hand). Mac ⌘ path not yet tried on a real Mac.
- [x] two clean taps of ⌘ alone (Ctrl on Linux/Windows) within ~300 ms toggle writing ↔ the last pen tool, even with the caret in text
- [x] ⌘ used in a shortcut (⌘C, ⌘Z, ⌘-click…) between or during the taps never toggles (key-timing unit test plus real-keyboard check)
- [x] switching back to text puts the caret where it was; a small pill flashes "Pen" or "Text"
- [x] dock and single-key shortcuts unchanged
## F-071 Middle-click toggles pen and text [done]
Brief: docs/briefs/focus-search-switch.md · Needs: F-070
Reviewed: PASS after fixes (paste guard bounded, middle-click handling only on the paper).
- [x] a middle-button click without moving toggles like double-tap ⌘; a middle-drag still pans
## F-072 Omnibar [done]
Brief: docs/briefs/focus-search-switch.md · Design: docs/design/omnibar-focus.md (to do) · Needs: design
Reviewed: PASS after fixes (no stray "New note" on Enter while words load, IME guard). Option C chosen. The focus mode action is added with F-073. CSS budget raised to 17.6 KiB for omnibar + focus mode.
- [x] search sits as a slim bar at the top centre; the top-right search box is gone, ⌘K still opens it
- [x] opened, a large centred panel finds notes by title and words, notebooks and actions (new note, quick note, make secure, focus mode, switch skin); arrows and Enter pick, Esc closes
- [x] secure notes show by title only
- [x] at phone width it is a search icon that fills the screen
## F-073 Focus mode [done]
Brief: docs/briefs/focus-search-switch.md · Design: docs/design/omnibar-focus.md (to do) · Needs: design
Reviewed: PASS after fixes (typing never stranded, caret kept in view, page notes covered with drawing off). Option C chosen. Mac native full screen not yet tried on a real Mac.
- [x] ⌘. or a top-bar button shows only the words in a centred column on paper colour: no sidebar, dock, page map, page edges or desk; drawing off
- [x] a faint word count on hover; Esc or ⌘. restores everything exactly as it was
- [x] the Mac app goes full screen with it and leaves full screen after
- [x] the omnibar offers a Focus mode action
- [x] typing speed (speed test row) unchanged
## F-074 One notes button [done]
Brief: docs/briefs/chrome-islands.md · Design: docs/design/chrome-islands.md · Needs: none
Reviewed: PASS after fixes (button above a locked note, focus exit repaints, Esc order, verify scripts restored). verify-leafer-hybrid stale-bitmap and touched-page checks are flaky on main too.
- [x] at any width the sidebar is closed by default and a round notes button at the top left opens it as a floating panel over the desk (the desk does not shift)
- [x] the button, Esc or a click on the desk closes it; open or closed is remembered on this machine (storage guarded)
- [x] opening a note keeps the panel open on a wide window and closes it on a narrow one
- [x] Quick note, Inbox, PARA shelves, drag to file and the skin dots work inside the panel exactly as before
## F-075 Title pill, Focus and search on top [done]
Brief: docs/briefs/chrome-islands.md · Design: docs/design/chrome-islands.md · Needs: F-074
Reviewed: PASS after fixes (agent chip moved top left and checked on the Mac host, search label "Search", ⋯ 40px on phones, focus returns to ⋯). The breadcrumb is gone; the agent chip is a dot below 960px.
- [x] the top bar becomes islands: a centred title pill (editable title + save state, errors shown there) and, top right, a Focus button beside the search pill
- [x] a ⋯ in the title pill holds print, PNG, backup, Markdown, Obsidian vault, Clear all, Fold all and Settings; nothing that was on the top bar is lost
- [x] ⌘K, ⌘. and ⌘P still work; focus mode still hides all chrome and restores it
## F-076 Side tool island [done]
Brief: docs/briefs/chrome-islands.md · Design: docs/design/chrome-islands.md · Needs: F-075
Reviewed: PASS (fixes: island fits short windows, dead dot rule removed). Quick swatches and the minimap are gone; page count is in the fit tooltip; zoom still fades while writing (F-059). verify-leafer-hybrid/-lod flaky on main too (F-077).
- [x] the bottom dock becomes a vertical island on the right: select, text, pen, shape, sticky, a colour dot, +, mic
- [x] + opens hand, highlighter, connect, image, eraser and prettify; the colour dot opens the colour and width options; every shortcut and hold-for-options still works
- [x] undo/redo sit in a bottom-left island, zoom (−, %, +, fit) in a bottom-right island; the minimap leaves the resting view
- [x] mind-map notes show their actions in the same island; every verify-* script and the speed test pass
## F-077 Make the flaky canvas checks honest [done]
Brief: none (test reliability) · Needs: none
Reviewed: PASS after one round. Real bugs fixed: New note dropped the words typed just before it (canvas and page; scripts/verify-new-note.mjs), mic stop read a cleared audio context, page bitmaps missed late-loading sticky shadows (now invalidated on load, padded by the shadow's 44 margin). Measured threshold change: verify-leafer-lod 'nothing far off' allows < 1e-5 (one engine-noise pixel in 560,000 seen with bitmaps off in both runs). The 120 ms band check fails only at machine load > ~25, on base too. Unexplained, rare: hybrid 'six moved together by the drag'. verify-speedtest takes 10–16 min, not a hang.
Found during F-074 to F-076 review: on a clean main, verify-leafer-hybrid fails 4 of 5 runs (bitmap blur, "only the touched page", sometimes "typing grows the grid") and verify-leafer-lod fails "vectors are back after zoom" 1 of 2; verify-leafer-voice fails "no page errors" (null sampleRate in microphone-pcm-capture.js:48) about 1 in 5; verify-omnibar "Enter on it creates a note with that title" fails now and then under load, on main too. verify-dynamic-island "it grows out of the circle" failed 1 of 3 runs at load 11 (first sampled frame already 224px wide). verify-omnibar "Enter creates a note" failed 5 of 10 on clean main (2026-10-16): createNote sets activeNoteId to null until selectNote finishes saving the outgoing note; the check reads it in that 0–7 ms window. Decide whether the app should keep the new id active from the start (likely a real UI race, not just the check).
- [x] find why each check flakes (timing vs a real rendering bug) and fix the cause, never the threshold
- [x] each script passes 5 runs in a row on main
## F-078 Download search by meaning [done]
Brief: docs/briefs/search-by-meaning.md · Needs: none
Reviewed: PASS (fixes: download stops at the pinned size, per-launch engine key via LLAMA_API_KEY + --no-slots, stop-with-app tests, unpack refusal tests, 44px setup buttons). Real engine checked on Linux; not yet run on a Mac.
- [x] Settings offers "Search by meaning: Download (≈315 MB)"; it fetches the pinned llama.cpp server build for this OS (macOS arm64, Linux x86_64) and the pinned EmbeddingGemma 2 Q8 GGUF, checks sizes and sha256, installs beside the database, and shows progress, success and failure in place
- [x] the engine starts on loopback on first use, embeds text, and stops with the app; a missing or broken install leaves search exactly as today
- [x] a real-app check installs from local fixture files (no network in tests) and embeds a sentence end to end
## F-079 Index notes by meaning [done]
Brief: docs/briefs/search-by-meaning.md · Needs: F-078
Reviewed: PASS after three rounds (token-safe cutting, per-note refusals, low-priority engine with 30 s idle, final shutdown, idle stop after 5 min). Quiet-machine typing p50 9.2–9.9 ms and p99 17.5–19.9 ms with indexing on or off.
- [x] with the engine installed, every non-secure note's title and searchable text is embedded in the background and stored in SQLite with the note's revision; a changed note is re-embedded, a deleted one loses its vector
- [x] secure notes are never embedded; vectors are not in backup or export and are rebuilt when missing
- [x] saving and typing never wait on indexing; the speed test is unchanged
## F-080 Search finds by meaning [done]
Brief: docs/briefs/search-by-meaning.md · Needs: F-079
Reviewed: PASS after two rounds (New note never lost, relative rule from real-engine fixtures: in-sample P 0.76 / R 0.83, held-out P 0.75 / R 0.94; CLI asks the running app). Live check on main (12 short notes): precise but cautious; the rule holds back queries the model itself ranks wrong. Knobs in meaning_rank.py.
- [x] the omnibar shows a "By meaning" group under the word matches with the closest notes not already listed; without the download it is unchanged
- [x] `personal-note search --meaning "…"` returns the same ranking for agents
- [x] on a seeded notebook, meaning queries with no shared words find the right note
## F-081 Mac app downloads trust the web's certificates [done]
Brief: none (bug: the captain could not download voice on the Mac, preview 8) · Needs: none
Reviewed: PASS (real fetches of the voice model, llama.cpp release and EmbeddingGemma fail without it and pass with it; bad hosts and self-signed still rejected). Last check waits on the captain.
Cause: the Mac app bundles python.org's OpenSSL, which looks for certificates in /Library/Frameworks/Python.framework/…, absent on the captain's Mac, so every HTTPS download (voice and search by meaning) failed its certificate check and showed "Could not reach the download server".
- [x] voice and search downloads verify against certifi's bundle on top of the system's (download_tls.py); certifi is pinned and bundled in both builds
- [x] a test reproduces a machine with no system certificates; a real GitHub fetch fails without the fix and succeeds with it
- [ ] the captain downloads voice on the Mac from the next preview
## F-082 Eraser on the tool island [done]
Brief: docs/briefs/chrome-islands.md (captain's feedback 2026-10-16: the eraser is used as often as the pen) · Needs: none
Reviewed: PASS after one round (the I-key check's file-chooser race fixed at the cause, 146/146 x6).
- [x] the eraser sits on the island right after the pen (select, text, pen, eraser, shape, sticky); it leaves the + flyout; E still selects it
- [x] the island still fits a short window; every verify-* script passes
## F-083 The notes panel sits beside the note [done]
Brief: docs/briefs/chrome-islands.md (captain's feedback 2026-10-16: the panel covering the page looks lopsided) · Needs: none
Reviewed: PASS after one round (Esc does the note's job first after a press on it; no view jump after a pan with the panel open). Wide = the app's 800px breakpoint; a click on the note keeps the panel open.
- [x] on a wide window, opening the notes panel moves the note area right so the panel and note sit side by side; the title pill and top islands centre on the note area; closing moves it back
- [x] the note keeps its place on screen relative to its area (no jump of the content under the pointer beyond the shift); typing and drawing work with the panel open
- [x] on a narrow window (< 760px) the panel still slides over with its scrim
## F-084 The dynamic island [done]
Brief: docs/briefs/chrome-islands.md · Design: docs/design/dynamic-island.md (Option A) · Needs: F-083
Reviewed: PASS after one round (card above the selection bar, island tests in test:ui, no stuck Saving, 44px Stop/Try again, bars by transform, Esc focus). No work at rest or per keystroke (call counters); speedtest hangs on main too. Show/Undo → F-096. Phone: 'Link to words' wraps in the selection bar (pre-existing).
- [x] the title pill becomes the island: title only at rest; click opens the card (title, saved state, Focus first, then every ⋯ action); Esc/click away closes
- [x] it grows for the moments in the design table (slow save, save error, recording, agent edit replacing the agent chip, downloads, focus) and shrinks back; routine saves never change its size
- [x] the Focus pill is gone; search is a top-right circle that grows into the search field in place and shrinks back; ⌘K, ⌘., ⌘P unchanged
- [x] no timers or frames at rest; speed test unchanged; bundle budget held; Crayon, Paper, Night and a narrow window checked
## F-085 Focus mode can always be written in [done]
Brief: none (bug: on the Mac the captain entered focus and could not edit; it was read-only) · Needs: none
Reviewed: PASS after one round (empty and drawings-only notes covered). The Mac's real full-screen switch is the captain's check on the next preview.
Cause (confirmed): in focus mode on a canvas note every press outside `.leafer-text-editor` is turned away (main.js, "Only the words take the pointer"); if the text edit closes (e.g. the window blurs during the Mac full-screen switch), nothing can reopen it.
- [x] reproduce: enter focus, make the text edit close (window blur / full-screen resize), then a click on the words or typing must write again
- [x] in focus a press on the words (or anywhere on the page) reopens the focus text with the caret there; returning to the window resumes writing; page notes too
- [x] verify-focus covers it with a real mouse; nothing else about focus changes
## F-086 Jam brain spike: Claude Code and OpenAI-compatible, timed [done]
Brief: docs/briefs/jam-sessions.md · Needs: none
Reviewed: PASS after one round (no connector tools via --strict-mcp-config, bad types retried, https-only key without redirects, Mac PATH). Real Claude Code turns: opus mean 8.2 s, sonnet (default) ~9 s, haiku ~7 s. Azure not yet run (captain). Keychain → F-093; invariant 8 + ADR → F-092.
- [x] `jam_brain.py`: one call turns (map JSON + new transcript) into validated map edits (add branch, emoji, 👍/👎 with reason, ghost branches), never removes/renames; two adapters: Claude Code (`claude -p`, found on a bare Mac PATH) and OpenAI-compatible (base URL + model + key, incl. Azure endpoint + deployment + api-version); the key comes from the environment or keychain, never the database
- [x] `scripts/jam_spike.py` feeds three real-style transcripts through a brain and prints the edits and seconds per turn; run against Claude Code here; Azure left for the captain (env vars named)
- [x] unit tests with fake brains: schema validation rejects removals/renames/unknown ids; bad output is a visible error, the map untouched
## F-087 X bookmarks: connect and fetch [done]
Brief: docs/briefs/x-bookmarks.md · Needs: none
Reviewed: PASS after one round (idle/forged callbacks, known-id set, 1→10→100 pages, secret_store.py shared with AI settings). Not yet run against real X or a real Mac keychain: the captain's x-setup.sh run is the proof. F-088 owes the invariant 8 line and must never run two syncs at once (X rotates the refresh token).
- [x] `x_bookmarks.py`: OAuth 2.0 PKCE sign-in returning to loopback, refresh token kept in the system keychain (file fallback 0600 on Linux), fetch bookmarks with pagination and the 800 cap, newest first, never twice (since-id), pay-per-use friendly (one page per hourly run unless new)
- [x] `scripts/x-setup.sh` (wizard): exactly what the captain does on developer.x.com (app, callback URL, scopes tweet.read users.read bookmark.read offline.access, credits) and a live check that lists 5 bookmarks
- [x] tests against a fake X server: sign-in, refresh, pagination, cap, no duplicates, errors shown plainly
## F-088 X bookmarks notebook in the app [done]
Brief: docs/briefs/x-bookmarks.md · Needs: F-087, F-089
Reviewed: PASS after one round (client id never reaches the page, post text escaped, restore adoption reads only the generated link line, batches de-duplicated). Bookmarks are page notes in the X notebook; drag-onto-note and Done moved to F-095. Real X sign-in awaits the captain's x-setup.sh run.
- [x] Settings "Connect X"; sync on start and hourly while open; new bookmarks become cards in an "X bookmarks" notebook (X icon); drag onto a note lands a link card; mark done archives
## F-089 Notebook icons [done]
Brief: docs/briefs/notebook-icons.md · Needs: none
Reviewed: PASS after one round (server emoji rule matches the browser, a leading emoji isn't shown twice, icon/colour changes don't reorder, CLI --icon validated). Phone bottom sheet left for the phone layout. CSS now 17.45/17.60 KiB.
- [x] a notebook gets an icon guessed from its name (word list), a leading emoji wins, otherwise its first letter on its colour; shown in the notes panel
- [x] click the icon: ~40 icons, any emoji, 8 colours; saved with the notebook (revision-checked), in backup and restored on import; older backups still import
## F-090 Plugins: the host and Mind maps as the first plugin [done]
Brief: docs/briefs/plugins.md · Needs: F-084
Reviewed: PASS after one round (read-only maps never save, shared port guard, backup import while off tested, 48px row). Riskiest assumption held: ~84 lines in main.js, no rewrite. JS budget headroom ~2.8 KiB (237.22/240): F-091 must make room.
- [x] Settings → Plugins lists Mind maps with what it needs and a switch; the choice is remembered (Voice and Search by meaning rows arrive with their switches in F-091)
- [x] Mind maps off: no new-mind-map entry, no mind-map code loaded, existing maps open read-only with "turn on Mind maps to edit"; on again without restart
- [x] a small host contract (note types, settings rows; buttons and omnibar actions arrive with their first plugin that needs them) in docs/MODULE-CONTRACTS.md; ADR for built-in plugins
## F-091 Voice and Search by meaning become plugins [done]
Brief: docs/briefs/plugins.md · Needs: F-090
Reviewed: PASS after one round (switch-off off the event loop, indexer restart after a timed-out stop, voice engine can't start after a switch-off, hand-edited plugins.json honoured). Budget check unchanged (a proposed plugin-chunk category was rejected); JS 239.26/240.
- [x] each off: no mic / no meaning group, nothing started or downloaded, data kept; on: as today; both listed in Settings → Plugins with what they need
## F-092 Jam sessions in a mind map [done]
Brief: docs/briefs/jam-sessions.md · Design: docs/design/jam-sessions.md, option A (captain 2026-10-16: "on the map is more intuitive, I can see where I'm seeing and just suggest, as opposed to looking up all the time") · Budget: JS raised to 260 KiB by the captain · Needs: F-086, F-090
Reviewed: PASS first round; should-fixes done (server also needs Voice, pills act on release not on a pan, palette colours, no double-sent words, note switch mid-turn proven in the app). Jam plugin is off by default (it sends the map and words to a model). Real claude -p turn 4.3 s. Azure, real Nemotron hearing "jam" and the Mac await the captain.
- [x] New jam; hold mic, live line, Jam button → brain edits applied as one undo step; ghosts accepted by click or "yes"; Settings → Jam picks the brain
- [x] branch text and emoji rendered as plain text (never HTML); AGENTS.md invariant 8 updated and an ADR for the opt-in generative worker (Claude Code or OpenAI-compatible)
## F-093 Settings → AI: pick the model once for every AI feature [done]
Brief: docs/briefs/jam-sessions.md ("the brain is your choice"); captain 2026-10-16: "give me … the config menu … so I can put my base URL, API key and deployment name, save it … settings for future AI stuff" · Needs: F-086, F-087 (secret_store.py)
Reviewed: PASS (key in the keychain only, never in responses/file/DB/exports/DOM; /api/ai/test uses saved settings only). Should-fixes done: a key is dropped when the provider or host changes; deployment names refuse / and ... Real Claude Code Test 2.1 s; Azure and the Mac keychain await the captain.
- [x] Settings has an AI section: provider (Claude Code on this machine / Azure OpenAI / OpenAI-compatible), endpoint or base URL, deployment or model, API version (Azure), API key; Save; "Test" runs one tiny real call and shows the answer time or the plain error
- [x] the key is kept in the system keychain (0600 file on Linux), never in SQLite, backup, export, logs or the page; the page only learns "a key is saved" and can replace or remove it
- [x] jam_brain builds its brain from these settings, the key read from secret_store (F-086 reads only the env var; env vars still override for scripts)
## F-094 Check scripts refuse a busy port [done]
Brief: none (Encode Lessons in Structure: "never kill a process you didn't start" was broken twice, 2026-10-02 and 2026-10-16) · Needs: none
Reviewed: PASS (36 scripts guarded; the real bug was a stale uvicorn on UI+1 silently reused). Follow-ups done: 3137 refused for every checked port, tested.
- [x] every scripts/verify-*.mjs and benchmark that starts a server checks its port first and fails with "port N is busy: set PORT/… to another" instead of reusing or killing whatever is there
- [x] one shared helper, one test; the lessons line points to it
## F-095 Drop a note into a note [done]
Brief: docs/briefs/x-bookmarks.md ("drag onto any note … lands as a link card"); captain: "I can just move around and drop it into a note and it will be there" · Needs: F-088
Reviewed: PASS after one round (a page drop no longer pastes the dragged id into the words, checked on the exact Markdown; X sync never files into the Done archive). Canvas: a JSON Canvas link node personal-note://note/<resourceId>; page: a Markdown link. Secure targets show the title only. Phone: "Link note" / "Link to a note…" (a finger can't start a browser drag). Gaps: secure-note and Obsidian imports don't repoint links; card titles refresh on next open; lucide-icon notebooks show a letter on the card. First load 90.94/91 KiB: the next first-load addition must make room.
- [x] drag a note's row from the notes panel onto an open canvas or page note: it lands as a link card (title, first lines, icon) that opens that note; works for X bookmark notes and any other note
- [x] the link survives backup/import and Markdown export (as a link); a deleted target shows as "note removed", never an error
- [x] a "Done" action on an X bookmark note archives it in one click
## F-096 Show and Undo on "Claude edited this note" [todo]
Brief: docs/design/dynamic-island.md (agent moment) · Needs: F-084
- [ ] the island's agent face offers Show (scrolls to and briefly marks what the agent changed) and Undo (reverts the agent's revision as one step, revision-checked, never losing the person's later edits)
## F-097 First screen first: optional plugins load after it [done]
Brief: docs/briefs/plugins.md ("no plugin code in the first load"); captain 2026-10-16: "speed is important … boom very fast and then load everything behind the scenes" · Needs: F-091
Reviewed: PASS after one round (a failed load shows a toast with Reload instead of a dead mic; tap vs hold by 450 ms; budget walker fails loudly). First load 207.05 → 204.21 KiB, budget tightened to 205. Time to first screen unchanged within noise (scripts/verify-first-screen.mjs, accepted as the measurement): the real win is F-098.
- [x] plugin code (Mind maps, Voice, Search by meaning, Jam, AI and X settings) is fetched after the first paint (idle), never in the first load; a click on a plugin's button before it's loaded waits for it and still works
- [x] the budget script measures the first load separately and its JS number goes down, not up; the 260 KiB total stays; time to first paint measured before and after on the speed test
## F-098 Split the 200 KiB first load so the first screen paints sooner [done]
Brief: docs/briefs/plugins.md; captain 2026-10-16: "boom very fast and then load everything behind the scenes" · Needs: F-097
Reviewed: PASS after one round (an early press belongs to its note pick; sticky/shape replay; title read-only until drawn; pictures before open refused; layout-stability check caught and fixed two shifts). First load 204.21 → 90.28 KiB (budget 91). First screen 701 → 400 ms median, 2592 → 1475 ms at 4x CPU; canvas drawn 701 → 625 ms. Minor follow-ups: a picture dropped after a failed engine load leaves an orphan media file; a list click in the first tens of ms can be overridden by the start-up pick.
F-097 measured it: the first load is ~204 KiB gzip, nearly all the app shell plus Leafer; plugins were only ~3 KiB, so time to first screen didn't move.
- [x] the notes panel and the open note's title paint before the canvas engine (Leafer) and the editors arrive (a light first frame, then the canvas fills in), with no flash or layout jump
- [x] first-load gzip goes down substantially (target under 120 KiB) and the first-load budget is tightened to the new number; median time to first screen (scripts/verify-first-screen.mjs, 11 interleaved runs, normal and 4x CPU) measurably better than before
## F-099 Notes panel doesn't shift when the web font arrives [done]
Brief: none (F-098 follow-up) · Needs: F-098
Reviewed: PASS (a metric-matched "Geist Fallback" face; .brand-name line-height pinned). New font-swap check: y and height exact, x and width within 2 px (a different face can't be the same width); the engine-arrival check stays exact, measured after the font settles and says so if it didn't. Display fonts (Bricolage, Instrument Serif) still fall back to system-ui unmatched.
verify-first-screen's layout check failed 1 of 2 runs on main after F-077 merged: notebook names and the inbox badge move 1–2 px (height 15 → 17) when the web font replaces the fallback.
- [x] the panel's text uses metrics that match the fallback (size-adjust / ascent-override on the @font-face, or a fixed line-height), so the layout check passes 5 runs in a row; the check is not loosened
