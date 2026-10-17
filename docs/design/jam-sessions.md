# Design: jam sessions (option A chosen)

Engine: Google Stitch · project https://stitch.google.com/projects/2590299325427189451 · Brief: docs/briefs/jam-sessions.md
Status: option A chosen by the captain 2026-10-16 ("on the map is more intuitive … I can see where I'm seeing and then I can just suggest"). Stitch HTML is a reference only; rebuild with the skin tokens.

| Option | Screens | Idea |
|---|---|---|
| A · ghosts on the map | `jam/option-a-desktop.png`, `jam/option-a-phone.png` | Ghost branches carry their own Yes/No pills on the map; the island shows the live line and Jam. |
| B · suggestions in the island (not chosen) | `jam/option-b-desktop.png`, `jam/option-b-desktop-alt.png` | The map stays clean: ghosts are faint dashed "?" branches only; the dynamic island grows into a dark card with the live line, "Claude suggests" chips (✓ ✕) and Jam. One place to answer, keyboard-friendly (Y/N on the focused chip), and it reuses the island the captain chose. |

Both: Buzan map (central bubble, thick tapering coloured main branches, keyword on the line, emoji on main branches, 👍/👎 badges with a one-line reason on hover), the existing islands (notes button, search circle, tool island + mic, undo, zoom). Stitch added a menu icon, breadcrumb, avatars and Share in A: not ours, ignore them.

## Build notes for A
- Ghosts sit on the map where they'd grow: faint, dashed, with small Yes / No pills beside the keyword. Yes turns it into a real branch (one undo step); No fades it out.
- The island shows the live line while the mic is held and the Jam button; while the brain thinks it shows "Thinking…" and the map is still editable.
- Stitch's menu icon, breadcrumb, avatars and Share are not ours: ignore them.
- Tokens: the skin variables in `src/skins.css`; branch colours from the mind map's existing palette. Text and emoji always rendered as text, never HTML.

| Gesture | Does | Visible alternative | Threshold |
|---|---|---|---|
| Hold mic (tap-to-toggle on phone) | live line in the island | mic button | 0 |
| Tap Jam / say "jam" at the end | one brain turn | Jam button in the island | one turn in flight at a time |
| Tap Yes on a ghost / say "yes" | ghost becomes a branch | Yes pill (48px target on phone) | — |
| Tap No on a ghost | ghost fades | No pill | — |
| Hover / long-press 👍 👎 | one-line reason | tooltip | 400 ms |

States: no brain set up ("Set up a model in Settings → AI", a button there), thinking, brain error (plain message, map untouched, Try again), empty map (centre idea from the title, "Hold the mic and talk"), many ghosts (max 3 shown).
Phone: same map; Yes/No pills grow to 48px; the island holds the live line and Jam at the bottom of the thumb zone.
