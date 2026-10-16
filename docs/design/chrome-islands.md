# Design handoff: floating islands

Engine: Google Stitch · project https://stitch.google.com/projects/2590299325427189451 · Brief: docs/briefs/chrome-islands.md
Chosen: "APPROVED 1" (screen 771c17f4…, `chrome-islands/approved-1.png|html`) for the resting layout, "APPROVED 2 - FOCUS MODE"
(screen ef9dc938…, `chrome-islands/approved-2-focus.png|html`) for the title pill and the Focus button. Stitch drew in the Paper skin;
its HTML is Tailwind and a reference only. Rebuild with the existing skin tokens so Crayon, Paper and Night all work.
Stitch's note content (checklists, sticky text, photo) is filler, not scope.

## Tokens and components (existing tokens only, `src/skins.css`)
- Island: `--sk-panel` background, 1px `--sk-edge`, `--sk-shadow`, radius `--sk-radius` (pills fully round). Inset 16px from the window edge.
- Notes button: 44px circle island, lucide `panel-left`. Pressed/open state `--pressed`.
- Notes panel: today's sidebar contents in an island 280px wide, top 72px to bottom 16px, beside the note on a wide window: the note area starts where the panel ends, the title pill and top-right islands centre on and sit within the note area, the tool island, undo/redo and zoom stay at its edges, the page stays centred in it (no scrim; scrim stays at narrow widths, where it slides over). Fade 150ms; the area shifts at once.
- Title pill: centred island, title in `--ui-font` 13.5px/600 `--sk-ink`, save dot + state 12px `--ui-muted`, ⋯ button at the end opening today's share menu items plus Clear all, Fold all, Settings.
- Focus button: pill with lucide `focus` + "Focus" + key cap; search pill unchanged from the omnibar.
- Tool island: 56px wide vertical island, 44px tool buttons, active tool solid `--sk-ink` circle with `--sk-panel` icon; 1px `--sk-line` dividers; colour dot 28px showing the current colour; **+** opens a flyout to the left of the island; mic 44px solid ink circle at the foot.
- Corner islands: undo/redo pill bottom left; zoom pill bottom right (−, value, +, fit).

## Gestures
| Gesture | Does | Visible alternative | Threshold |
|---|---|---|---|
| Click notes button / Esc (narrow: also the scrim) | toggle the notes panel | the button | — |
| Hold a tool | colour and width options (as today) | colour dot | today's hold time |
| Click colour dot | colour and width options | — | — |
| Click + | flyout with the other tools | — | — |
| Keyboard shortcuts (V H T D M R N C I E, ⌘K, ⌘., ⌘Z) | unchanged | the islands | — |

## States
- Save error: the title pill's state slot shows the error in `--sk-danger`; never a modal.
- Long title: one line, ellipsis, pill max 40% of the window.
- Mind map note: the island shows the mind-map actions; text/pen tools hidden as today.
- Page note: the island shows what the page note shows today.
- Focus mode (F-073): hides every island as it hides the old chrome today.
- Narrow window (< 760px): the existing mobile controls stay as they are (phone layout is a later ticket).
- Print: unchanged (invariant 9).
