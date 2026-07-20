# Personal Note

A local-first note canvas that behaves like a page until your content reaches an edge. The canvas adds pages in any direction as text or ink moves outward and removes unused outer pages as content moves back in.

## Run locally

```bash
npm install
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
npm run dev
```

Open `http://localhost:5173` for the landing page. Its prototype actions enter the notepad directly at `http://localhost:5173/notes`; authentication is intentionally deferred. The Vite client proxies `/api` to the FastHTML server on port `3137`.

`npm run dev` starts Vite, FastHTML, and the intelligence worker together. `python main.py` starts only the standalone FastHTML server and built frontend at `http://127.0.0.1:3137/notes`. If that standalone server is already running, repeating the command prints its URL and exits successfully.

## Current capabilities

- Double-click anywhere to type directly on the canvas
- Select, move, resize, edit, recolor, and erase objects
- Pen and translucent highlighter drawing
- Compact 12-color palette with independent Pen and Highlighter width controls
- Tool-attached options: hold Text, Pen, or Highlighter, or tap the active tool, to configure it directly
- Smooth partial stroke erasing, tap-to-dot ink, and legacy path compatibility
- Sticky single-click text placement with `D`/`P`, `E`, `T`, `H`, `V`, and `Escape` quick switches
- Text-first note creation with an immediate focused caret and unobstructed writing surface
- Caret-first text entry with no persisted placeholder objects
- Automatic page expansion and shrinking with edge hysteresis
- Unobstructed live object dragging and page growth on all four canvas edges
- Unified liquid page growth/shrink timing with leading-edge viewport compensation
- Undo and redo for canvas changes
- Confirmed Clear all action that preserves the note and supports immediate undo
- Multiple notes with title editing and autosave
- Two-pane, color-coded notebook and note navigation with drag-to-move organization
- Notebook creation, renaming, recoloring, and deletion with safe note reassignment
- Spotlight-style search across note titles and canvas text, with keyboard navigation
- Compact icon rail with an overlay notebook drawer and note-local properties inspector
- Fixed menu rail with circular, touch-friendly action islands
- Independent rail hover/focus lift with labels and reduced-motion fallback
- Transparent canvas chrome with a top-center expanding Spotlight search pill
- Selection-aware typography controls for font family and size
- Responsive Fabric canvas scaling and compact mobile writing dock
- Capsule writing dock with left Voice and right Scan satellites
- Anchored standalone magnification for Voice, Scan, and note Properties
- Collision-free horizontal tool magnification with opaque lifted controls
- Color-coded rail actions and a global settings placeholder drawer
- Click-to-dictate voice input with a listening edge around the canvas
- Print review with one physical sheet per logical canvas page
- Sharp per-page Fabric exports, boundary clipping, Letter/A4 output, and `Ctrl+P`
- SQLite persistence in `data/personal-note.db`
- Responsive notes drawer and compact mobile tool dock
- Notebook typography using Source Serif 4 and IBM Plex Sans
- Shared soft-flat design language: circular actions, Gmail-style half-pill navigation, and unified typography
- Ambient related-note listening after a meaningful writing pause
- FTS5-backed note search and related-context retrieval
- Fast local person recognition with source-linked person peeks
- Natural-language calendar drafts with explicit `.ics` export
- One-shot contextual suggestions plus an explicit local Page Scan
- Undoable Tidy text layout cleanup
- Opt-in rough box, circle, connector, and arrow assistance with Trace and undoable Refine actions
- Source-grounded related-note cards that disappear after their moment
- Local deterministic retrieval with optional Mastra reranking through any OpenAI-compatible model

## Architecture

The browser stores Fabric.js canvas JSON through a FastHTML REST interface. `main.py` is the runtime entrypoint, `routes.py` owns the application factory and API registration, `services.py` owns note persistence rules, and `app_schema.py` owns idempotent SQLite setup. `fh-saas` is pinned as the production SaaS toolkit for later authentication, tenant isolation, jobs, and billing without coupling those concerns to the canvas interaction model.

Ambient intelligence is split deliberately. FastHTML returns immediate source-grounded retrieval locally, then the browser may request non-blocking enrichment from a restricted Mastra worker on port `4112`. Mastra may rerank and phrase a connection with one bounded model step; it has no shell, filesystem, browser, or mutation tools. Without a configured model, the same feature remains available in deterministic `local-retrieval` mode.

