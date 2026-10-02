# Ideas: the notebook your agents share, and paper you love to draw on

Two people must both say "I have to use Personal Note":
- **The agent person** runs Claude Code, Cursor, Codex, Chrome agents. Their pain: every agent has its own forgotten memory; context gets re-explained every session; outputs scatter across chats and files.
- **The drawer** thinks with a pen. Their pain: ink is a dead end, unsearchable and invisible to every tool.

The bridge between them is the product: **everything you draw becomes readable by agents, and everything agents write becomes something you can see and move.**

## A. Agent-native ideas

1. **One notebook, every agent.** A local MCP server plus the CLI, so Claude Code, Cursor, Codex and Claude Desktop all read and write the same notebook, under one permission table. Positioning: "the shared memory for all your agents."
2. **Session cards.** Every agent session ends by posting a card to its project page: what it did, files touched, decisions, open questions. Done with Claude Code hooks (SessionEnd/Stop) calling `personal-note append`. Your projects keep a readable log of all agent work without you writing anything.
3. **Hand a page to an agent.** A button on any page or selection: "Send to Claude Code." The selection becomes the agent's brief; its results come back as proposals on that page. The canvas becomes the place you brief agents.
4. **Arrows as instructions.** Draw an arrow from a card to empty space and write a verb on it ("summarize", "turn into tasks", "find sources"). The agent fills the target. Chains of arrows become a visible pipeline, like a node graph made of notes. Re-run a chain when the source changes.
5. **The baton.** One-at-a-time collaboration: whoever holds the baton edits, you or an agent or a friend; everyone else watches live and queues. No merge conflicts by design. Every turn is a coloured layer you can replay or undo as a whole. ("Miro, but taking turns.")
6. **Ghost proposals on the canvas.** Agent changes appear as translucent ghosts in place, not just in a side list. Tap a ghost to accept, flick it away to dismiss. Diffs you can see spatially.
7. **Context packs.** Select cards, press "Pack": a Markdown bundle with links that any agent can load (`personal-note pack <id>`), or that copies to the clipboard for a chat. The canvas becomes how you curate context.
8. **Use your Claude subscription as the cloud lane.** If Claude Code is installed, the cloud lane runs `claude -p` with the page as input: no API key and no extra bill, and it respects the user's own setup. An API key stays optional.
9. **Agent inbox for you.** Agents can ask you a question as a card in Inbox ("which of these two sources is right?"). You answer on the card, and the agent's next run sees the answer. Async, at a cap of N asks a day.
10. **Readable memory file.** A `MEMORY.md`-style projection per area that agents load at session start, generated from the notes you marked as "facts". Edit or forget a line in the notebook and every agent's memory changes.

## B. Drawing that feels good

11. **Ink that reads.** Local handwriting recognition turns ink into searchable, agent-readable text without changing how it looks (Apple Vision on the Mac app; an open OCR model on Linux). Shapes get meaning too (box, arrow, circle, underline). The drawer's notes join search, Ask and agents for free.
12. **Tidy, but still yours.** A gentle beautify: straighten a shaky line, close a nearly closed circle, align a hand-drawn list, all undoable, the ink keeping your hand.
13. **Sketch to structure.** Scribble boxes and arrows, then "make it a diagram" or "make it a mind map": a small local vision model proposes a clean version beside your sketch as a ghost.
14. **Paper and tools as delight.** Paper textures and skins, pencil tilt shading, hover preview with Apple Pencil, a quiet page-turn when a new page grows, washi tape and stickers as objects. Speed stays 60 fps; delight never costs frames.
15. **Draw with your voice.** "Put a timeline across the top with five steps": the agent draws it as a proposal you can move.

## C. Collaboration, one at a time

16. **Pass the pen.** Share a page link; the other person (or their agent) takes the baton, adds a turn, passes it back. Async by default, live when both are present. Each turn signed and replayable.
17. **Rooms later.** The Futures canvas's shared rooms build on the baton, which avoids most real-time sync problems first.

## D. Models (candidates to benchmark, not decisions)

| Job | Lane | Candidates |
|---|---|---|
| Speech to text | local | Nemotron streaming ASR (shipping now) |
| Filing, tags, short summaries, Ask answers | local | a small instruct model around 1.5–3B in GGUF via llama.cpp (e.g. Qwen family); pinned download like the voice model |
| Semantic search | local | a small embedding model (~0.1–0.6B) next to FTS5 |
| Handwriting and screenshots to text | local | Apple Vision on Mac; an open OCR model on Linux |
| Sketch understanding | local, optional | a small vision-language model (~2B) |
| Drafts, research, code-adjacent work | cloud | Claude via the user's Claude Code (`claude -p`) or an API key |
| Vault | none | never sent to any model |

Rules: models load lazily, run in a separate process, never block typing or capture, and each lane shows what left the Mac.

## E. What would make people switch (the hooks)

- "My agents finally share one memory, and I can read and edit it."
- "My handwriting is searchable and my agents understand my sketches."
- "It's fast with thousands of things on a page."
- "Nothing changes without my yes, and nothing private leaves my Mac."

## F. First slice that proves both

Session cards from Claude Code (2) + a local MCP server (1) + proposals as ghosts (6) + ink that reads (11). That gives the agent person a reason to install it on day one, and makes the drawer's ink visible to those same agents.
