# 0001 Canvas engine: move from Fabric.js to LeaferJS

Date: 2026-10-01 · Status: accepted (captain: "from a feel-wise, Leaf.js is my answer")

## Context
A three-way prototype (Engine Showdown artifact) drew the same note desk in Fabric.js 7, LeaferJS 2.3 and PixiJS 8 with editing tools. Captain's feel: Leafer at ~15,000 objects behaves like Fabric at 5,000; handles are simpler (four corners + rotate) and less likely to distort text. PixiJS is faster at 50k–100k but ships no selection, transform or text editing (research: 14–18 weeks to rebuild them). Leafer ships transform editor, box/multi select, in-place text editing, viewport, arrows and JSON export; Canvas 2D with partial (changed-region) redraw. MIT, active, small team, docs mostly Chinese. Bundle: leafer-editor ≈ 97 KB gzip vs Fabric ≈ 90 KB.

## Decision
LeaferJS becomes the canvas engine. Notes are stored in our own engine-independent document model in SQLite (not engine JSON); Leafer is a rendering/editing adapter over it. Undo, pen, eraser, page growth, connectors-to-model sync stay app code.

## Consequences
- AGENTS.md invariant 2 ("Fabric JSON is canonical for canvas") changes to our document model; existing notes migrate once, tested, never lossy, originals kept until verified.
- Pan/zoom of very dense views is a full Canvas 2D redraw; mitigate with caching, cheaper shadows, and Leafer's worker rendering if it helps. PixiJS stays the fallback if notes outgrow it.
- Dependency risk on a small upstream team: pin versions, keep the adapter thin.
