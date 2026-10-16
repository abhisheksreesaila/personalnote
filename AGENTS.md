# Agent Guide — Personal Note v1

Personal Note is a local, desktop-first spatial notebook. The required product path is canvas editing, SQLite persistence, local FTS5 search, and user-controlled export. Voice transcripts and mind maps are optional built-in modules.

Design language: web=Personal Note skins (Crayon, Paper, Night in `src/skins.css`), phone=Liquid.

## Read first

- `docs/PRODUCT-BRIEF.md` — v1 scope and product decisions
- `docs/ARCHITECTURE.md` — runtime, data flow, and file map
- `docs/MODULE-CONTRACTS.md` — narrow internal module boundaries
- `docs/ROADMAP.md` — completed slice and deferred work

## Core boundaries

- `src/main.js` owns the browser shell and hosts the Leafer canvas (view, input, save, note lifecycle). `src/modules/canvas-leafer/` is the engine adapter and the only code that imports `leafer-ui`.
- `src/core/api.js` is the browser API boundary.
- `routes.py` owns core HTTP routes.
- `services.py::NoteService` is the only owner of canonical SQLite reads and writes.
- `portability.py` projects storage into backup and readable export formats.
- `src/modules/mindmap.js` lazy-loads `src/mindmap/` only when a mind-map note opens.
- `search_runtime.py` owns the optional search-by-meaning download and its loopback embedding engine; it never blocks startup or saves (F-079 indexes, F-080 searches).
- `src/modules/voice/` owns voice transcript and capture adapters. It must never persist audio.

These are internal contracts, not a public plugin SDK.

## Invariants

1. Capture must not wait on an optional service.
2. JSON Canvas 1.0 plus the namespaced `pn` extensions (`json_canvas.py`, `src/core/document/jsoncanvas.js`) is canonical for `canvas`; normalized map JSON is canonical for `mindmap`; for `page` the Markdown is canonical and its ink rides beside it in the same `{version, markdown, ink}` document (ADR 0003), never inside the Markdown. The editor reads and writes that document model directly (`src/core/note-codec.js`); there is no second engine format. Fabric JSON is a legacy input only: `fromFabric` (`src/core/document/legacy-fabric.js`, mirrored by `document_model.py`) reads notes the old engine saved, and a version 1 backup. A note's `content_format` says which one a row holds; old `fabric` rows convert once at startup.
3. A note's `noteType` is immutable after creation.
4. Voice may persist final editable transcript text only. Do not add IndexedDB, SQLite, filesystem, backup, or export storage for PCM/audio.
5. Local transcription failure must be visible and must leave the note intact.
6. Backup JSON is lossless and versioned (version 3 adds Inbox notes, which have no notebook, so an older build refuses it rather than misfiling them; version 2 carries JSON Canvas with pictures inline; versions 1 and 2 still import). Import, including an Obsidian vault import, is validated, transactional, and merge-only; it never deletes or overwrites existing notes.
7. Markdown export (the reading-order projection) is explicitly lossy and never fetches remote assets. Pictures and ink/shape SVGs are content-addressed files `media/<sha256>.<ext>` beside the database, never inside a note row.
8. Local agents (Claude Code and similar) are first-class clients through `bin/personal-note` (`personal_note_cli.py`), which goes through `NoteService` with revision checks. There is one optional local embedding worker, for search by meaning (`search_runtime.py`: the llama.cpp server and EmbeddingGemma 2, downloaded on request, started on first use, loopback only, nothing sent off the machine). There is still no generative model worker, automatic suggestions, chat, sync, authentication, or remote agent endpoint; agents act only when they run the CLI.
9. `src/workspace-theme.css` is screen-only. Do not change saved canvas appearance or print output when changing app chrome.

## Commands

```bash
npm install
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run dev
npm run test:ui
python -m unittest tests.test_api tests.test_startup tests.test_cli tests.test_agent_access tests.test_app_paths tests.test_document_model tests.test_json_canvas tests.test_note_format tests.test_migration tests.test_desktop tests.test_desktop_menu tests.test_speedtest_report tests.test_page_notes tests.test_markdown_text tests.test_webview_smoke tests.test_secure_platform tests.test_secure_notes tests.test_inbox tests.test_search_runtime -v
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
