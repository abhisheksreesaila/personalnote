# Editor first, and secure notes

Status: approved
<!-- Approved by the captain on 2026-10-13 ("approved"). -->
<!-- Written with the captain via /clarify on 2026-10-13, after trying v0.5.0-preview.3. Assumptions are marked (assumed).
     Nothing gets built until the captain changes the line above to approved. Folds in F-054 Focus write mode. -->

## Why (the mission)
- Why this exists, in one sentence: a note should feel like an editor you just type into, and turn into a whiteboard only when you draw; and the private things kept in notes (card numbers, passwords) need a lock that is truly safe but costs one touch.
- Why now: preview 3 made the two layers work ("magnificently worked"); what still feels off is the whiteboard first impression, the text box edges, and having no safe place for secrets.
- If it disappeared tomorrow: notes keep opening as a page overview that invites drawing over writing, and secrets stay in plain notes, visible on a shared screen.

## Who it's for
- First: the captain, writing daily on the Mac, sometimes sharing the screen.
- The moment: opening a note to write; pasting a card number or password; sharing the screen in a meeting.

## What it does
1. **Editor first.** A note opens at 100% with the caret ready in its text, the page edges, page map and other canvas furniture quiet. Picking a drawing tool (pen, shape, sticky, connector) smoothly zooms out to show the whole page and its edges; Esc or typing brings writing back to 100%. All tools stay in the dock (nothing is hidden or removed).
2. **Text that doesn't feel like a box.** A text stays one flowing piece (not a block per paragraph or sentence). Its outline hugs the words exactly (no empty space above the first line) and shows only when you pick it with the Select tool, never while you write.
3. **Secure notes.** Mark a whole note secure: its words are encrypted on disk, it shows in its own colour with a lock in the list, and it is locked by default. Touch ID opens it with one touch (Linux: a short passphrase). While a secure note is open the Mac keeps the window out of screen sharing; it locks again when you leave it, after a quiet while (assumed: 5 minutes), or when the Mac sleeps (assumed). Search, Markdown export and agents never see its words (assumed); backups keep it encrypted (assumed).
- Also, only if it costs no typing speed: **code colours** inside ``` fences, the language from the fence or guessed, loaded only when a code block appears.
- Not now: securing part of a note, sharing secure notes, recovery if the Mac's keychain is lost (assumed: a one-time recovery key is shown when the first secure note is made), phones.

## How it should look and feel
- Three words: quiet, instant, safe. (assumed)
- Like opening a document in iA Writer or Bear; drawing reveals the page like a whiteboard zooming out. The prototype look stays.
- The screen that matters most: a just-opened note with the caret blinking.

## How we'll know it worked
- The captain opens a note and types without seeing canvas furniture; drawing feels like the page opening up, not a mode switch.
- A secure note never shows its words on a shared screen, in search or in the files on disk, and opens with one touch.
- Typing latency stays at today's level or better (speed test row).

## Constraints and risks
- Riskiest: Touch ID and screen-share exclusion from a pywebview app on macOS (LocalAuthentication, Keychain, NSWindow sharingType). Cheapest test: a small spike in the desktop shell before anything else.
- Losing the key loses the notes: needs the recovery key and a clear warning.
- Changing a default (lesson 2026-10-12): the captain loses the page overview on open; it comes back the moment a drawing tool is picked or the view is zoomed out.

## Decisions and trade-offs
- Touch ID (passphrase on Linux) over swipe-only: real encryption with one touch; costs a platform spike and a recovery key.
- Whole notes, not blocks: simple and obvious what's protected; can't hide one line inside an ordinary note.
- Editor first, zooms out on draw: writing is the default feel; the page overview is one tool-pick away.
- One flowing text, tighter outline: typing, selecting and undo across paragraphs keep working; a text is still one object when moved.
