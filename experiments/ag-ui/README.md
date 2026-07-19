# AG-UI Compatibility Spike

This experiment verifies that the official `@ag-ui/mastra` adapter can wrap the current Mastra 1.x agent behind the framework-neutral AG-UI client contract without React.

It is intentionally isolated from the production package and request path. The ambient local lane, person lookup, calendar parsing, FastHTML APIs, and `/rank` worker contract do not depend on AG-UI.

## Intended Boundary

AG-UI is a candidate transport for long-running, user-visible workflows such as weekly assembly or research. It is not useful for the sub-second local detection lane.

The first production experiment should expose one authenticated SSE endpoint and consume only run lifecycle, streamed text, and proposal-only tool events. Shared writable state remains disabled until conflict handling and tenant authorization are designed.

## Result

- `@ag-ui/mastra@1.1.1` is type-compatible with `@mastra/core@1.51.0`.
- A plain TypeScript client can use `runAgent`, `subscribe`, messages, and protocol events without React or CopilotKit UI components.
- The isolated peer graph installs 498 packages and currently reports 8 low and 3 moderate audit findings.
- One transitive `posthog-node` release requires Node `22.22+`; the validated workstation uses Node `22.17`.

Decision: do not add AG-UI to the production package or ambient path. Revisit it for one authenticated, long-running workflow after upgrading Node and reviewing the isolated audit report.

## Run

```powershell
npm install --prefix experiments/ag-ui
npm test --prefix experiments/ag-ui
npm run typecheck --prefix experiments/ag-ui
```