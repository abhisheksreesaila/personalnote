# Jam 2026-10-10: landscape scan

Researched 2026-10-10 for the captain's brainstorm (ideas in `jam-2026-10-10-captain-ideas.md`). Web sources, many third-party; treat dates and version numbers as approximate.

## CopilotKit (github.com/CopilotKit)

- **OpenMuse** (`CopilotKit/openmuse`, MIT, alpha, ~2026-09): self-hosted personal agent with its own browser. "Visible work" view: plan, progress, ask-for-input, pause/resume/cancel/retry, approvals, saved receipts.
- **OpenDots** (`CopilotKit/OpenDots`, MIT, alpha, ~2026-10-01): always-on specialist agents ("Dots", each with role, instructions and tool permissions) across text, realtime voice and Slack. Pages live in SQLite "Spaces", separate from chat. A "review before saving" card gates every draft.
- **OpenIntelligentUI** (the captain's "Open Intelligence"; `CopilotKit/OpenIntelligentUI`): generative UI chat. Each turn routes to text, a native component, or HTML/CSS/JS streamed into a sandboxed iframe. "CopilotKit Intelligence" is separately their paid thread-storage service.
- **AG-UI protocol** (docs.ag-ui.com): agent-to-UI events, including shared state as snapshot plus JSON Patch deltas both ways.
- No CopilotKit mind-map or whiteboard demo exists. Borrow the patterns (shared-state deltas, approval cards, sandboxed generated UI), not the React stack.

## Obsidian

- Official CLI since v1.12 (Feb 2026); it needs the desktop app running. Bases gained kanban in v1.14 (Sep 2026).
- `kepano/obsidian-skills`: agent skills for Obsidian Markdown, Bases, JSON Canvas and the CLI. Strategy: open formats + CLI + skills, no built-in AI, no official MCP.
- Gaps: no revision checks when agents write, no authorship marks or review step, weak canvas for agents (no layout help, no ink), no first-party meeting capture, semantic search only via plugins.

## Others

- **Granola**: MCP + REST API (early 2026, read-only); "Briefs" are cited pre-meeting summaries (May 2026).
- **tldraw agent starter kit** (MIT): an agent creates, updates and deletes shapes, moves its viewport, and has every action validated before it applies.
- **Excalidraw MCP servers**: Mermaid to shapes; auto layout (Sugiyama) beats asking the model for coordinates.
- **iA Writer**: marks human vs AI text in plain files.
- **Reflect, Bear (unverified), Markus, ZenNotes**: MCP or CLI access is now table stakes for Markdown apps.
- **Paper (paper.design)**: canvas whose elements are real HTML/CSS; a read/write MCP (`paper mcp` over stdio); $34M Series A; alpha quality.
- **HyperFrames** (`heygen-com/hyperframes`, Apache-2.0): HTML in, deterministic MP4 out (headless Chrome + FFmpeg). Clips are elements with `data-start`/`data-duration`/`data-track-index`; animations are seekable timelines. Ships agent skills including `/slideshow`, which outputs an HTML deck.

## Openings for Personal Note

1. Revision-safe agent access that doesn't need the app open: CLI + local MCP + a skills pack.
2. Agent changes as reviewable proposals with authorship marks (agent-core brief).
3. Meetings: pre-meeting brief, then structured notes, with audio never saved.
4. Agents describe diagram structure and the app does the layout; Mermaid as input.
5. Frames become slides, and a HyperFrames project folder becomes a video the user renders.
6. Mind-map co-thinking: ghost branches as proposals, the focus path sent as shared state, "make it visual" as sandboxed or declarative blocks.
