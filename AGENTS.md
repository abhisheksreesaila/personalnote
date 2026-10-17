# Agent Guide — Personal Note v1

Personal Note is a local, desktop-first spatial notebook. The required product path is canvas editing, SQLite persistence, local FTS5 search, and user-controlled export. Voice transcripts and mind maps are optional built-in modules.

Design language: web=Personal Note skins (Crayon, Paper, Night in `src/skins.css`), phone=Liquid.

## Read first

- `docs/PRODUCT-BRIEF.md` — v1 scope and product decisions
- `docs/ARCHITECTURE.md` — runtime, data flow, and file map
- `docs/MODULE-CONTRACTS.md` — narrow internal module boundaries
- `docs/ROADMAP.md` — completed slice and deferred work

## Core boundaries

- `src/main.js` owns the browser shell and hosts the Leafer canvas (view, input, save, note lifecycle). The engine is a separate chunk (F-098): the shell holds `leaferCanvas` as `lazyCanvas` (`canvas-leafer/lazy.js`) and draws the notes panel and title before the engine arrives; keep `leafer-ui` and `scene.js` out of what main.js imports statically (the first-load budget fails if they come back). `src/modules/canvas-leafer/` is the engine adapter and the only code that imports `leafer-ui`.
- `src/core/api.js` is the browser API boundary.
- `routes.py` owns core HTTP routes.
- `services.py::NoteService` is the only owner of canonical SQLite reads and writes.
- `portability.py` projects storage into backup and readable export formats.
- Optional features are built-in plugins (ADR 0006): `src/core/plugins.js` is the registry the shell asks, `src/modules/plugins/builtin.js` lists them, `plugin_settings.py` keeps the per-machine on/off. Off = hidden, not loaded, data kept.
- Voice (`src/modules/voice/voice-plugin.js`) and Search by meaning (`src/modules/search/meaning-plugin.js`) are plugins too (F-091): the host imports them only while on (`plugins.sync`), `dispose()` takes their UI away, and the server follows the switch (`routes.py::follow_plugin`: indexer thread, engines, 409 on install/start while off).
- `src/modules/mindmap.js` lazy-loads `src/mindmap/` only when a mind-map note opens and the Mind maps plugin is on.
- `search_runtime.py` owns the optional search-by-meaning download and its loopback embedding engine; it never blocks startup or saves (F-080 searches). `meaning_index.py` is the background thread that fills `note_embeddings` (derived, never in backup or export; owned by `NoteService`).
- Jam sessions (`src/modules/jam/`, plugin `jam`, needs Mind maps + Voice) put a live line and Jam on the island for a map made by New jam; `src/mindmap/jam.js` applies a turn's edits (ghosts, thumbs, emoji are map data, ghosts are never saved); the mic reaches it through `shell.voiceSink`.
- Settings is a window of its own (F-102, monochrome: `docs/design/polish.md` 3): `#properties-panel` holds the settings sections the shell, AI, X, plugins and voice/search plugins draw, and `src/modules/settings/` (lazy, with the settings chunk; its CSS is inlined into the chunk by `?inline`, so it counts under the JS budgets, not the first load) moves them into pages (nine sections, search box, phone drill-in list), draws switches and the skin cards over the same elements and ids. A plugin that draws a section appends it to `[data-sw-page="voice"|"meaning"]`; keep the window frame CSS (chrome.css) tiny. The open note's properties (notebook, type, storage, Make secure, Delete) are `#note-popover`, opened from the island card's Properties button. Checked by `scripts/verify-settings-window.mjs`.
- `ai_settings.py` + `src/modules/ai/` own Settings → AI: the model choice every AI feature shares (`AISettings.brain()`); choices in `ai-settings.json` in the app-data folder, the API key only in `SecretStore` (never SQLite, backup, export, logs or the page).
- A note's emoji icon (F-100): `note_icon.py` holds the guess from the title, the type defaults and the tint rule, and `NoteService` sends every note with its icon resolved (`icon: {emoji, tint, chosen}`), so the browser guesses nothing. The picker (`src/modules/library/note-icon-picker.js`) and the notebook picker carry their own CSS as strings and load on first use: the first load has no room for either (`npm run benchmark:bundle`).
- `src/modules/voice/` owns voice transcript and capture adapters. It must never persist audio.

