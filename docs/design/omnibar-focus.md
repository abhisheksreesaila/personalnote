# Omnibar and focus mode design

Brief: docs/briefs/focus-search-switch.md · Tickets: F-072 (omnibar), F-073 (focus mode).
Mock: https://claude.ai/artifact/5H94xn5pywpxRpsgiRUZt6 (source `docs/design/omnibar-focus-mock.html`; re-implement, don't ship it).
Chosen: **pending the captain's pick** (one option for the omnibar, one for focus mode).

## Options
Omnibar
- **A · Spotlight:** a slim pill at the top centre (`Search or jump to…  ⌘K`). Opened, a 640 px panel drops just below it over a soft dim, with one column of groups (Recent/Notes, In your words, Notebooks, Actions).
- **B · Two panes:** an 860 px panel with results on the left and a live preview of the highlighted note on the right. A secure note's preview shows the title and a lock only.
- **C · The bar grows:** no dim. The bar itself unrolls downward (560 px) into the results, with filter chips All / Notes / Notebooks / Actions.

Focus mode
- **A · Paper column:** words only, in a 680 px column on `--paper`. "Esc or ⌘. to leave" shows for about 2 s and fades. A faint word count and reading time sit bottom right on hover.
- **B · Typewriter:** like A, but the paragraph you are in stays at full ink, the rest sit at about 32% ink, and the typing line stays near mid-screen.
- **C · Quiet strip:** like A, plus a 52 px top strip that shows only on hover, with the title, word count and a "Leave focus" button.

## Tokens and components (existing skin tokens only; Crayon, Paper, Night)
- Bar: 36 px pill, `--glass` + `--glass-border` + `--sk-shadow`, blur 18px. Placeholder in `--ui-muted`, 13.5px `--ui-font`, and a `⌘K` keycap. The hover border mixes 45% `--sk-accent`.
- Top bar becomes three columns: breadcrumb (left), bar (centre), actions (right, adds the focus button). The old top-right search button goes; ⌘K is unchanged.
- Panel: `--sk-panel` surface, radius 20px, a lifted shadow, a 19px input (15px in C). It grows in 180 ms `--ease-spring` from the bar (scale .96 → 1).
- Result row: radius 11px, a 28 px icon tile (`--hover`). The selected row is `--sk-accent-soft` with the tile in `--sk-accent` / `--sk-accent-ink`. Matches use a soft highlighter mark. Word snippets are set in the reading face.
- Secure note: lock tile in `--sk-secure-soft` / `--sk-secure`. It matches by title only, its subtitle reads "Secure note · opens with Touch ID", and no words or preview are shown.
- Group labels: 11px/600 uppercase, letter-spacing .07em, `--ui-muted`. The footer keycaps are ↑ ↓ ↵ Esc.
- Focus: full-window `--paper`, a 680 px column, a 34px display title, a 20px/1.75 reading face, and the caret in `--sk-accent`. Count is 12px `--ui-muted`, opacity 0 → .75 on hover.
- Motion respects `prefers-reduced-motion`.

## States to build
- Empty query: Recent notes (4) plus the top actions (New note, Quick note, Focus mode).
- No results: "Nothing matches "…"", the line "Secure notes match by title only.", and a selected "New note "…"" row (Enter creates it).
- Long titles and snippets: one line with an ellipsis.
- Loading: titles and notebooks come from the list already loaded. Word matches use the existing FTS search; while they load, the title groups show and the words group fills in, with no spinner.
- Error: if word search fails, title results still show, with a muted line "Couldn't search inside notes."
- Phone width: the bar is a search icon. Tapped, the search fills the screen with a Cancel button and no footer.
- Focus: entering hides the sidebar, dock, page map, page edges and dotted desk, and turns drawing off. The Mac app goes full screen. Esc or ⌘. restores the exact previous layout, tool and scroll position.
