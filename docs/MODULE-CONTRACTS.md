# Internal Module Contracts

These boundaries keep the v1 notebook core small and testable. They are implementation contracts for built-in features, not a third-party plugin API. No runtime discovery, marketplace, remote loading, or independent module permissions are provided.

## Core note contract

`NoteService` owns notebooks, notes, revisions, canonical document JSON, page state, and FTS5 indexing.

A note has one immutable type:

- `canvas`: JSON Canvas 1.0 with `pn` extensions (ADR 0002) and page state; a row not yet converted from the old Fabric JSON is read with `fromFabric`
- `mindmap`: normalized map JSON

All built-in editors use the same `POST /api/notes`, `GET /api/notes/{id}`, and `PUT /api/notes/{id}` lifecycle. Optional modules never open SQLite directly.

## Browser API contract

`src/core/api.js` provides:

- `api(path, options)` for JSON API requests and normalized error handling
- `downloadWorkspaceFile(path, fallbackName)` for user-initiated file downloads

The shell owns when calls occur. A module receives callbacks rather than importing shell state.

## Local CLI contract

`personal_note_cli.py` (run as `bin/personal-note`) is the local agent and automation boundary, not a remote endpoint. It calls `NoteService`, `note_text.py` and `portability.py` directly through their established public methods, emits JSON on stdout by default (`--text` on `notes read` and `search` prints readable text), and uses stable exit codes (`0` success, `2` expected input/resource errors). It never accesses SQLite outside `NoteService`, bypasses revision checks, or grants any plugin additional authority.

Agent-facing commands: `search`, `notes read` (canvas text in reading order, mind maps as an outline), `notes create --text`, and `notes append` (adds a text block below existing content, growing pages; `--revision N` fails on a stale note). Each accepts `--agent NAME` (default `Claude Code`) and records the agent's latest activity (`reading` or `writing`, note, timestamp) through `NoteService.record_agent_activity`; activity expires after `AGENT_ACTIVITY_WINDOW` seconds. Append refuses mind-map notes and never rewrites existing objects.

## Agent sync contract

`GET /api/changes?since=<sequence>` returns the workspace sequence, the change rows after `since` (`resourceKind`, `resourceId`, `revision`, `changeType`), an `overflow` flag, and the currently active agents. Omit `since` for a baseline. `src/modules/sync/` polls it every two seconds while the page is visible, refreshes lists, reloads the open note when it has no unsaved edits, and otherwise merges only objects the agent added (by `semanticId`) into the user's canvas so local edits are never discarded. The shell supplies canvas operations through callbacks; the module never imports shell state.

## Mind-map contract

`src/modules/mindmap.js` exports:

```js
mountMindMapModule(host, {
  documentValue,
  inspectorRoot,
  controlsRoot,
  createIcons,
  onChange,
}) -> Promise<editor>
```

The returned editor supports `getDocument()`, `setTitle(title)`, and `destroy()`. The wrapper dynamically imports `src/mindmap/editor.js`; opening and editing ordinary canvas notes does not load the mind-map implementation.

## Voice contract

The shell owns the active canvas text object. `src/modules/voice/transcript-session.js` combines stable and partial transcript text without storing media. `src/modules/voice/capture.js` is loaded only when local desktop capture is requested and exports:

- `MicrophonePcmCapture.start(onAudio)` / `stop()`
- `LocalTranscriptionProvider.connect(callbacks)`, `sendAudio(frame)`, `finish()`, `cancel()`, and `disconnect()`

The capture callback carries ephemeral PCM frames directly to the provider. No storage interface exists. The provider emits transient partial text and final text; only final text follows the normal canvas save path.

## Plugin package contract

`plugin_manifest.py` validates a versioned package manifest before any future installation or execution path. A manifest declares its identifier, name, version, host API version, and only supported capability names. Validation does not load code. There is no plugin runtime yet: packages cannot access the filesystem, SQLite, keys, network, or host UI.

## Portability contract

`NoteService.workspace_snapshot()` returns canonical data without SQLite row IDs. `NoteService.import_workspace_snapshot(snapshot)` validates and merges copies transactionally. `portability.py` owns file-format details:

- `personal-note-workspace` version 1 JSON is the lossless backup format.
- `personal-note-markdown` version 1 ZIP is a readable, lossy projection.

New format versions must remain explicitly versioned. Import must reject an unknown version before any write and must not replace existing data unless a future, separately approved restore mode is designed.
