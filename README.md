# Personal Note

Personal Note is a fast, local notebook for technical and creative project work. It combines a spatial writing and drawing canvas, optional mind-map notes, editable voice transcripts, SQLite storage, search, and practical workspace exports.

The v1 core does not include model providers, automatic suggestions, cloud sync, authentication, or a chat surface. Local agents such as Claude Code can search, read and write notes through the `personal-note` CLI (see below). Capture and retrieval remain deterministic and local.

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
- Screen-only dark neutral/violet workspace chrome; saved canvas content and printed output are unchanged

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

On screens at or below 560px, the white paper canvas is the only capture surface. Hold **Hold to speak** to stream and finalize into selected canvas text (or a new text object); **Draw** explicitly enables the pen. Desktop remains the v1 release target.

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

## Local CLI

`personal_note_cli.py` is a machine-readable local interface over the same `NoteService` and portability contracts as the web API. It emits JSON to stdout by default, returns `0` for success, `2` for expected user/input errors, and never bypasses revision or backup-import validation. `bin/personal-note` runs it with any Python 3 (standard library only, no virtualenv), so an agent needs only the checkout path.

```bash
bin/personal-note search "searchable capture"                 # JSON matches; add --text for readable lines
bin/personal-note notes read 12 --text                        # plain text: canvas in reading order, mind maps as an outline
bin/personal-note notes create --title "Idea" --text "A local searchable capture"
bin/personal-note notes append 12 --text "One more thought"   # or pipe: echo "..." | bin/personal-note notes append 12
bin/personal-note notes append 12 --text "..." --revision 5   # fail instead of writing over a newer note
bin/personal-note status
bin/personal-note export workspace --output backup.json
bin/personal-note import backup.json
bin/personal-note plugins inspect plugin-manifest.json
```

`npm run personal-note -- <command>` and `npm link` (which installs a `personal-note` command from `package.json`) work too. Pass `--database /path/to/personal-note.db` (or set `PERSONAL_NOTE_DB`) to target a specific workspace; the default is the same `data/personal-note.db` the app uses.

### Using it from Claude Code

Tell Claude Code the command, for example in your project's `CLAUDE.md`: "Search and edit my notes with `/path/to/personalnotev2/bin/personal-note` (run `--help` for commands; always read a note before appending)." Agent commands take `--agent NAME` (default `Claude Code`). While one runs, the open app shows a chip such as "Claude Code is reading" or "Claude Code is writing" for a few seconds, and appended text appears in the open note within about two seconds without a reload. If you have unsaved edits when an agent writes, your edits are kept and the agent's new text is added beside them. Appends go below the existing content and grow the page when needed; mind maps are readable but not writable by the CLI.

There is no remote access, plugin execution, or model call in the app; an agent acts only when it runs the CLI on your machine.

## Validation

```bash
npm run test:ui
python -m unittest tests.test_api tests.test_cli tests.test_agent_access tests.test_startup -v
npm run benchmark:bundle
npm run benchmark:canvas
```

The bundle benchmark enforces gzip and largest-chunk budgets. Mind-map and desktop voice implementations are split into on-demand chunks so the ordinary canvas path stays small.

## Current scope

V1 is a local, single-user desktop product. It deliberately excludes sync, accounts, multi-tenancy, cloud inference, remote workspace access, automatic note rewriting, and a general plugin marketplace. Future optional integrations must remain outside the capture and persistence path.
