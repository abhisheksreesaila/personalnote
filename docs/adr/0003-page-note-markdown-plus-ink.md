# 0003: Page notes store Markdown plus an ink sidecar

Status: accepted (2026-10-11), with the two-layer pages brief

## Context
Milestone 1 adds a writing-first page note: flowing Markdown with ink on top. Agents, search and export all want clean Markdown; ink must follow words through edits made in the app and by agents through the CLI.

## Decision
- New immutable note type `page`, `content_format = 'page'`. `notes.content` holds one JSON document `{version, markdown, ink}`: the Markdown plus the ink layer (marks, drawings, text objects, links, fold state) beside it, so one revision covers both.
- Each mark anchors to a text position plus a quote of its word with context (W3C text-quote style) and an offset. App edits map positions through CodeMirror change sets; when positions can't be mapped (agent rewrite), anchors are re-found by quote, otherwise kept as loose ink.
- The Markdown never contains ink markers.

## Consequences
- FTS, CLI `read` and Markdown export use the page's Markdown directly.
- Agent writes go through `NoteService` with revision checks as today; the server re-anchors the sidecar after a Markdown write so ink is never orphaned silently.
- Backups carry the page document as is; no version bump was needed: an older build refuses a backup with an unknown note type instead of misreading it.
