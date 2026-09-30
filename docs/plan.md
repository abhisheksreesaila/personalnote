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

## F-004 New canvas chrome [doing]
Design: docs/design/personal-note.md (Layout) · Needs: F-003
- [ ] sidebar with Quick note (⌘N), Inbox and Projects / Areas / Resources / Archive notebooks with colored dots
- [ ] top bar with note title, "Saved on this Mac" state, search pill (⌘K) and share/export
- [ ] floating bottom dock with tools, ink swatches, undo and the hold-to-talk mic
- [ ] page minimap with page count, and zoom control
- [ ] a ghost "+ Page N" appears while dragging past the edge; dragged objects lift with tilt and shadow
- [ ] keyboard panning (arrows, PageUp/PageDown, Space) and a scroll indicator, since the window-sized canvas (F-002) has no native scrolling

## F-005 Connectors [doing]
Needs: F-002
- [ ] a connector tool draws an arrow between two objects
- [ ] connectors follow both ends live while either object is dragged, including across new pages
- [ ] connectors save, reload, undo and export with the note

## F-006 Agent CLI, ready for Claude Code [done]
Needs: none
- [x] `personal-note` search, read (as plain text) and write/append work against the live notebook without breaking revisions
- [x] an agent write shows up in the open app without a reload
- [x] while an agent is reading or writing a note, the app shows the "Claude Code is reading" chip and cursor flag
- [x] AGENTS.md invariant 8 and the product docs updated: agent access is now in scope

## F-007 Cover page (Crayon) [doing]
Design: Crayon cover artboard · Needs: F-003
- [ ] landing page with the fanned PARA notebooks hero, "a page that grows" steps, "your agents can read it too", skins, final download call
- [ ] works at phone width without horizontal scroll

## F-008 Agent sync polish [todo]
Needs: F-006, F-002
- [ ] undo right after an agent's text is merged in does not remove the agent's text (record a history snapshot after merge)
- [ ] the agent cursor flag does not cause stutter while dragging on a 600-object note (place it at most once per frame, cache the target block)
- [ ] the flag clears immediately when switching notes
- [ ] the flag follows pan and zoom on the window-sized canvas

## F-009 Canvas polish after the rework [todo]
Needs: F-002
- [ ] autosave on a 600-object note no longer freezes a frame for 100ms+ (defer or slim serialization)
- [ ] after fold-back or undo the view settles inside the content without a later snap
- [ ] the writing guide draws under the text, not over it
- [ ] on a real retina Mac: zoom-out on the 600-object note stays smooth; decide objectCaching for ink paths
