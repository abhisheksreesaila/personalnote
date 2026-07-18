# Personal Note

A local-first note canvas that behaves like a page until your content reaches an edge. The canvas adds pages in any direction as text or ink moves outward and removes unused outer pages as content moves back in.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173` for the landing page. Its prototype actions enter the notepad directly at `http://localhost:5173/notes`; authentication is intentionally deferred. The Vite client proxies `/api` to the Express server on port `3137`.

## Current capabilities

- Double-click anywhere to type directly on the canvas
- Select, move, resize, edit, recolor, and erase objects
- Pen and translucent highlighter drawing
- Smooth partial stroke erasing, tap-to-dot ink, and legacy path compatibility
- Sticky single-click text placement with `D`/`P`, `E`, `T`, `H`, `V`, and `Escape` quick switches
- Caret-first text entry with no persisted placeholder objects
- Automatic page expansion and shrinking with edge hysteresis
- Unobstructed live object dragging and page growth on all four canvas edges
- Undo and redo for canvas changes
- Multiple notes with title editing and autosave
- Two-pane, color-coded notebook and note navigation with drag-to-move organization
- Notebook creation, renaming, recoloring, and deletion with safe note reassignment
- Spotlight-style search across note titles and canvas text, with keyboard navigation
- Compact icon rail with an overlay notebook drawer and note-local properties inspector
- Fixed menu rail with circular, touch-friendly action islands
- Desktop rail magnification with neighbor wave, labels, keyboard focus, and reduced-motion fallback
- Transparent canvas chrome with satellite-launched Spotlight search
- Selection-aware typography controls for font family and size
- Responsive Fabric canvas scaling and compact mobile writing dock
- Capsule writing dock with mirrored circular Search and Voice controls
- Anchored standalone magnification for Search, Voice, and note Properties
- Collision-free horizontal tool magnification with opaque lifted controls
- Color-coded rail actions and a global settings placeholder drawer
- Click-to-dictate voice input with a listening edge around the canvas
- Print review with one physical sheet per logical canvas page
- Sharp per-page Fabric exports, boundary clipping, Letter/A4 output, and `Ctrl+P`
- SQLite persistence in `data/personal-note.db`
- Responsive notes drawer and compact mobile tool dock
- Notebook typography using Source Serif 4 and IBM Plex Sans
- Shared soft-flat design language: circular actions, Gmail-style half-pill navigation, and unified typography

## Architecture

The browser stores Fabric.js canvas JSON through a small REST interface in `server.js`. Keeping persistence behind `/api/notes` makes the SQLite service replaceable with FH.SAS routes later without coupling server concerns to the canvas interaction model.

`@chenglou/pretext` is installed as the future variable-width text layout engine. The reference implementation in `spatial-docs.html` demonstrates `prepareWithSegments()` and `layoutNextLine()` to flow prose around diagram nodes. The production notepad remains Fabric-based for direct manipulation; Pretext should be introduced as a dedicated spatial text object rather than replacing Fabric's canvas runtime wholesale.

Create a production bundle with `npm run build`; `npm start` serves the API and an existing `dist` build.