# PARA sidebar: a real Inbox, filing by drag, smooth folding

Status: approved
<!-- Approved by the captain on 2026-10-13 ("yes"). Written with the captain via /clarify the same day, after trying v0.5.0-preview.4. Assumptions are marked (assumed). -->

## Why (the mission)
- Why this exists, in one sentence: notes should land somewhere safe the moment they're made, and filing them into Projects, Areas, Resources or Archive should feel like tossing a paper into the right box, fast and a little delightful.
- Why now: the sidebar already groups notebooks by PARA, but Inbox is only a list of recent notes (it never empties), sections can't be folded except Archive, and making a notebook is clumsy (its dialog couldn't even be cancelled).
- If it disappeared tomorrow: notes pile up wherever they were made, and the PARA headings stay labels instead of a way of working.

## Who it's for
- First: the captain, capturing quick thoughts all day on the Mac and tidying them later.
- The moment: a few unfiled notes sit in Inbox; the captain drags each into a notebook, or drags a finished project's notebook into Archive.

## What it does
1. **A real Inbox.** New notes and quick notes land in Inbox until filed (assumed: Inbox is one built-in place, not a notebook you can rename or delete). Its count is the number of unfiled notes, and it empties as you file. Existing notes stay where they are today.
2. **File by drag.** Drag a note from Inbox (or any notebook) onto a notebook to move it. Drag a whole notebook onto Projects, Areas, Resources or Archive to change its section. The note's breadcrumb picker keeps working for people who don't drag.
3. **Fold smoothly.** Inbox, Projects, Areas, Resources and Archive each fold and unfold with a chevron; the folded state is remembered (assumed: per machine).
4. **Subtle motion, under 200 ms.** The dragged row lifts, the target highlights, a section springs open if you hover over it while dragging (assumed: after about half a second), and the Archive box lid opens as a note or notebook drops in and closes after it. Plain CSS, no new library, nothing that touches typing speed.
5. **A notebook dialog that gets out of the way.** Cancel, the X and Esc always close it; Enter creates. (assumed: a new notebook can also be named inline right in its section, no dialog.)
- Not now: nested notebooks, tags, sorting by hand, multi-select drag.

## How it should look and feel
- Three words: zippy, calm, tactile. (assumed)
- Like the Mac Finder sidebar and Things 3 dragging: the row follows the pointer, the target answers, nothing jumps.
- The screen that matters most: the sidebar with a few notes in Inbox, mid-drag over Archive.

## How we'll know it worked
- The captain files a day's notes from Inbox by drag without thinking about it, and Inbox shows 0.
- Folding and dropping run at 60 fps on the Mac; typing speed (speed test row) unchanged.

## Constraints and risks
- Riskiest: drag and drop inside the Mac app's webview (WKWebView) behaving like the browser. Cheapest test: the existing note drag already works there; check notebook drag first.
- Changing a default (lesson 2026-10-12): new notes stop going straight into the selected notebook; the captain loses that, and gets it back by making the note from inside a notebook (assumed: the + in a notebook still makes it there).

## Decisions and trade-offs
- Real unfiled Inbox over Recent: true PARA and it empties; costs a new place for notes and a one-line migration.
- Notes and notebooks both drag: archiving a whole project is one gesture; costs a second drag target type.
- Subtle CSS motion over playful: zero weight and no speed cost; less showy.
