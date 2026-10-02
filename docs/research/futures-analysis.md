# Futures canvas: does the foundation fit, or do we pivot?

Source: the "Personal Note — Futures" design canvas (28 boards: V1 rows 1–4, V2 Overnight shift / Notes as skills / Notebook hub / Pages that compute, V3 Staff room / Trust ladder / Years / Rooms, V4 Shell factory / Readable memory / Model drawer / Every device / Day 2027 / Gateway). Read 2026-10-02.

## Verdict

No pivot of the engine or the data foundation. The direction is "memory you can read, agents propose, local first, sealed vault, tiny core". The foundation built in F-024..F-036 is that spine. What the concepts need is new *layers* on the core (proposals, permissions, model lanes, retrieval, plugin contract), not a different canvas or a different store.

The "cards" in the concepts are mostly views and proposal UI, not a new document type: notes become cards when you zoom out (Main), citations become draggable cards (Ask), agent output becomes proposal cards (Margin, Overnight), apps become dock tiles (Shell). So cards belong in the view layer over the same notes.

One real gap: a text-first note. Many people will not draw. Add a **page** note kind (a flow of Markdown blocks: text, table, chart, app) beside **canvas** and **mindmap**, stored in the same SQLite store, with the same Markdown projection, search and agent access. A page is the most agent-native form (agents write Markdown well) and is where Live Pages and Notes-as-Skills live.

## What already exists (the spine)

| Concept needs | Have today |
|---|---|
| One store, no second copy ("there is no second store") | `NoteService` is the only writer; SQLite + FTS5 |
| Memory you can read | JSON Canvas (Obsidian) + Markdown projection; vault export/import |
| Agent-native | `bin/personal-note` CLI through `NoteService` with revision checks |
| Agents never clobber you, you never clobber them | three-way merge (`src/core/document/merge.js`); undo never reverts an agent's write (F-030) |
| Tiny core, plugins on demand | mind map lazy-loaded; bundle budget enforced (190 / 240 KiB) |
| Local by default | local Nemotron voice; pinned model download pattern |
| Fast with heavy content | Leafer engine, page bitmaps, incremental undo, speed test (F-034) |

## What the core must add, in dependency order

1. **Proposals (the Agent Margin).** The "single door every V2 feature walks through". Today agents write directly. Add a proposal object (author, target, diff, reason, state accept/edit/dismiss, undo) in `NoteService`; agents write proposals by default, direct writes become a permission. Everything later (overnight shift, room agent, chat answers, widgets) is a proposal.
2. **Inbox + PARA as the scope axis.** Notebooks exist; make Projects / Areas / Resources / Archive + Inbox + Vault first-class, because permissions, trust and filing are all scoped by them.
3. **Identity, permission table, audit log.** Per client (Claude Code, Chrome, Slack, scheduled agents, phone): read / propose / write per PARA area, enforced in `NoteService`, not the UI. Then expose the same service as a **local-only MCP server** beside the CLI.
4. **Sealed vault.** Encryption at rest and exclusion from search, CLI, MCP, models and backups, enforced at the store. Design it before widening agent access.
5. **Retrieval + model lanes.** Local embeddings next to FTS5 for "Ask the notebook" with citations. A model router by job kind: local (search, transcription, filing), Claude (agents, drafts, research), pluggable providers; a pre-send step that strips the vault and redacts marked names; an egress ledger. Ship a small local model (e.g. a ~2B Qwen in GGUF) using the same pinned-download pattern as the voice model.
6. **Plugin contract.** Formalize what the mind map already does: manifest (size, load trigger, permissions), lazy load, a read-only snapshot when the plugin is off, a per-plugin speed budget checked by the speed test.
7. **Page note kind + computing blocks.** Text-first pages; tables with formulas; charts; agent-written app blocks in a sandbox (iframe sandbox, readable/forkable source). This is the base for Notes-as-Skills and the Shell factory.
8. **Scheduler** for overnight agents (Claude scheduled tasks or a local scheduler calling the CLI/MCP), output always proposals.
9. **Sync (Mac as hub).** Hardest item; every device and Rooms idea rests on it. Keep last.

V3/V4 (staff, trust ladder, years, rooms, shell, devices) are built from 1–9 plus budgets and an action ledger; no new foundation.

## Performance rules for heavy features

- Nothing heavy loads until used: plugin code, app blocks, mind map, models.
- An app or widget block draws as a static bitmap until you interact with it; its code runs only when visible.
- Models never run on the UI thread or in the UI process; typing and capture never wait on a model (AGENTS.md invariant 1).
- Every plugin gets a speed-test scenario; a plugin that drops typing or pan below 60 fps on the stress note does not ship.

## Risks the boards themselves name

- Sync is the hardest item; rooms and devices depend on it.
- Agent output can bury your own notes (staff room); the Inbox and proposals must keep your writing first.
- Factory sprawl (half-dead apps); trust ladders can be gamed; undo does not exist for sent email or payments.
- A 2B local model is fine for filing, tagging and short summaries, weak for research: lanes must make the quality trade visible.
- Distribution: "a notebook that is also an assistant has to be found." Speed and readable memory are the wedge.

## Suggested order

1. Ship the Leafer release (v0.4.0) after the captain's Mac check.
2. Brief and build: proposals + Inbox/PARA + permissions/audit + local MCP (V1 spine).
3. Ask the notebook with a local model and citations; model lanes.
4. Page note kind; then Live Pages, Notes as Skills.
5. Vault encryption before any unattended agent.
6. Overnight shift; then sync.

Each starts with a brief (clarify skill) before design or code.
