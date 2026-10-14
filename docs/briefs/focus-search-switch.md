# Focus mode, an omnibar, and switching without the mouse

Status: approved
<!-- Written with the captain via /clarify on 2026-10-13, after trying v0.5.0-preview.5. Assumptions are marked (assumed). -->

## Why (the mission)
- Why this exists, in one sentence: writing and drawing should flow into each other without reaching for the mouse, search should be the one obvious place to find anything, and writing should have a mode where nothing else exists.
- Why now: preview 5 is "awesome"; what's left is friction: switching tools takes the mouse every time, search sits in a corner like an afterthought, and the focus mode first asked for on 2026-10-12 (folded into editor-first) is still missing.
- If it disappeared tomorrow: every switch between pen and text costs a trip to the dock, search stays a box in a corner, and long writing keeps the canvas furniture around it.

## Who it's for
- First: the captain, writing and sketching on the Mac with keyboard and mouse (and later a pencil on a tablet).
- The moments: mid-sentence, wanting to underline or sketch, then straight back to typing; looking for anything at all; sitting down to write for an hour.

## What it does
1. **Switch without the mouse, like the Apple Pencil double-tap.** Double-tap ⌘ (Ctrl on Linux/Windows) toggles writing ↔ your last pen tool, even while the caret is in your text (no Esc first). Pressing the mouse's middle button once (a click without dragging, so middle-drag panning keeps working) does the same. A small pill flashes "Pen" or "Text" (assumed). Switching back to text puts the caret where it was (assumed). The dock and single-key shortcuts stay as they are.
2. **An omnibar.** Search moves from the top-right corner to a slim bar at the top centre of the window, like Chrome's address bar. Click it or press ⌘K and it grows into a large centred panel that finds notes by title and words, notebooks, and actions (new note, quick note, make secure, focus mode, switch skin) (assumed: actions in v1). Arrow keys and Enter pick; Esc closes. Secure notes show by title only. On a phone it is a search icon that fills the screen (assumed).
3. **Focus mode.** ⌘. or a focus button in the top bar: the window becomes only your words in a comfortable centred column on plain paper colour. No sidebar, dock, page map, page edges or dotted desk; drawing is off. A faint word count appears on hover (assumed). Esc or ⌘. brings everything back exactly as it was. The Mac app goes full screen with it (assumed).
- Not now: a real Apple Pencil (needs the tablet app), a mobile omnibar beyond the icon, searching inside drawings.

## How it should look and feel
- Three words: fluid, findable, quiet. (assumed)
- Like the Apple Pencil double-tap, Chrome's omnibar / Raycast, and iA Writer's focus mode.
- The screen that matters most: focus mode mid-paragraph; second, the omnibar opened with ⌘K.

## How we'll know it worked
- The captain writes, underlines and sketches a page without touching the dock.
- Every search starts from the omnibar; nobody asks where search is.
- Focus mode is used for long writing; typing speed (speed test row) unchanged.

## Constraints and risks
- Riskiest: double-tap ⌘ must never fire when ⌘ is used for a shortcut (⌘C, ⌘Z…): only two clean taps of ⌘ alone within about 300 ms count. Cheapest test: a key-timing unit test plus real-keyboard checks with ⌘ shortcuts in between.
- macOS may reserve double-tap ⌘ for dictation if the captain set it so (System Settings › Keyboard › Dictation); if so, double-tap ⌘ is off on that Mac and middle-click still works (assumed).
- Changing a default (lesson 2026-10-12): search moves from the corner to the centre; ⌘K still opens it, nothing else is removed. ⌘⇧F stays the speed meter.

## Decisions and trade-offs
- Double-tap ⌘ over ⌘1/2/3: one gesture, no clash with typing or browser tabs; costs careful timing logic.
- Middle-click toggle: hand stays on the mouse; costs telling a click from a middle-drag pan.
- Omnibar at top centre over a corner box: one obvious place; costs top-bar space and a redesign of the search panel.
- Focus mode hides everything but words: deepest calm; drawing is unavailable until you leave it.
