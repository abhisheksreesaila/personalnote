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

## Install from a release

Releases are built by GitHub Actions when a `v*` tag is pushed (`.github/workflows/release.yml`); Windows is not supported. A release also carries the voice engines (`personal-note-voice-engine-linux-x86_64.tar.gz`, `personal-note-voice-engine-macos-arm64.tar.gz`, each with a `.sha256`); the app downloads the right one itself when you press **Download voice** in Settings, so you never need them by hand (see Voice capture and privacy).

**macOS (Apple Silicon)**

1. Download `personal-note-macos-arm64.zip` from the Releases page and unzip it.
2. Move **Personal Note** to Applications.
3. The app is not notarized (only ad-hoc signed), so macOS blocks the first launch.
   - macOS 14 and earlier: right-click the app, choose **Open**, then **Open** again.
   - macOS 15 and later: right-click › Open no longer works for such apps. Double-click the app once, then open **System Settings › Privacy & Security**, scroll to the message about "Personal Note" and click **Open Anyway**.
   - Or remove the quarantine flag in Terminal: `xattr -dr com.apple.quarantine "/Applications/Personal Note.app"`.

Your notes are kept in `~/Library/Application Support/Personal Note`. Not yet verified on a Mac.

**Linux (x86_64)**

1. Install Chromium or Google Chrome (the app opens in a Chromium app window; without one it shows an error and exits).
2. Download `personal-note-linux-x86_64.tar.gz`, then `tar -xzf personal-note-linux-x86_64.tar.gz && cd personal-note-linux-x86_64`.
3. Run `./install.sh`. It copies the app to `~/.local/opt/personal-note` and adds "Personal Note" to your application menu (`personal-note-app.desktop`, separate from the checkout launcher `personal-note.desktop`). `./uninstall.sh` removes both; each only touches a folder it installed itself.

The bundle is built on Ubuntu 22.04, so it needs glibc 2.35 or newer: Ubuntu 22.04+, Debian 12+, Fedora 36+, Arch and similar. It needs no repo, npm or Python.

Your notes are kept in `${XDG_DATA_HOME:-~/.local/share}/personal-note`; install and uninstall never touch them. A packaged app never reads a checkout's `data/` folder, so to bring existing notes from a source checkout into the app, run `bin/personal-note migrate-data` in that checkout first. The `bin/personal-note` command-line tool for local agents stays a checkout tool for now (it is not in either package); point it at the same notes with `--database` if you use both.

Build the packages yourself with `npm run desktop:mac-app` (on a Mac) or `npm run desktop:linux-bundle` (on Linux); the output goes to `dist-app/`. `python desktop.py --serve [--port N]` runs the server with no window.

## Desktop app

Personal Note runs in its own app window around the same local server, no browser tab: a Chromium app window on Linux when Chromium or Chrome is installed (it feels fastest there), a pywebview window otherwise and on macOS and Windows.

```bash
npm install && npm run build            # once; the app rebuilds a stale frontend itself
python -m venv .venv
.venv/bin/python -m pip install -r requirements-desktop.txt
npm run desktop                         # or: .venv/bin/python desktop.py
```

