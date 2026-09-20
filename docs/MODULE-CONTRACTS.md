# Internal Module Contracts

These boundaries keep the v1 notebook core small and testable. They are implementation contracts for built-in features, not a third-party plugin API. No runtime discovery, marketplace, remote loading, or independent module permissions are provided.

## Core note contract

`NoteService` owns notebooks, notes, revisions, canonical document JSON, page state, and FTS5 indexing.

A note has one immutable type:

- `canvas`: Fabric-compatible document JSON and page state
- `mindmap`: normalized map JSON

All built-in editors use the same `POST /api/notes`, `GET /api/notes/{id}`, and `PUT /api/notes/{id}` lifecycle. Optional modules never open SQLite directly.

## Browser API contract

`src/core/api.js` provides:

- `api(path, options)` for JSON API requests and normalized error handling
- `downloadWorkspaceFile(path, fallbackName)` for user-initiated file downloads

The shell owns when calls occur. A module receives callbacks rather than importing shell state.

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

## Portability contract

`NoteService.workspace_snapshot()` returns canonical data without SQLite row IDs. `NoteService.import_workspace_snapshot(snapshot)` validates and merges copies transactionally. `portability.py` owns file-format details:

- `personal-note-workspace` version 1 JSON is the lossless backup format.
- `personal-note-markdown` version 1 ZIP is a readable, lossy projection.

New format versions must remain explicitly versioned. Import must reject an unknown version before any write and must not replace existing data unless a future, separately approved restore mode is designed.
