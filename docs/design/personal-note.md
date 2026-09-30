# Design handoff — Personal Note (cover + note canvas)

Status: chosen — **Crayon** (Apple-bright colors) is the default skin; Paper and Night ship as the other two skins · Mode: Explore (not Terminal Ledger)
Canvas: https://claude.ai/artifact/6PY4JxfRZraj1kZgnCJEtX
Brief: docs/brief.md (approved)

## Options on the canvas
Each row is one direction: note canvas (1440×900) + cover/landing page (1440×2560).
All three share one layout, so they double as the v1 **skins** — the brief asks for 2–3.

| | Paper | Crayon (chosen default) | Night |
|---|---|---|---|
| Feel | warm ivory paper, tomato cloth cover | bright white, Apple system colors | dark desk, glowing ink |
| Display type | Fraunces | Bricolage Grotesque | Instrument Serif italic |
| Body / hand / mono | Geist / Caveat / Geist Mono | same | same |
| Accent | #E5533D | #0A6CFF | #7EE7C8 |
| Hero idea | one closed notebook with elastic band | fan of PARA notebooks | midnight cover, foil title |

Plus an interactive board (**Try it — page growth + skins**) showing the expand/shrink motion
and the live skin switch.

Break from house style: warm/colored grounds instead of terminal dark, serif or rounded
display faces, 14–18px radii, soft layered shadows, spring motion.

## Layout (note canvas)
- Left rail (204px, glass): brand mark, **Quick note ⌘N**, Inbox, PARA sections
  (Projects / Areas / Resources / Archive) with colored notebook dots, skin swatches at bottom.
- Top bar over the desk: breadcrumb, note title in display face, "Saved on this Mac",
  **agent presence chip** ("Claude Code is reading"), search pill **⌘K**, share/export.
- Desk: dotted ground; pages are contiguous 860×1080 sheets separated by a dashed fold line.
  A dragged object crossing the edge shows a **ghost next page** (dashed accent outline + "+ Page N" pill).
- Agent cursor: a colored cursor flag ("Claude · reading") where an agent is working.
- Bottom dock (glass pill): select, text, pen, highlighter, shape, sticky, connector, image,
  eraser · 5 ink swatches · undo · round accent **mic** (hold to talk).
- Bottom-left: page minimap + "3 pages · 3 × 1". Bottom-right: zoom.

## Tokens (per skin)
desk, deskDot, paper, paperEdge, ink, inkSoft, muted, line, chrome, chromeBorder, accent,
accentInk, accentSoft, c1–c5 (object palette) with k1–k5 (text on each), hl (highlighter),
cover, coverDark, band, display, body, hand, mono, radius, pageRadius, shadow.
Exact values: `SKINS` in the generator the canvas was built from; move them into
`src/workspace-theme.css` as CSS custom properties per `[data-skin]` when building.

## Motion
- Page grow: 560ms, cubic-bezier(.2,.9,.25,1.08) (slight overshoot); fold: 420ms ease-out.
- Dragged object lifts: +2° tilt, deeper shadow. Skin switch: 400ms color crossfade.

## States to build
- Empty note: one page, date + blinking caret; no ghost page.
- Loading: paper renders first; sidebar counts fade in.
- Error: save failure shows in the "Saved" slot in accent, never a modal; voice-unavailable in the mic tooltip.
- Long content: pages to 4+ columns/rows; minimap scrolls; zoom-to-fit.
- Small screens: rail collapses to an icon button; dock becomes a single scrolling row; mic stays.

## Invariant to watch
`src/workspace-theme.css` is screen-only today (AGENTS.md invariant 9). Skins change the
paper color on screen; decide whether print stays white (recommended: yes).

## Engine (stress test, 2026-09-30)
Keep Fabric.js. Required first: size the canvas to the window (not the page grid), pan/zoom via
`viewportTransform`/`zoomToPoint`, draw page tiles in `before:render`, page growth changes only the
page count. Keep `skipOffscreen`, `renderOnAddRemove:false`, `requestRenderAll` batching, and
per-object connector lookup. Re-measure `objectCaching` on real GPU hardware.
