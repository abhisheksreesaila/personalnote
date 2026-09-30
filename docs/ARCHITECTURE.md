# Personal Note v1 Architecture

Personal Note v1 is a local, single-user notebook with one required runtime path and two optional built-in editor/capture modules. The core does not load or call a reasoning worker.

## Runtime

```mermaid
flowchart LR
    Shell[Browser notebook shell] --> Canvas[Fabric canvas editor]
    Shell -. on mind-map open .-> Map[Lazy SVG mind-map module]
    Shell -. on voice start .-> Voice[Lazy voice capture module]
    Voice -->|ephemeral PCM over loopback| ASR[Local transcription :8080]
    ASR -->|partial and final text| Shell
    Canvas --> API[FastHTML API :3137]
    Map --> API
    API --> Store[NoteService]
    Store --> DB[(SQLite + FTS5)]
    API --> Export[Portability projection]
```

Development uses two core processes and one local command interface:

| Surface | Port | Responsibility |
|---|---:|---|
| Vite | 5173 | Browser shell, canvas, and lazy built-in modules |
| FastHTML | 3137 | REST API, SQLite persistence, search, backup/import/export |
| `personal_note_cli.py` (`bin/personal-note`) | — | Local agent and scripting interface: search, read as text, create, append, import/export, diagnostics, all through `NoteService` |

The desktop app (`desktop.py`) replaces both with one process: uvicorn serves the built `dist/` and the API on a free loopback port in a background thread, and a pywebview window loads it. On close it calls the page's `window.personalNote.flush()` (resolves once nothing is unsaved; bounded to 3 seconds), then destroys the window and stops the server. A per-database `*.desktop.json` record (with a random nonce) and a loopback `POST /_desktop/focus` that requires that nonce give single-instance behaviour. The web view keeps a persistent context so `localStorage` exists; the frontend also tolerates its absence. `app_paths.py` (standard library only) picks the database: `PERSONAL_NOTE_DB`, else an existing legacy `data/personal-note.db` (until `personal-note migrate-data` has copied it to app-data), else the app-data folder. `migration.py` implements the explicit copy.

The optional Windows transcription service listens on loopback port `8080` and starts separately. The notebook is fully usable when it is absent.

## Core boundaries

### Browser shell

The Fabric canvas is always window-sized: pan and zoom move `viewportTransform` (geometry in `src/modules/editor/viewport.js`), page tiles are painted in `before:render`, and page growth only changes the page count. `npm run benchmark:canvas` measures drag, grow, pan and zoom frame times on a generated 600-object note.

Pending edits are flushed when the page is hidden or closed (`src/modules/editor/save-flush.js`): a keepalive request survives unload but is capped at 64 KiB, so a note over about 60 KiB is saved on close best-effort with a normal request that the browser may cancel. If a save is already in flight at that moment, the close-time save is sent at once with the last confirmed revision (never a guessed one); if the in-flight save lands first the server rejects it with a conflict rather than overwrite anything, so edits made after that save can be lost.

The chrome floats over that canvas (F-004): a glass sidebar (Quick note, Inbox, notebooks grouped by PARA category with their notes), a top bar (breadcrumb, title, save state, agent chip, search, share/export), a bottom dock (tools, ink swatches, undo, mic), a page minimap and a zoom control. Pure helpers keep the logic testable: `src/modules/library/outline.js` (sidebar grouping), `src/modules/editor/navigation.js` (page label, zoom steps, fit, minimap, scroll thumbs), `keyboard-pan.js`, `edge-ghost.js` (the "+ Page N" preview) and `lift.js` (a dragged object's tilt and shadow). The ghost page and the lift are painted only while dragging and are never saved objects. The chrome is screen-only and lives in `src/chrome.css`.

Objects and the desk (F-012): a note opens zoomed out so every page is on the desk (`openingView` in `navigation.js`; phones keep the full-width first page), with "Page N" under each page and dashed fold lines between pages, all painted by the canvas and never saved. The dock's Sticky note, Shape and Image tools create ordinary canvas objects: a sticky is a `Sticky` Textbox subclass (`sticky-object.js`, registered with Fabric so it loads, prints and exports like text; `stickyColor` is saved), a shape is a rounded `Rect`, and an image is a Fabric image stored as a data URL (shrunk to 1400 px on its longest side; picker or drop). `objects.js` holds the pure rules (palette from the skin's `--sk-c1..c5`, defaults, image sizing). Crayon's screen paper is white; Paper and Night keep their ivory, and print is unchanged.

`src/main.js` owns shared note lifecycle and canvas interaction. It talks to the backend only through `src/core/api.js`. The shell knows that notes have a `noteType`, but optional modules do not own notebook navigation, persistence, or search.

### Persistence

`routes.py` defines the local HTTP surface. `services.py::NoteService` is the only owner of canonical note and notebook reads/writes. `app_schema.py` performs idempotent schema creation and migration. All endpoints work without voice or mind-map code running in the browser.

A note type is immutable after creation:

- `canvas` stores Fabric JSON plus `{columns, rows}` page state.
- `mindmap` stores normalized map JSON in the same `notes.content` column.

Every write increments an integer revision. A caller that supplies a stale revision receives HTTP 409. FTS5 indexing is updated in the same transaction as note content, using Fabric text or mind-map node labels.

### Optional built-in mind map

`src/modules/mindmap.js` is the shell-facing boundary. Its only job is to lazy-import the SVG editor and return the established editor lifecycle (`getDocument`, `setTitle`, `destroy`). The module receives a host element and an `onChange` callback. It uses the normal note API and introduces no separate database or library.

