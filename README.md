# Personal Note

Personal Note is a fast, local notebook for technical and creative project work. It combines a spatial writing and drawing canvas, optional mind-map notes, editable voice transcripts, SQLite storage, search, and practical workspace exports.

The v1 core does not include model providers, automatic suggestions, agent access, cloud sync, authentication, or a chat surface. Capture and retrieval remain deterministic and local.

## Run locally

Requirements: Node.js, Python 3.11+, and a browser.

```bash
npm install
python -m venv .venv
# Linux/macOS
.venv/bin/python -m pip install -r requirements.txt
# Windows PowerShell: .venv\Scripts\python.exe -m pip install -r requirements.txt
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the FastHTML API on `http://127.0.0.1:3137`.

The core development command starts two processes only:

- Vite for the browser application
- FastHTML for the local API and SQLite store

For a production build:

```bash
npm run build
python main.py
```

## V1 capabilities

- Spatial Fabric.js canvas for editable text, pen, highlighter, eraser, selection, undo, and redo
- Automatic page growth and shrink around canvas content
- Notebooks, note titles, drag-to-move organization, and SQLite FTS5 search
- Optional built-in mind-map note type with SVG editing and JSON/PNG export
- Optional built-in voice capture that inserts final transcript text into a canvas note
- Print preview with one physical sheet per logical canvas page
- Whole-workspace JSON backup and non-destructive import
- Readable Markdown-plus-assets ZIP export
- Omarchy-inspired, screen-only workspace chrome; saved canvas content and printed output are unchanged

## Internal module boundaries

The shell is intentionally not a public plugin SDK. It uses a few narrow internal boundaries so optional features do not own the notebook lifecycle:

- `src/core/api.js` is the browser-to-core API client.
- `services.py` owns canonical notebook/note persistence and FTS indexing.
- `src/modules/mindmap.js` lazy-loads the built-in mind-map editor only when a mind-map note opens.
- `src/modules/voice/` owns transcript assembly and the lazily loaded local microphone/transcription adapters.
- `portability.py` projects canonical storage into backup and readable export formats.

See [`docs/MODULE-CONTRACTS.md`](docs/MODULE-CONTRACTS.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Voice capture and privacy

Desktop voice capture streams short-lived mono PCM frames directly from the browser to the loopback transcription service at `ws://127.0.0.1:8080/v1/realtime`. Personal Note does **not** write audio or PCM to IndexedDB, SQLite, files, backups, or exports. Partial text is transient. Final transcript text is inserted as an ordinary editable canvas object and is then saved normally.

On Windows, install and start the pinned local Nemotron runtime:

```powershell
npm run voice:setup
npm run voice:start
```

If the loopback service is unavailable, the interface says so. When the browser offers `SpeechRecognition`, Personal Note explicitly labels that fallback as browser voice; provider and network behavior then follow the browser's own privacy policy. If neither path is available, capture stops and the note remains unchanged.

Mobile browser dictation uses the operating-system keyboard through the text entry dialog. Desktop remains the v1 release target.

## Backup, export, and restore

Open **Settings → Workspace data**:

- **Download backup** saves `personal-note-backup-YYYY-MM-DD.json`. This is the lossless, versioned format for editable canvas JSON, mind-map JSON, page state, titles, and notebook membership.
- **Markdown + assets** saves a ZIP with readable Markdown files, a manifest, and embedded PNG/JPEG/WebP/GIF images extracted into `assets/`. Spatial positions, ink geometry, and styling are intentionally not represented in Markdown.
- **Import backup** validates a v1 backup and merges copied notebooks and notes in one SQLite transaction. Existing data is never overwritten or deleted. Imported canvas object IDs are regenerated if they conflict with existing objects, so search and editing remain safe.

For disaster recovery, keep the JSON backup. The Markdown ZIP is for reading and interchange, not lossless restoration. Directly copying `data/personal-note.db` is safe only while the API process is stopped; use the in-app backup while it is running.

## Data and API

The default database is `data/personal-note.db`; set `PERSONAL_NOTE_DB` to override it. Core endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Runtime health |
| `GET` | `/api/notebooks` | List notebooks |
| `POST` | `/api/notebooks` | Create a notebook |
| `GET` | `/api/notes` | List note summaries |
| `GET` | `/api/notes/{id}` | Read one canonical note |
| `POST` | `/api/notes` | Create a typed note |
| `PUT` | `/api/notes/{id}` | Revision-checked save |
| `GET` | `/api/search?q=...` | Local FTS5 search |
| `GET` | `/api/export/workspace` | Download canonical JSON backup |
| `POST` | `/api/import/workspace` | Merge a canonical JSON backup |
| `GET` | `/api/export/markdown` | Download Markdown and assets ZIP |

Canvas and mind-map notes share the same notebook and API lifecycle. `noteType` is immutable after creation, preventing one editor from interpreting another editor's data.

## Validation

```bash
npm run test:ui
python -m unittest tests.test_api tests.test_startup -v
npm run benchmark:bundle
```

The bundle benchmark enforces gzip and largest-chunk budgets. Mind-map and desktop voice implementations are split into on-demand chunks so the ordinary canvas path stays small.

## Current scope

V1 is a local, single-user desktop product. It deliberately excludes sync, accounts, multi-tenancy, cloud inference, remote workspace access, automatic note rewriting, and a general plugin marketplace. Future optional integrations must remain outside the capture and persistence path.
