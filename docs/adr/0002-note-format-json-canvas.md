# 0002 Note format: Obsidian-compatible JSON Canvas + Markdown

Date: 2026-10-02 · Status: accepted (captain: "let's use that Obsidian format… people wanting to come from Obsidian can easily do that… adoption will be high"; "OKF is not such a great one")

## Context
After ADR 0001 (LeaferJS), notes needed a stored format that is open, readable by agents and other apps, and not private to Personal Note. Options checked: Google's Open Knowledge Format (OKF v0.1, June 2026: Markdown files + YAML frontmatter for agent knowledge bundles; no notion of canvas layout) and JSON Canvas 1.0 (MIT, created by Obsidian for infinite canvases: nodes text/file/link/group with x/y/width/height, Markdown text, edges with fromNode/toNode/sides/ends, colors).

## Decision
- A canvas note is stored as a JSON Canvas 1.0 document: text and stickies as `text` nodes (Markdown), images as `file` nodes pointing at media files (F-023), connectors as `edges`, pages/groups as `group` nodes.
- What JSON Canvas lacks (rotation/scale/flip/skew, ink points, shape kind, sticky style, highlighter, page grid) rides in one namespaced extension object per node (`"pn": {...}`) and a top-level `"pn"` object, so any JSON Canvas reader still opens the note. Ink strokes and shapes are also written as SVG media files referenced by `file` nodes, so Obsidian shows them.
- Mind maps (and future plugins) store their documents as JSON Canvas too.
- Every note also has a Markdown projection (reading order by top edge) used for search, the agent CLI and export.
- SQLite remains the store (one row per note, JSON text, compressed when large) with FTS over the Markdown projection; media are separate files. Import/export of an Obsidian vault (.canvas + .md + attachments) is a supported path.
- Existing notes are converted once with the F-025 converter; the old database file is kept aside untouched.
- The F-025 document model stays as the in-memory model; serialization changes from Fabric JSON to JSON Canvas + `pn`.

## Consequences
- AGENTS.md invariant 2 becomes "JSON Canvas (+pn extensions) is canonical for canvas notes"; F-036 updates it with Fabric's removal.
- JSON Canvas uses integer x/y/width/height; exact geometry lives in `pn` and the integer fields are kept as the nearest rounding for other readers.
- Extension fields are ignored by other apps; ink/shapes degrade to their SVG pictures there.
