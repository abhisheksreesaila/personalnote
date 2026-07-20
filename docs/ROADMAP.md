# Personal Note Roadmap

## Product Principle

Capture must remain immediate. Intelligence should feel present through timely, source-grounded context, not through a permanent chat surface. Local deterministic work runs first; bounded model reasoning is optional and replaceable.

## Phase 0: Product Foundation - Complete

- Spatial Fabric canvas with text, ink, erasing, printing, and responsive pages.
- Notebook and note organization with fast lexical search.
- Local SQLite persistence behind stable JSON APIs.
- Distinct mobile and desktop interaction language.
- Baseline Git checkpoint: `0268953`.

## Phase 1: Portable Backend - Complete

- Replace Express and `better-sqlite3` with FastHTML and standard Python SQLite.
- Deterministic `create_app()` factory and isolated schema/service ownership.
- Pin `fh-saas` for future authentication, tenant isolation, jobs, and billing.
- Preserve every existing frontend API contract.
- Add temporary-database API contract tests and production static serving.

## Phase 2: Ambient Related Context - Complete Prototype

- Listen only after save plus a meaningful idle pause.
- Retrieve prior notes locally and exclude the active note.
- Require multiple grounded term overlaps before surfacing anything.
- Present one restrained source card with Open and Dismiss actions.
- Collapse the card into a quiet presence marker after 8.5 seconds.
- Run Mastra as a restricted optional worker with one model step and no dangerous tools.
- Fall back to deterministic local retrieval when no model is configured.

## Phase 3: Retrieval Quality

- Instrument retrieval, enrichment, request, presentation, cancellation, and interaction latency. **Complete.**
- Add SQLite FTS5 indexing rather than scanning every Fabric document. **Complete.**
- Add deterministic person mentions and a source-linked ambient person peek. **Prototype complete.**
- Add deterministic calendar drafts with an explicit, reversible export action. **Prototype complete.**
- Split immediate local context from cancellable, non-blocking Mastra enrichment. **Complete.**
- Validate the non-React AG-UI Mastra adapter in an isolated package. **Spike complete; production adoption deferred.**
- Add a compact local embedding model and hybrid lexical/semantic ranking.
- Store provenance spans so highlighted source text opens at the exact object.
- Learn attention thresholds from opens, dismissals, and ignored suggestions.
- Add evaluation fixtures for useful, irrelevant, contradictory, and silent outcomes.

## Phase 4: Self-Organization

- Extract people, dates, commitments, decisions, and topics into derived records.
- Introduce Inbox, Projects, Areas, Resources, and Archive as suggested states.
- Keep raw captures canonical; all cleanup and classification remains reversible.
- Add an activity ledger showing what the system linked, cleaned, or proposed.

## Drawing Intelligence Track

- Recognize single-stroke rough boxes, ellipses, and connectors locally. **Prototype complete.**
- Offer non-persistent Trace guides while preserving the original ink. **Prototype complete.**
- Offer undoable, softly hand-drawn Refine operations. **Prototype complete.**
- Recognize single-stroke arrows separately from plain connectors. **Prototype complete.**
- Group multi-stroke nodes and connectors into diagram proposals without flattening raw ink.
- Add optional local handwriting/OCR for labels, with source stroke coordinates and confidence.
- Add domain-aware technical diagram suggestions only after explicit opt-in and a settled stroke cluster.
- Explore child-friendly trace references with strict local processing, age-appropriate safety, and no automatic replacement.
- Keep task management and MCP task interoperability out of this track until their interaction model is designed.

## Attention And Cleanup Track

- Trigger contextual intelligence only from text edits and surface each exact result once per session. **Complete.**
- Add a right-side Page Scan satellite with per-text-object date parsing. **Complete.**
- Add undoable obstacle-aware Tidy text arrangement without moving ink or connectors. **Prototype complete.**
- Add preview-first diagram grouping that preserves connector topology.
- Explore deep cleanup for grammar and structure only as a reversible proposal with source comparison.

## Phase 5: Living Projects

- Assemble project views from notes, decisions, tasks, milestones, and captures.
- Prefer explicit milestone progress; otherwise use forming, active, blocked, and ready-to-close states.
- Surface stale commitments and conflicting decisions with source evidence.
- Add a compact mobile-first Now view rather than a generic card dashboard.

## Phase 6: Capture Network

- Browser extension for pages, selections, screenshots, images, and voice annotations.
- Local readability extraction, OCR, transcription, deduplication, and source retention.
- One-tap Inbox capture with optional project suggestion after save.

## Phase 7: Cloud Depth

- Route research and long-context synthesis to user-approved cloud models.
- Add subscription boundaries around expensive reasoning, web research, and multimodal processing.
- Expose safe notebook capabilities through MCP for Hermes and other community agents.
- Keep local capture, search, organization, and basic contextual listening available without a subscription.

## Security Track: Identity And Encryption

- Enable `fh-saas` Google OAuth only when every note and notebook query is tenant-scoped.
- Keep authentication bypassed for the current single-user development workflow.
- Treat SQLite as storage, not encryption; evaluate SQLCipher only for local at-rest protection.
- Design E2EE around client-held content keys, encrypted payloads and attachments, recovery, rotation, and device enrollment.
- Define separate consent boundaries for local inference and cloud inference because cloud models cannot process ciphertext directly.
- Decide which metadata and search indexes may remain plaintext, be deterministically encrypted, or stay device-local.

## Current Next Step

Evaluate drawing assistance with real pen input before expanding the shape vocabulary. Measure false-positive rate, Trace versus Refine selection, undo rate, and whether the 650 ms ink-pause gate interrupts continued drawing. The next diagram implementation should be a multi-stroke grouping fixture set, not model-driven image generation.