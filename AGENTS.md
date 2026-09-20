# Agent Guide — Personal Note v1

Personal Note is a local, desktop-first spatial notebook. The required product path is canvas editing, SQLite persistence, local FTS5 search, and user-controlled export. Voice transcripts and mind maps are optional built-in modules.

## Read first

- `docs/PRODUCT-BRIEF.md` — v1 scope and product decisions
- `docs/ARCHITECTURE.md` — runtime, data flow, and file map
- `docs/MODULE-CONTRACTS.md` — narrow internal module boundaries
- `docs/ROADMAP.md` — completed slice and deferred work

## Core boundaries

- `src/main.js` owns the browser shell and Fabric canvas lifecycle.
- `src/core/api.js` is the browser API boundary.
- `routes.py` owns core HTTP routes.
- `services.py::NoteService` is the only owner of canonical SQLite reads and writes.
- `portability.py` projects storage into backup and readable export formats.
- `src/modules/mindmap.js` lazy-loads `src/mindmap/` only when a mind-map note opens.
- `src/modules/voice/` owns voice transcript and capture adapters. It must never persist audio.

These are internal contracts, not a public plugin SDK.

## Invariants

1. Capture must not wait on an optional service.
2. Fabric JSON is canonical for `canvas`; normalized map JSON is canonical for `mindmap`.
3. A note's `noteType` is immutable after creation.
4. Voice may persist final editable transcript text only. Do not add IndexedDB, SQLite, filesystem, backup, or export storage for PCM/audio.
5. Local transcription failure must be visible and must leave the note intact.
6. Backup JSON is lossless and versioned. Import is validated, transactional, and merge-only; it never deletes or overwrites existing notes.
7. Markdown export is explicitly lossy and never fetches remote assets.
8. The v1 core has no model worker, automatic suggestions, agent endpoint, chat, sync, or authentication.
9. `src/workspace-theme.css` is screen-only. Do not change saved canvas appearance or print output when changing app chrome.

## Commands

```bash
npm install
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run dev
npm run test:ui
python -m unittest tests.test_api tests.test_startup -v
npm run benchmark:bundle
```

On Windows, use `.venv\Scripts\python.exe` in place of `.venv/bin/python`. The optional loopback voice runtime is set up with `npm run voice:setup` and started separately with `npm run voice:start`.

## Testing conventions

- API tests use temporary database paths and executable HTTP behavior.
- Browser modules use Node's test runner.
- Do not test source text or implementation tokens as a proxy for behavior.
- Run the production bundle budget after changing frontend imports, CSS, or dependencies.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