The runtime stack is intentionally modular: FastHTML owns HTTP delivery, `fh-saas` supplies the future authentication/session/tenant primitives, SQLite owns local persistence, app JavaScript owns interaction state, Fabric.js owns the spatial canvas, and Mastra sits behind a narrow optional intelligence boundary. Mastra was selected as a lightweight TypeScript agent runtime for this boundary; the product does not depend on Mastra-specific types outside the worker, so another runtime can replace it.

The settings drawer stores default typography locally and reads safe runtime capability metadata from `/api/settings/capabilities`. Provider keys remain server-side environment values and are never returned to browser code. `fh-saas` includes Google OAuth, session, and tenant provisioning primitives, but authentication is deliberately bypassed in the current single-user development build; setting Google credentials alone does not activate access control.

Drawing guides are local, deterministic, and off by default. Fabric pen strokes retain their original points. After a short ink pause, a recognized rough box, ellipse, connector, or arrow can produce a temporary non-exported Trace guide or an undoable Refine operation. Neither path invokes Mastra, and the raw sketch remains canonical unless the user explicitly refines it.

Contextual intelligence is text-event-scoped and one-shot. Calendar, person, and related-note cards may appear once after the relevant edit, then disappear rather than becoming recurring reminders. Drawing, erasing, moving, and formatting do not rerun text context. A floating right-edge Scan this page action always performs a fresh local summary of dates, known people, and grounded related notes. It parses each Fabric text object independently so diagram labels cannot corrupt a nearby calendar phrase.

Tidy text reserves the padded bounds of every ink and diagram object, then arranges loose text into available space around those obstacles. It never moves or deletes drawing paths, and the complete layout operation remains undoable.

The root `.env` is loaded by both FastHTML and the Mastra worker and is ignored by Git. Start from `.env.example`:

```powershell
Copy-Item .env.example .env
```

For keyless retrieval, leave `PERSONAL_NOTE_MODEL` empty. To invoke a local OpenAI-compatible model such as Ollama or LM Studio, set:

```text
PERSONAL_NOTE_MODEL=qwen3:4b
PERSONAL_NOTE_MODEL_URL=http://127.0.0.1:11434/v1
PERSONAL_NOTE_MODEL_KEY=local
```

For a cloud OpenAI-compatible provider, use its model name, `/v1` base URL, and API key instead. Never put secrets in `.env.example` or commit `.env`. Restart `npm run dev` after changing `.env`, then check `http://127.0.0.1:4112/health`: `local-retrieval` means no model is configured, while `mastra-model` means Mastra will invoke the configured endpoint.

Azure OpenAI and Microsoft Foundry deployments use the official Azure provider. Set `PERSONAL_NOTE_DEPLOYMENT_NAME` to the deployment name, `PERSONAL_NOTE_MODEL_URL` to either its Azure OpenAI endpoint or the Foundry project endpoint, and `PERSONAL_NOTE_MODEL_KEY` to the resource key. Leave `PERSONAL_NOTE_MODEL` empty. The worker derives the Azure resource from a Foundry project endpoint and sends the key using Azure's `api-key` header. Optional legacy deployments can set `PERSONAL_NOTE_AZURE_DEPLOYMENT_URLS=1` and a specific `PERSONAL_NOTE_AZURE_API_VERSION`.

The product roadmap is maintained in `docs/ROADMAP.md`.
The current Mastra boundaries and proposed capability modules are documented in `docs/INTELLIGENCE-ARCHITECTURE.md`.

An isolated non-React AG-UI compatibility spike lives in `experiments/ag-ui`. It is intentionally excluded from the production dependency graph and request path; see its README for the compatibility result and adoption criteria.

End-to-end encryption is not implemented. SQLite is a persistence engine, not an E2EE boundary. Before sync or multi-user hosting, the design must define client-held keys, encrypted note payloads and attachments, key recovery and rotation, encrypted search/index tradeoffs, and what plaintext may be disclosed to local or cloud intelligence providers.

`@chenglou/pretext` is installed as the future variable-width text layout engine. The reference implementation in `spatial-docs.html` demonstrates `prepareWithSegments()` and `layoutNextLine()` to flow prose around diagram nodes. The production notepad remains Fabric-based for direct manipulation; Pretext should be introduced as a dedicated spatial text object rather than replacing Fabric's canvas runtime wholesale.

Create a production bundle with `npm run build`; `npm start` serves the FastHTML API and an existing `dist` build.