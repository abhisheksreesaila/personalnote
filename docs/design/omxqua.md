# Personal Note in omxqua (a reskin, not a redesign)

Language: omxqua (`~/Projects/omxqua`, LANGUAGE.md), Notes family: the skins keep their own colours, fonts and accent (Paper ink, Crayon blue, Night mint; Bricolage / Instrument Serif headings); omxqua brings texture, shape and motion. Shell: Canvas (floating islands over the work), already in place. Approved by the captain 2026-10-20 from the before/after page; screenshots in `omxqua/img/` (`before-*`, `after-*`), drawn by `omxqua/shoot.mjs` (real build, scratch DB) with `omxqua/prototype.css` laid over it (a reference, not code to ship: it uses !important overrides; build the rules in place).

## Texture (F-103)
- No glass, blur or translucency on chrome: `--glass` is the solid panel; every `backdrop-filter` on chrome goes (the page note's own sticky strip in `page-style.js` is chrome too). The Settings dim is a scrim colour, not `brightness()`.
- Depth = tone + one shadow scale: `--oq-shadow-1` (resting controls, cards, skin cards, zoom, page map, hints), `-2` (islands, the notes panel, popovers, menus), `-3` (search panel, Settings window). The hairline ring lives inside the shadow; drawn 1px borders on these surfaces go. Light and Night values: prototype.css (Night adds the inset top highlight).
- Hover / press / selected = state layers of the skin's ink: 8% / 12% / 16% (`--hover`, `--pressed`, selected), never a new colour.
- Paper desk a touch deeper (#ece7dd), Night panel one step up (#171c24), so surfaces separate by tone.

## Shape (F-103)
- Pill = tappable: Quick note, Settings section rows, their icon tiles, filter chips (tinted, no outline; the pressed chip stays filled ink).
- Status = small mono badge, radius 4: the Inbox count, notebook counts, the search notebook tag.
- Close buttons: one 32px circle with a faint state layer.

## Motion (F-104)
- One press for everything: tappable things squash on pointer-down and spring back (≤48px 0.90, ≤260px 0.96, larger 0.985) on `--oq-spring-fast`; one small delegated listener, no per-component `:active` scale rules (remove the existing ones). Canvas content never presses.
- Panels and pop-ups don't bounce: Settle tier for panels and sheets (fade + 12px, 280ms decelerating, out 160ms), Gentle for menus/popovers (220ms, 4px, 3% scale, no overshoot), None for ⌘K search and anything keyboard-driven.
- `prefers-reduced-motion`: springs become 150ms fades.
- Naming: no "Dynamic Island" in code or current docs; the top pill is the title island (omxqua reserves "Beacon" for live activity).

## Not changing
Layout, the islands' places, emoji note icons (content, not chrome), monochrome Settings, saved canvas / page / print appearance (invariant 9), the skins' colours and fonts.

## States
Unchanged from F-100..F-102; each must still read in Paper, Crayon and Night, desktop and phone, with `prefers-reduced-transparency` and `prefers-contrast: more` still honoured.