The editor chunk is fetched only when a mind-map note opens. Canvas notes created before this boundary continue to load unchanged.

### Optional built-in voice capture

`src/modules/voice/` contains three responsibilities:

- `transcript-session.js` separates unstable partial text from committed transcript text.
- `microphone-pcm-capture.js` emits in-memory mono 16 kHz PCM frames.
- `local-transcription-provider.js` exchanges those frames for transcript events over a loopback WebSocket.

`capture.js` is dynamically imported only when desktop voice starts. There is deliberately no audio repository. PCM frames are not written to IndexedDB, SQLite, the filesystem, backups, or exports. Final transcript text is inserted through the same Fabric history/save path as typed text. Browser speech may be offered as a clearly labeled fallback; if neither provider is available, the UI explains how to start the local service.

### Portability

`portability.py` depends on the storage service's snapshot/import methods:

- `GET /api/export/workspace` returns the versioned, lossless JSON contract.
- `POST /api/import/workspace` validates the entire payload, then merges copied notebooks and notes in one transaction.
- `GET /api/export/markdown` returns a readable ZIP projection with a manifest and extracted embedded image assets.

Import never deletes or overwrites existing notes. New local resource IDs are assigned, and conflicting canvas object IDs are regenerated. This gives users a safe restore path without inventing sync or conflict-resolution semantics.

## Data model

```mermaid
erDiagram
    notebooks ||--o{ notes : contains
    notes ||--o| note_search : indexes

    notebooks {
        int id PK
        string resource_id UK
        int revision
        string name
        string color
        datetime updated_at
    }
    notes {
        int id PK
        string resource_id UK
        int revision
        int notebook_id FK
        string note_type
        string title
        text content
        text page_state
        datetime updated_at
    }
    note_search {
        int note_id
        string title
        string body
    }
```

`resource_id` is stable inside a workspace and keeps exports independent from local row IDs. Import intentionally creates copies with new resource IDs. Existing installations may retain unused legacy tables; v1 neither reads nor populates them, avoiding destructive database migrations.

## API surface

| Method | Path | Responsibility |
|---|---|---|
| `GET` | `/health` | Core process health |
| `GET` | `/api/settings/capabilities` | Storage, portability, and built-in module facts |
| `GET/POST` | `/api/notebooks` | List/create notebooks |
| `PUT/DELETE` | `/api/notebooks/{id}` | Update/delete notebook; note reassignment is transactional |
| `GET/POST` | `/api/notes` | List/create notes |
| `GET/PUT/DELETE` | `/api/notes/{id}` | Canonical note lifecycle |
| `PATCH` | `/api/notes/{id}/notebook` | Move a note |
| `GET` | `/api/search?q=` | FTS5 note search |
| `GET` | `/api/export/workspace` | Canonical JSON backup |
| `POST` | `/api/import/workspace` | Non-destructive merge import |
| `GET` | `/api/export/markdown` | Markdown-plus-assets ZIP |
| `GET` | `/api/changes?since=` | Cheap change feed plus active agent presence, polled by the open app |

There are no v1 model, suggestion, or remote workspace endpoints. Agents reach the notebook through the local CLI, which writes through `NoteService` to the same SQLite file; the browser notices those writes through `/api/changes`.

## Performance shape

The default canvas route statically loads Fabric and the shell. Voice capture and mind-map implementation code are separate dynamic chunks. `npm run benchmark:bundle` enforces aggregate JavaScript gzip, aggregate CSS gzip, and largest JavaScript chunk budgets. The screen theme is isolated in `src/workspace-theme.css` under `@media screen`, so print output continues to use the established print rules.

## Security and deployment boundaries

- The API binds to `127.0.0.1` by default.
- SQLite is local storage, not encryption.
- V1 has no authentication, tenancy, sync, or remote API contract. Local agent access is the CLI on the same machine, with the same file permissions as the database.
- No secret or provider credential is sent to the browser.
- Imported backup content is treated as data and validated for format, note type, references, and size before insertion.
- Markdown conversion never fetches remote image URLs; only bounded embedded data images are extracted.

## File map

| File | Role |
|---|---|
| `src/main.js` | Notebook shell and Fabric canvas |
| `src/core/api.js` | Browser API boundary |
| `src/modules/mindmap.js` | Lazy mind-map boundary |
| `src/mindmap/` | Built-in mind-map implementation |
| `src/modules/voice/` | Transcript, capture, and local provider modules |
| `routes.py` | Core HTTP routes |
| `desktop.py` | Native-window entry point: in-process server, single instance, close-time flush |
| `app_paths.py` | Default database location shared by the app, CLI and server |
| `scripts/build-mac-app.sh`, `packaging/` | macOS app bundle build and Linux launcher |
| `personal_note_cli.py`, `bin/personal-note` | Machine-readable local CLI for agents, using the same service and portability contracts |
| `note_text.py` | Plain-text projections of notes for agents (reading-order canvas text, mind-map outline) |
| `src/modules/sync/` | Change-feed polling, safe merge of agent writes, and the agent presence chip |
| `services.py` | SQLite persistence and FTS5 indexing |
| `portability.py` | Backup/import and Markdown archive projection |
| `app_schema.py` | Idempotent database setup |
| `src/workspace-theme.css` | Screen-only chrome defaults mapped onto the skin tokens |
| `src/chrome.css` | Screen-only floating chrome layout: sidebar, top bar, dock, minimap, zoom |
