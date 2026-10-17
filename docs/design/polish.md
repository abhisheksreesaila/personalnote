# Design handoff: prettier note icons, search and Settings (F-100, F-101, F-102)

Engine: Stitch + Claude side by side (Stitch project 2590299325427189451; Claude's live board `docs/design/polish/claude.html`; pictures in `docs/design/polish/img/`, today's app as `before-*`).
Languages: web = Personal Note skins (Paper shown; Crayon and Night must work too), phone = Liquid sheets. Cosmetic only: same features, places and keys.
Chosen (captain, 2026-10-17): Claude's note icons, Claude's search, Claude's Settings layout with Stitch's "Search settings" box, and **Settings monochrome** (neutral icon tiles, no colour per section).

## Tokens and parts
- Only skin variables from `src/skins.css` (`--sk-*`). No new hex values except where noted.
- Tile tints: the skin's five object colours softened, `color-mix(in srgb, var(--sk-cN) 34–38%, var(--sk-panel))`, so they follow the skin.
- Emoji tile sizes: 24 px (desktop list, radius 7), 32 px (phone list, radius 9), 40 px (search rows, radius 11), 64 px (page icon above the title).
- Match highlight: marker stroke, `linear-gradient(transparent 18%, color-mix(in srgb, var(--sk-c1) 70%, transparent) 18% 88%, transparent 88%)`.
- Settings tiles (monochrome): `color-mix(in srgb, var(--sk-ink) 7%, var(--sk-panel))` with a 1 px `--sk-line` inset and `--sk-ink-soft` Lucide icon; the selected section's tile is solid `--sk-ink` with `--sk-accent-ink` icon. Switches: off `--sk-edge`, on `--sk-ink`. No coloured pills (status uses `--sk-accent-soft`).

## 1 · Note icons (F-100)
- Every note row in the notes panel shows its emoji in a tinted tile; the type glyph (page, canvas, map) moves to the right of the row, muted.
- A note with no chosen icon shows a guessed one (from the title, like notebook icons), else a type default (📄 page, 🎨 canvas, 🧠 mind map). Guessing must not grow the first load (the 91 KiB budget has ~0.5 KiB free): guess on the server or in a lazy chunk.
- The open page/canvas/map shows the emoji at 64 px above the title (page notes) or in the title island (canvas, map). Click either → picker popover: search, Recent, ~24 common emoji, five tints, "Guess from title", "Remove". Phone: the picker is a bottom sheet.
- Phone rows are 52 px: tile, title, one-line snippet, type glyph.

## 2 · Search (F-101)
- Desktop: the omnibar opens centred near the top, 760 px wide, over a soft dim. Rows: 40 px emoji tile, title and one snippet line with matches marked, notebook chip (dot + name) and relative time on the right; "by meaning" tag on meaning-only matches. The selected note previews on the right (250 px: emoji, title, notebook chip, first lines, type/edited/created). Filter pills show counts. Footer key caps unchanged.
- Phone: full sheet, rows 64 px, no preview pane, Cancel on the right.
- Notebook results use the notebook's icon; actions keep a neutral tile.

## 3 · Settings (F-102)
- Desktop: its own centred window (900 × 620, radius 20) over a dim. Left: "Settings" title, a "Search settings" box, sections with monochrome tiles: Appearance, Writing · AI, Plugins, Voice, Search by meaning, X bookmarks · Locked notes, Advanced. Right: section title (display font), one-line description, grouped cards with hairline rows, switches instead of checkboxes, segmented controls.
- The open note's properties (notebook, type, storage) leave Settings: a small popover from the title island.
- Phone: an iOS-style grouped list sheet (52 px rows: tile, label, value, chevron) that drills into each section; Appearance shows the three skin cards.

## Gestures
| Gesture | Does | Visible alternative | Threshold |
|---|---|---|---|
| Tap note emoji (list or page) | Opens the icon picker | "Change icon" in the note's ⋯ menu | tap < 450 ms |
| Swipe down on a sheet (phone) | Closes Settings / search / picker | Close (×) or Cancel button | 80 px or fast flick |
| Arrow keys in search | Moves selection and preview | Click a row | — |

## States
- Empty search: recent notes with their emoji. No results: one line "Nothing matches “x”" plus New note action.
- Settings sections still loading (lazy chunk): the window opens at once with the section list; the right side fills when the code arrives (keep F-097's toast on failure).
- Long titles truncate with an ellipsis on one line; snippets one line.
- Night skin: tiles and markers read on dark panels (check contrast).
