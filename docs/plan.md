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
- [x] keyboard panning (arrows, PageUp/PageDown, Space) and a scroll indicator, since the window-sized canvas (F-002) has no native scrolling

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
- [ ] the writing guide draws under the text, not over it
- [ ] on a real retina Mac: zoom-out on the 600-object note stays smooth; decide objectCaching for ink paths
- [ ] large transparent images in WebKit (Mac app) stay PNG because WebP encoding falls back; check and handle
- [ ] verify-objects sticky-lock check asserts the sticky count

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
