# PARA sidebar design

Chosen: **Option B, shelves** (captain, 2026-10-13: "I like option B, I like the rounded edges... it makes the mobile version later more possible").
Mock: https://claude.ai/artifact/7CGbPKqudFnYheroYrLNhn (source kept in `docs/design/sidebar-and-secure-mock.html`; re-implement, don't ship it).

## Tokens and components (existing skin tokens only; works in Crayon, Paper, Night)
- Sidebar glass: `--glass`, `--glass-border`, `--sk-radius`, `--sk-shadow` (unchanged).
- Section row (`.sec-head`): 13.5px/600 `--ui-font`, `--sk-ink`; icon 16px (lucide: inbox, target, compass, book-open; Archive is an inline box SVG with a separate lid group); chevron at the row's end rotates 90° in 180 ms `--ease-out`.
- Open section "shelf": background `color-mix(in srgb, var(--sk-ink) 3.5%, transparent)`, radius 13px, 2px inner padding.
- Rows: radius 9px; hover `--hover`; open notebook weight 500; active note `--pressed`.
- Inbox: first section, count badge 18px pill `--sk-accent` / `--sk-accent-ink`; at zero the badge goes `--hover` / `--ui-muted`; it bumps (scale 1.25, 160 ms `--ease-spring`) when a note leaves Inbox.
- Drag: the source row fades to .45; a ghost row follows the pointer (panel, lifted shadow, -2° tilt); the target gets `--sk-accent-soft` with a 1.5px inset `--sk-accent` ring; a dropped row flashes `--sk-accent-soft` and settles (700 ms).
- Archive lid: rotates -24° while something hovers over Archive (or an archived notebook), closes on drop, and the box "gulps" (scale 1.18, 260 ms).
- Fold: `grid-template-rows: 0fr → 1fr` in 180 ms, so nothing re-renders; a folded section springs open after 500 ms of drag hover. Folded state kept per machine (localStorage, wrapped in try/catch).
- Inline naming: the section's + adds a row with an input ringed in `--sk-accent`; Enter keeps, Esc or an empty blur drops. Hint line "Enter to keep · Esc to drop" in 11px `--ui-muted`.
- Motion respects `prefers-reduced-motion` (no transitions or keyframes).

## States
- Empty Inbox: "All filed. New notes land here." (12px `--ui-muted`).
- Empty section: "Drop a notebook here". Empty notebook: "No notes yet".
- Long names: one line, ellipsis; counts in tabular numbers.
- Loading: the sidebar renders from the notes list already loaded at startup; no spinner.
- Error: a failed move puts the row back where it was and shows the existing toast ("Couldn't move it. Try again.").
- Narrow/mobile (later): the shelves are the touch targets; rows stay at least 32px tall.
