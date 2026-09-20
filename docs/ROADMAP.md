# Personal Note Roadmap

## Product principle

Personal Note is a fast local notebook for technical and creative project thinkers. Capture, persistence, search, and export must remain useful without an account, network connection, or optional module.

Desktop core ships first. Small-screen responsiveness protects access to existing notes, but native mobile product work waits until the desktop release is stable.

## V1 delivery slice — implemented

### Core notebook

- Spatial Fabric canvas with text, pen, highlighter, erasing, selection, undo/redo, printing, and responsive page growth.
- Notebook and note organization with immutable `canvas` and `mindmap` note types.
- Fast SQLite persistence with revision-checked updates.
- Local FTS5 search across canvas text and mind-map labels.
- Core FastHTML runtime with no model worker or automatic suggestion path.

### Internal boundaries

- Browser API calls isolated in `src/core/api.js`.
- Optional mind-map editor loaded through `src/modules/mindmap.js` only when needed.
- Voice transcript, microphone, and loopback provider responsibilities isolated under `src/modules/voice/`; capture/provider code loads on first use.
- Backup and readable export projection isolated in `portability.py` while `NoteService` remains the canonical storage owner.
- These are internal built-in module contracts, not a public plugin system.

### Voice capture

- Editable final transcript text uses the ordinary canvas history and save path.
- PCM is streamed transiently and is never stored by Personal Note.
- Partial transcript text is never persisted.
- Missing local transcription is reported visibly; browser speech is labeled when used as a fallback.
- Windows loopback setup and start scripts remain available.

### Portability

- Versioned whole-workspace JSON backup with canonical canvas and mind-map documents.
- Transactional merge import that never deletes or overwrites existing workspace data.
- Markdown ZIP with a manifest and extracted embedded image assets.
- Documentation distinguishes lossless backup from lossy readable export.

### Interface and performance

- Omarchy-inspired flat, dark app chrome with monospaced controls and restrained green accents.
- Screen-only theme override leaves canvas content and print output unchanged.
- Desktop and compact responsive shell remain functional.
- Production bundle budgets are measured by `npm run benchmark:bundle`.

## Release validation

- Automated API tests for note persistence, mind-map indexing, backup/import atomicity, export files, and capability metadata.
- Browser-module tests for mind maps and voice transcript/capture adapters.
- Production build and bundle-budget checks.
- Manual desktop pass for writing, drawing, navigation, voice unavailable state, export/import, and print output.

## After v1

Prioritize evidence from real use before expanding scope:

1. Improve canvas editing reliability and keyboard workflows.
2. Add an explicit replace-mode restore only if users need exact disaster recovery beyond safe merge import.
3. Add attachment types beyond embedded images only with clear ownership and export rules.
4. Evaluate a native mobile product after the desktop core ships.
5. Discuss optional integrations only as isolated additions that cannot delay capture or acquire storage authority.

## Explicitly not planned for v1

- General plugin marketplace
- Automatic suggestions or rewriting
- Model provider setup or cloud inference
- Chat or assistant surfaces
- Remote workspace access
- Audio recording retention or playback
- Sync, authentication, sharing, or multi-tenancy