These are internal contracts, not a public plugin SDK.

## Invariants

1. Capture must not wait on an optional service.
2. JSON Canvas 1.0 plus the namespaced `pn` extensions (`json_canvas.py`, `src/core/document/jsoncanvas.js`) is canonical for `canvas`; normalized map JSON is canonical for `mindmap`; for `page` the Markdown is canonical and its ink rides beside it in the same `{version, markdown, ink}` document (ADR 0003), never inside the Markdown. The editor reads and writes that document model directly (`src/core/note-codec.js`); there is no second engine format. Fabric JSON is a legacy input only: `fromFabric` (`src/core/document/legacy-fabric.js`, mirrored by `document_model.py`) reads notes the old engine saved, and a version 1 backup. A note's `content_format` says which one a row holds; old `fabric` rows convert once at startup.
3. A note's `noteType` is immutable after creation.
4. Voice may persist final editable transcript text only. Do not add IndexedDB, SQLite, filesystem, backup, or export storage for PCM/audio.
5. Local transcription failure must be visible and must leave the note intact.
6. Backup JSON is lossless and versioned (version 3 adds Inbox notes, which have no notebook, so an older build refuses it rather than misfiling them; version 2 carries JSON Canvas with pictures inline; versions 1 and 2 still import). Import, including an Obsidian vault import, is validated, transactional, and merge-only; it never deletes or overwrites existing notes (links between the notes of one backup are repointed at the imported copies).
7. Markdown export (the reading-order projection) is explicitly lossy and never fetches remote assets. Pictures and ink/shape SVGs are content-addressed files `media/<sha256>.<ext>` beside the database, never inside a note row.
8. Local agents (Claude Code and similar) are first-class clients through `bin/personal-note` (`personal_note_cli.py`), which goes through `NoteService` with revision checks. There is one optional local embedding worker, for search by meaning (`search_runtime.py`: the llama.cpp server and EmbeddingGemma 2, downloaded on request, started on first use, loopback only, nothing sent off the machine). There is one opt-in generative brain, Jam sessions (ADR 0007: `jam_brain.py`, `POST /api/jam/turn`): off until the person turns the plugin on, called only when they press Jam on an open jam map (or say "jam"), one turn at a time, sending only that map and the words said since the last turn to the model chosen in Settings → AI (their own Claude Code on this machine, or an OpenAI-compatible endpoint, key in the keychain); it can only add and react, never remove, rename or move a branch. There is still no automatic suggestion, chat, sync, authentication, or remote agent endpoint; agents act only when they run the CLI. Plugins are built in and written by us; none installs or runs outside code, and a plugin gains no authority by being one (ADR 0006). One optional exception to "no sync": the X bookmarks sync (`x_sync.py`, `x_bookmarks.py`) runs only after "Connect X" in Settings, talks only to x.com and api.x.com, is read-only (bookmarks in, nothing posted), and never blocks capture.
9. `src/workspace-theme.css` is screen-only. Do not change saved canvas appearance or print output when changing app chrome.

## Commands

```bash
npm install
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run dev
npm run test:ui
python -m unittest tests.test_api tests.test_startup tests.test_cli tests.test_agent_access tests.test_agent_edit tests.test_app_paths tests.test_document_model tests.test_json_canvas tests.test_note_format tests.test_migration tests.test_desktop tests.test_desktop_menu tests.test_speedtest_report tests.test_page_notes tests.test_markdown_text tests.test_webview_smoke tests.test_secure_platform tests.test_secure_notes tests.test_inbox tests.test_search_runtime tests.test_secret_store tests.test_x_bookmarks tests.test_download_tls tests.test_meaning_index tests.test_meaning_search tests.test_meaning_rank tests.test_plugin_settings tests.test_plugin_voice_meaning tests.test_jam_brain tests.test_jam_route tests.test_ai_settings tests.test_note_links tests.test_note_icon -v
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
