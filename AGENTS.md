# Agent Guide — Personal Note v2

This file helps AI coding agents (Cursor, Copilot, etc.) work effectively in this repository. Read it before making changes.

## What This Project Is

Personal Note is a **local-first spatial notepad** with:

1. **Revolutionary canvas UI** — Fabric.js infinite page growth, pen/highlighter ink, tool-attached options, compact icon rail, Spotlight search, and mobile writing dock.
2. **Ambient intelligence** — Passive, source-grounded context cards (related notes, people, calendar drafts) that appear after writing pauses and disappear. No permanent chat surface.
3. **Mastra intelligence (optional)** — A restricted TypeScript worker that may rerank and rephrase related-note suggestions in one bounded model step. It has no tools, no DB access, and no mutation authority.

The product principle: **capture must remain immediate**. Local deterministic work runs first; model reasoning is optional enrichment.

## Quick Start

```powershell
npm install
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
npm run dev
```

| URL | Purpose |
|-----|---------|
| http://localhost:5173 | Landing + notepad (Vite dev) |
| http://127.0.0.1:3137/health | FastHTML API |
| http://127.0.0.1:4112/health | Mastra worker (`local-retrieval` or `mastra-model`) |

## Read These Files First

**Always read before intelligence or API work:**

1. [docs/PRODUCT-BRIEF.md](docs/PRODUCT-BRIEF.md) — Product north star, verified state, audio direction, open decisions
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — System diagram, data flow, file map
3. [docs/INTELLIGENCE-ARCHITECTURE.md](docs/INTELLIGENCE-ARCHITECTURE.md) — Attention policy, latency contract, invariants
4. [docs/AGENT-WORKSPACE-PROTOCOL.md](docs/AGENT-WORKSPACE-PROTOCOL.md) — Semantic resources, agent authority, proposals, adapters
5. [docs/VISUAL-INTELLIGENCE.md](docs/VISUAL-INTELLIGENCE.md) — Scan-triggered concept recognition, diagram proposals, timing, evaluation
6. [docs/ROADMAP.md](docs/ROADMAP.md) — What is complete vs planned

**By task area:**

| Task | Start here |
|------|------------|
| Canvas UI / tools / layout | `src/main.js`, `src/style.css` |
| Visual intelligence / diagram proposals | `docs/VISUAL-INTELLIGENCE.md`, `src/intelligence/diagram-assist.js` |
| Ambient orchestration | `src/main.js` — search for `queueAmbientCheck`, `quietContextualIntelligence`, `refreshRelatedNote` |
| Local browser intelligence | `src/intelligence/*.js` |
| REST API / persistence | `routes.py`, `services.py`, `app_schema.py` |
| Mastra worker | `intelligence/ambient-agent.ts`, `intelligence/server.ts` |
| Worker bridge | `intelligence_client.py` |
| External or embedded agent access | `docs/AGENT-WORKSPACE-PROTOCOL.md` |
| Config / env | `.env.example`, `routes.py` → `runtime_capabilities()` |

## Architecture at a Glance

```
Browser (Fabric + main.js)
    │  PUT/GET /api/notes, POST /api/intelligence/*
    ▼
FastHTML (routes.py → services.py → SQLite FTS5)
    │  POST /rank (optional, non-blocking)
    ▼
Mastra worker (ambient-agent.ts) → OpenAI-compatible / Azure model
```

Three processes in dev: **Vite :5173**, **FastHTML :3137**, **Mastra :4112**.

## Critical Boundaries — Do Not Cross

1. **Mastra stays in `intelligence/`** — Do not import `@mastra/core` from Python or browser code.
2. **No model tools** — The ambient agent uses `maxSteps: 1` with no shell, filesystem, browser, or DB tools.
3. **Product owns retrieval** — FTS5 ranking, person index, and candidate filtering live in `services.py`, not the worker.
4. **Local-first fallback** — Every intelligence feature must work with `PERSONAL_NOTE_MODEL` empty.
5. **Text-edit scoped ambient** — Ink, erase, move, and format save normally but must not rerun calendar/person/related detection. Use `quietContextualIntelligence()` patterns in `main.js`.
6. **Proposal-gated mutations** — Tidy, diagram refine, and calendar export require explicit user approval and must be undoable.
7. **No secrets in frontend** — Provider keys are server-side `.env` only.
8. **Auth is bypassed** — Do not enable Google OAuth or tenant scoping without explicit user request and full query scoping.

## Conventions

- **Python**: Factory pattern via `create_app()` in `routes.py`. Tests use temporary DB paths.
- **JavaScript**: ES modules, no React in production. Fabric canvas JSON is canonical note content.
- **TypeScript worker**: Zod validation on all request/response. Structured logs: `event=intelligence.rank outcome=fallback`.
- **Tests**: `tests/test_api.py` (Python), `intelligence/*.test.ts` (worker), `src/intelligence/*.test.js` (browser modules).
- **Logging**: Use structured `event=... outcome=...` patterns; avoid logging note text or secrets.

## Common Commands

```powershell
npm run dev                  # All three processes
npm run dev:ui               # Frontend only
npm run dev:api              # FastHTML only
npm run dev:intelligence     # Mastra worker only
npm run test:api
npm run test:intelligence
npm run test:ui-intelligence
npm run typecheck:intelligence
npm run build                # Production frontend → dist/
```

## Where to Extend

| Goal | Where to add |
|------|--------------|
| New intelligence task | `intelligence/protocol/schemas.ts` → `intelligence/tasks/` → `runtime/executor.ts` → optional FastHTML route |
| New agent-facing workspace operation | `docs/AGENT-WORKSPACE-PROTOCOL.md` → product-owned protocol service → transport adapter |
| New model provider | `intelligence/providers/` → register in `registry.ts` |
| New ambient feature (local) | `src/intelligence/`, wire in `src/main.js`, add API in `routes.py` + `services.py` |
| Retrieval improvement | `services.py` (`related_candidates`, `index_note`, FTS5 queries) |
| New canvas tool | `src/main.js` + `src/style.css` |

See [docs/INTELLIGENCE-PROTOCOL.md](docs/INTELLIGENCE-PROTOCOL.md) for the wire protocol, tier model (`local-only` / `local-first` / `cloud-ok`), and local model recommendations.

When adding Mastra capabilities, prefer **narrow read/proposal tools** that call FastHTML APIs rather than direct SQLite access.

## Experiments (Out of Production Path)

- `experiments/ag-ui/` — AG-UI + Mastra spike. **Rejected for ambient path** (dependency weight). Do not wire into `npm run dev` without explicit approval.
- `spatial-docs.html` — Pretext variable-width text layout reference. Production canvas remains Fabric-based.

## What Not to Do Without Asking

- Replace Fabric with React or Pretext wholesale
- Add a permanent chat/assistant panel
- Enable authentication or multi-tenancy
- Add background drawing monitors or per-stroke popups
- Commit `.env` or put API keys in frontend code
- Add E2EE claims without implementing client-held keys
- Expand Mastra to mutate notes directly

## Documentation to Update When You Change

| Change type | Update |
|-------------|--------|
| New intelligence lane or API | `docs/INTELLIGENCE-ARCHITECTURE.md`, `docs/ARCHITECTURE.md` |
| Completed roadmap item | `docs/ROADMAP.md` |
| New env vars | `.env.example`, README model setup section |
| New dev commands | `package.json`, this file, README |
