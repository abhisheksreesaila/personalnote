# 0003: Page notes store Markdown plus an ink sidecar

Status: proposed (2026-10-11), with the two-layer pages brief

## Context
Milestone 1 adds a writing-first page note: flowing Markdown with ink on top. Agents, search and export all want clean Markdown; ink must follow words through edits made in the app and by agents through the CLI.

## Decision
- New immutable note type `page`. `notes.content` holds the Markdown; a JSON sidecar (new column or `pn` extension, decided in the plan) holds marks, drawings, text objects, links and fold state.
- Each mark anchors to a text position plus a quote of its word with context (W3C text-quote style) and an offset. App edits map positions through CodeMirror change sets; when positions can't be mapped (agent rewrite), anchors are re-found by quote, otherwise kept as loose ink.
- The Markdown never contains ink markers.

## Consequences
- FTS, CLI `read` and Markdown export use the page's Markdown directly.
- Agent writes go through `NoteService` with revision checks as today; the server re-anchors the sidecar after a Markdown write so ink is never orphaned silently.
- Backup format gains the page type and its sidecar (version bump).
