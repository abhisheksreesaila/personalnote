# Personal Note v1 Product Brief

Status: implementation reference for the desktop core.

## Product north star

Personal Note is a **fast local notebook for technical and creative project thinkers**. A note can be an adaptive canvas for writing and drawing or, when deliberately chosen, a mind map. The default path is immediate: open a note, place text or ink, and continue thinking without setup or background work.

V1 is a notebook product, not an assistant product. It ships no automatic suggestions, model configuration, chat surface, agent controls, cloud inference, sync, or authentication. Those concerns may be explored later as optional integrations only after the notebook core is stable.

## V1 outcomes

1. **Immediate spatial capture** — direct typing, pen, highlighter, erasing, object movement, and page growth remain responsive.
2. **Durable local storage** — canonical note documents live in SQLite and are searchable with local FTS5.
3. **Bounded voice capture** — voice creates editable transcript text. Personal Note retains no audio or PCM media.
4. **Optional mind maps** — a mind map is a built-in note type sharing the same notebooks, persistence, and search, loaded only when opened.
5. **Trustworthy portability** — users can download a lossless workspace backup, merge it back into a workspace, or export readable Markdown with embedded image assets.
6. **Focused desktop shell** — the Omarchy-inspired dark chrome is compact and opaque while the note paper, saved content, and print output remain unchanged.

## Product principles

- Capture must remain immediate and must not depend on an optional module.
- Fabric JSON is canonical for canvas notes; normalized map JSON is canonical for mind maps.
- SQLite is the source of truth for notes, notebooks, revisions, and the local search index.
- Optional modules communicate through narrow internal contracts and cannot redefine note persistence.
- Audio is ephemeral transport input. Only final transcript text may become durable product data.
- Unavailable local transcription is visible to the user; failure must not erase or corrupt a note.
- Exports state clearly which format is lossless and which is a readable projection.
- Existing data is never deleted during backup import.
- Desktop is the v1 target. Responsive behavior prevents breakage on small screens but is not a separate mobile product effort.

## Implemented surfaces

| Area | V1 behavior |
|---|---|
| Canvas | Fabric.js text and ink, selection, transforms, erasing, undo/redo, and multi-page growth |
| Mind maps | Optional native SVG editor with direct node editing, history, layout cleanup, image support, JSON export, and PNG export |
| Storage | FastHTML JSON API, SQLite canonical documents, immutable note types, revision checks |
| Search | FTS5 over note titles, canvas text, and mind-map node labels |
| Voice | Loopback local transcription plus labeled browser fallback; editable final transcript only |
| Portability | Versioned JSON workspace backup, transactional merge import, Markdown-plus-assets ZIP |
| Print | Canvas-to-paper preview and browser printing, unaffected by the screen theme |
| Theme | Flat green-black shell, monospaced controls, restrained focus states, responsive layout |

## Voice retention decision

The v1 retention rule is final and intentionally narrow:

- Microphone frames exist in browser memory only while being sent to the active transcription provider.
- Personal Note does not create an audio database, media file, playback record, or audio export.
- Partial transcripts are transient UI state.
- Final transcript text becomes an ordinary editable canvas text object.
- Stopping, cancelling, service failure, navigation, or reload leaves no app-owned recording behind.

This avoids an irreversible user-data retention policy in v1. If audio retention is ever proposed later, it requires a separate product decision, migration, deletion controls, and export semantics.

## Portability contract

The whole-workspace JSON backup is canonical and versioned. It includes notebook metadata, note types, titles, full editor documents, page state, and timestamps without exposing local SQLite row IDs. Import validates the complete file before opening a transaction and then **merges copies** into newly created notebooks. It never replaces the current workspace.

The Markdown ZIP is intentionally lossy. It orders canvas text spatially, renders mind-map hierarchy as nested lists, and extracts embedded data-image assets. It does not claim to preserve ink geometry, exact layout, typography, or editor history.

## Out of scope for v1

- General plugin marketplace or public plugin SDK
- Model provider setup or bundled reasoning features
- Automatic suggestions, classification, rewriting, or generated diagrams
- Persistent chat
- Remote workspace or agent access
- Audio recording retention or playback
- Sync, accounts, authentication, sharing, or multi-tenancy
- Native mobile product work

## Release evidence

Before release, the API contract tests, built-in module tests, production build, and bundle budgets must pass. Manual review must cover canvas editing, a mind-map round trip, voice-unavailable messaging, backup download/import, Markdown export, responsive shell behavior, and print output.