- It serves the built frontend on loopback port 3138 (another free port only if that one is taken, so the page's origin, and with it saved preferences and the microphone permission, stays the same between launches), opens a window titled "Personal Note", and stops the server when the window closes (in the pywebview window pending edits are saved first, waiting up to 3 seconds; the Chromium window works differently, see Engine). Opening it a second time brings the existing window forward instead of starting another server.
- Engine: `--engine auto` (default) uses Chromium on Linux when `chromium`, `chromium-browser`, `google-chrome-stable` or `google-chrome` is on the PATH (the real `/usr/lib/chromium/chromium` is started directly, with `--disable-extensions`, so your browser flags do not apply), else pywebview; `--engine chromium` or `--engine webview` forces one. The Chromium window uses its own profile in the app-data folder (`chromium-profile`), separate from your everyday browser. If port 3138 is taken the app uses another port and warns on the command line (and in the pywebview window), because preferences and the microphone permission then start fresh. A second launch brings the open window forward by process id (`hyprctl dispatch focuswindow pid:<pid>` on Hyprland; elsewhere it only reports that the app is open) and never starts a second server or window. If a window is open but its server is gone, it refuses with a message instead of starting another server. The speed meter reads "Desktop app" in this window.
- Saving on close in the Chromium window: unlike pywebview, Chromium gives the app no chance to flush before closing. In this window (the page is opened with `engine=chromium`) a note small enough for a keepalive request saves about 250 ms after your last edit (instead of about 830 ms); a bigger note keeps the normal delays, because its close-time save could not be sent anyway and frequent large autosaves cost frames. The page still sends a keepalive save when the page goes away, and the server stays up for 0.4 to 1.5 seconds after the window closes so that save lands. Remaining limit: a note over about 60 KiB (large notes, notes with pictures) cannot use the keepalive request, so edits made in the last fraction of a second before closing may be lost. The window class is set to `PersonalNote` (and `StartupWMClass` in the launcher entry matches), but that is best effort and not verified on Hyprland.
- `python desktop.py --timing` prints cold-start timings; `--no-build` skips the stale-build check. Measured on Linux (Wayland, WebKitGTK, hidden window, build in place, three runs): server ready 0.15s; canvas drawn and notes listed 0.90-1.03s after process start.
- Linux needs a system web view: `webkit2gtk-4.1` and `python-gobject` (Arch/Omarchy: `sudo pacman -S webkit2gtk-4.1 python-gobject`; Debian/Ubuntu: `gir1.2-webkit2-4.1 python3-gi`). The virtualenv must see them: create it with `python -m venv --system-site-packages .venv`. `npm run desktop` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`, which Wayland sessions need.
- Launcher entry on Linux: `sh scripts/install-linux-launcher.sh` adds "Personal Note" to the application menu (re-run it after updating so the window class matches).
- Mac window (not yet verified on a Mac): the page runs under a transparent title bar (the traffic lights sit over the sidebar, or beside the top bar when the sidebar is closed), the empty top strip drags the window and double-click zooms it, and a native menu bar (File, Edit, View, Window, Help, Settings under the app menu) calls the page through `window.personalNote.command(name)`; see `desktop_menu.py`. The Linux window and browser tabs are unchanged.
- macOS app: on a Mac, `npm run desktop:mac-app` builds `dist-app/Personal Note.app` and a zip of it with PyInstaller (microphone usage text included). Not yet verified on a Mac.
- Microphone: the Chromium window asks once per origin (the fixed port keeps the origin stable, so it is not asked again on each launch); the Linux pywebview window grants audio (never video) itself. On macOS the web view shows the system prompt (pywebview 6.2.1 has no media-permission hook, so WebKit's default prompt is what appears; not yet verified on a Mac). If access is refused the app says so and the note stays untouched. Voice itself is a separate one-click download, see Voice capture and privacy.

### Where the notebook lives

The app, `bin/personal-note` and `python main.py` share one database:

| OS | Default location |
|---|---|
| macOS | `~/Library/Application Support/Personal Note/personal-note.db` |
| Linux | `$XDG_DATA_HOME/personal-note/personal-note.db` (default `~/.local/share/personal-note/`) |
| Windows | `%APPDATA%\Personal Note\personal-note.db` |

`PERSONAL_NOTE_DB` overrides it. **An existing `data/personal-note.db` in a checkout always wins** until you migrate on purpose, so another install (the macOS app, a second checkout) creating an empty app-data database can never hide your notes. To move your notes to the app-data folder, close the app and run, in the checkout that has the data:

```bash
bin/personal-note migrate-data
```

It copies the database (SQLite backup; if the app-data database already has notes, the old notes are merged in without overwriting anything), then writes `data/personal-note.db.migrated` so this checkout switches to the app-data copy. Running it again reports "already migrated" and does nothing (`--force-merge` merges again). It refuses while the desktop app is open or a server answers on `HOST:PORT` (default 3137), because that server would keep writing to the old file; `--yes` overrides the server check. It never deletes or moves the original; remove it yourself once you have checked the notes. The macOS app shows a one-line notice when its notebook is empty, pointing here.

## V1 capabilities

- Spatial Fabric.js canvas for editable text, pen, highlighter, eraser, selection, undo, and redo
- Automatic page growth and shrink around canvas content
- Notebooks, note titles, drag-to-move organization, and SQLite FTS5 search
- Optional built-in mind-map note type with SVG editing and JSON/PNG export
- Optional built-in voice capture that inserts final transcript text into a canvas note
- Print preview with one physical sheet per logical canvas page
- Notes are stored as [JSON Canvas](https://jsoncanvas.org) (the open format Obsidian uses) with a small `pn` extension for exact geometry; pictures and ink/shape SVGs are files in a `media/` folder next to the database
- Whole-workspace JSON backup and non-destructive import
- Readable Markdown-plus-assets ZIP export
- Obsidian vault export and import (`.canvas` files and attachments): Share menu › Obsidian vault, or `bin/personal-note export vault --output DIR` and `bin/personal-note import-vault DIR-or-ZIP`. When an older database is first opened, it is converted once and the old file is kept beside it as `personal-note.db.fabric-backup`
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

Voice dictation runs on your computer with NVIDIA's Nemotron speech model. It is optional and downloaded once, from inside the app:

1. Open **Settings › Voice** and press **Download voice (≈750 MB)**. The app fetches the speech engine for your system from the matching GitHub release (Linux x86_64 CPU, which needs a processor with AVX2, roughly 2013 or newer; macOS 13 or newer on Apple Silicon, with Metal; on a processor the engine cannot run on, Settings says so) and the model from Hugging Face, resumes an interrupted download, checks the engine against the checksum published next to it on the release (a corruption check, not a signature) and the model against a SHA-256 pinned in the app, and unpacks them into the app-data folder (`voice/`, next to the notebook: `~/.local/share/personal-note/voice` on Linux, `~/Library/Application Support/Personal Note/voice` on macOS). No terminal needed. **Remove voice** deletes all of it; your notes are never touched.
2. From then on the app starts the engine with its window and stops it when the window closes (loopback only, `127.0.0.1`, port 8080 when free and another free port when not; it is restarted once if it crashes; its log is `voice/logs/engine.log`). Hold the mic button to dictate, or tap it to keep listening.
3. When voice is not ready the mic button says why (not installed, still downloading, setup failed) and opens Settings › Voice.

Running from a checkout (`npm start`, `npm run desktop`) works the same: the server starts the engine on demand. Windows keeps the older route below.

Audio is streamed as short-lived mono PCM frames from the page to that loopback engine. Personal Note does **not** write audio or PCM to IndexedDB, SQLite, files, backups, or exports. Partial text is transient. Final transcript text is inserted as an ordinary editable canvas object and is then saved normally.

Environment overrides, for mirrors and testing: `PERSONAL_NOTE_VOICE_ENGINE_URL` (folder holding `personal-note-voice-engine-<os>-<arch>.tar.gz` and its `.sha256`), `PERSONAL_NOTE_VOICE_MODEL_URL`, `PERSONAL_NOTE_VOICE_DIR`; a `voice/settings.json` with `{"engineBaseUrl": "https://..."}` does the same for the engine (https only; the environment variables are for tests and mirrors). The engine files are built by `scripts/build-voice-engine.sh` (see the Release workflow); an app that finds no engine on its own release falls back to the latest release.

On Windows, install and start the pinned local Nemotron runtime by hand:

```powershell
npm run voice:setup
npm run voice:start
```

If no local engine is available the interface says so. In an ordinary browser tab, when the browser offers `SpeechRecognition`, Personal Note explicitly labels that fallback as browser voice; provider and network behavior then follow the browser's own privacy policy (the app windows never use it). If neither path is available, capture stops and the note remains unchanged.

On screens at or below 560px, the white paper canvas is the only capture surface. Hold **Hold to speak** to stream and finalize into selected canvas text (or a new text object); **Draw** explicitly enables the pen. Desktop remains the v1 release target.

## Backup, export, and restore

Open **Settings → Workspace data**:

- **Download backup** saves `personal-note-backup-YYYY-MM-DD.json`. This is the lossless, versioned format for editable canvas JSON, mind-map JSON, page state, titles, and notebook membership.
- **Markdown + assets** saves a ZIP with readable Markdown files, a manifest, and embedded PNG/JPEG/WebP/GIF images extracted into `assets/`. Spatial positions, ink geometry, and styling are intentionally not represented in Markdown.
- **Import backup** validates a v1 backup and merges copied notebooks and notes in one SQLite transaction. Existing data is never overwritten or deleted. Imported canvas object IDs are regenerated if they conflict with existing objects, so search and editing remain safe.

For disaster recovery, keep the JSON backup. The Markdown ZIP is for reading and interchange, not lossless restoration. Directly copying `data/personal-note.db` is safe only while the API process is stopped; use the in-app backup while it is running.

## Data and API

The default database is in your app-data folder (see Desktop app), or an existing legacy `data/personal-note.db`; set `PERSONAL_NOTE_DB` to override it. Core endpoints:

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

`npm run personal-note -- <command>` and `npm link` (which installs a `personal-note` command from `package.json`) work too. Pass `--database /path/to/personal-note.db` (or set `PERSONAL_NOTE_DB`) to target a specific workspace; the default is the same database the app uses (see Desktop app, Where the notebook lives); `bin/personal-note migrate-data` moves a checkout's data into the app-data folder.

### Using it from Claude Code

Tell Claude Code the command, for example in your project's `CLAUDE.md`: "Search and edit my notes with `/path/to/personalnotev2/bin/personal-note` (run `--help` for commands; always read a note before appending)." Agent commands take `--agent NAME` (default `Claude Code`). While one runs, the open app shows a chip such as "Claude Code is reading" or "Claude Code is writing" for a few seconds, and appended text appears in the open note within about two seconds without a reload. If you have unsaved edits when an agent writes, your edits are kept and the agent's new text is added beside them. Appends go below the existing content and grow the page when needed; mind maps are readable but not writable by the CLI.

There is no remote access, plugin execution, or model call in the app; an agent acts only when it runs the CLI on your machine.

## Validation

```bash
npm run test:ui
python -m unittest tests.test_api tests.test_cli tests.test_agent_access tests.test_startup -v
npm run benchmark:bundle
npm run benchmark:canvas   # first run: npx playwright install chromium
```

The bundle benchmark enforces gzip and largest-chunk budgets. Mind-map and desktop voice implementations are split into on-demand chunks so the ordinary canvas path stays small. The canvas benchmark drives the real app in headless Chromium (run `npx playwright install chromium` once) and fails if the dpr 1 p95 frame time exceeds 25ms or if objects move on screen when pages are added or removed.

## Current scope

V1 is a local, single-user desktop product. It deliberately excludes sync, accounts, multi-tenancy, cloud inference, remote workspace access, automatic note rewriting, and a general plugin marketplace. Future optional integrations must remain outside the capture and persistence path.
