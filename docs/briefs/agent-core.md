# Agent core: the notebook every agent shares

Status: draft
<!-- Drafted by Claude while the captain was away. Assumptions are marked (assumed).
     Nothing gets built until the captain changes the line above to approved. -->

## Why (the mission)
- Why this exists, in one sentence: your agents (Claude Code, Cursor, Codex, Chrome agents) forget everything between sessions and scatter their output; Personal Note becomes the one readable memory they all share, and nothing changes in it without your yes.
- Why now, and why you: agents became daily tools in 2026, and every vendor keeps memory hidden in its own silo. You already run many agents across 10–15 projects. (assumed)
- If it disappeared tomorrow, who would miss it and what would they do instead? Someone running several agents would go back to re-explaining context every session and hunting outputs across chats, CLAUDE.md files and scratch notes.

## Who it's for
- The one person it's for first, in one line: a solo builder running several coding and research agents a day (the captain is user one). (assumed)
- The moment they reach for it (their trigger): starting an agent session ("what did we decide?"), and ending one ("where do I keep what it found?").
- What they use today, and what's wrong with it: CLAUDE.md files, memory folders, chat history, Obsidian. Per-tool, invisible to other agents, and with no consent step before an agent changes them.

## What it does
- The core job, as one verb phrase: give every agent one shared, readable memory that they propose changes to.
- What v1 does (3 things at most):
  1. **Proposals.** Agents propose changes (add, edit, move, delete) instead of writing directly; you accept, edit or dismiss, in a margin list and as ghosts on the canvas; accepted changes undo cleanly.
  2. **One door for every agent.** A local-only MCP server next to the existing CLI, with an identity per client and a permission table (read / propose / write) per notebook area, and an audit log of everything agents did.
  3. **Session cards.** Agent sessions post a short card to their project's page when they end (what was done, decisions, open questions), starting with Claude Code hooks.
- What it deliberately does not do (out of scope): no scheduled or overnight agents yet; no sync between devices; no shared rooms; no local language model yet (that is the next brief: Ask the notebook); no vault (separate brief, required before any unattended agent).

## How it should look and feel
- Three words for how it should feel: calm, legible, in control. (assumed)
- Apps or sites it should feel like: GitHub's pull-request review (clear diffs, one click to accept); Apple Notes (quiet); the Futures "Agent margin" board.
- House style or explore: the existing Personal Note skins (Crayon, Paper, Night), not Terminal Ledger.
- The one screen that matters most: a note with an agent's proposals waiting: ghosts in place on the canvas, a margin list with Accept / Edit first / Dismiss, and who proposed it.

## How we'll know it worked
- The behaviour or number that says it's working: the captain's agents write to Personal Note every working day, and he accepts most proposals without edits (assumed target: 3+ agent sessions logged a day, over 70% accepted unedited after two weeks).
- What "done" means for v1: Claude Code (via MCP or CLI) can read a project page, propose a change, and post a session card; the captain sees and decides them in the app; the audit log shows it; nothing an agent did is unrecoverable.

## Constraints and risks
- Local only: the MCP server listens on this machine; no cloud service.
- Performance: proposals and ghosts must not slow typing, drawing or pan (speed test gates it).
- Data: agents never bypass `NoteService`; permissions are enforced there, not in the UI.
- Riskiest assumption: that agents will use a proposal path willingly instead of their own memory files. Cheapest test: wire one Claude Code hook (session card) plus an MCP read tool, use it for a week, count sessions logged.

## Decisions and trade-offs
- Proposals by default, direct writes only by permission. Pro: consent, trust. Con: one more step for the user; mitigated by Accept all and later trust rules.
- MCP and CLI both, one service behind them. Pro: every agent can connect. Con: two surfaces to keep in step.
- Notebook areas (PARA) as the permission scope. Pro: matches the Futures boards and filing. Con: needs Inbox/PARA made first-class first.

## Open questions
- Should existing direct CLI writes (`append`) keep working without a proposal, or become proposals by default?
- PARA areas: map existing notebooks onto Projects/Areas/Resources/Archive automatically, or ask once?
- Which agents first after Claude Code: Cursor, Codex, Claude Desktop?
