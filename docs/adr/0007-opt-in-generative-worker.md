# 0007: Jam sessions: one opt-in generative worker, started only by a jam turn

Status: accepted (2026-10-16), F-092 (brief: docs/briefs/jam-sessions.md; plugin rules: ADR 0006)

## Context
AGENTS.md invariant 8 said there was no generative model worker: agents acted only when they ran the command line, and the only model on the machine was the embedding worker for search by meaning. Jam sessions (talk an idea through and a mind map grows) need a model that writes: given the map and what was just said, it proposes branches, thumbs and suggestions. The person already pays for one (their Claude plan through Claude Code on this machine, or an Azure OpenAI / OpenAI-compatible deployment) and chooses it once in Settings → AI (F-093).

## Decision
- **One optional generative brain, owned by `jam_brain.py`, reached only through `POST /api/jam/turn`.** It exists only while the Jam sessions plugin is on (off by default; it also needs Mind maps and Voice on) and only when the person presses Jam (or says "jam" at the end of a sentence): one call per press, never per word, never in the background, never at startup, never on save. Nothing else in the app calls a model.
- **What leaves the machine, and where.** One request carries the open map (node ids, parent ids and the words on them) and the words spoken since the last turn, to the brain Settings → AI names: `claude -p` run on this machine as the person's own signed-in Claude Code (no tools, no files, no session kept, working folder empty), or the configured https endpoint (plain http only to this computer). Audio is never sent; voice stays on this computer (invariant 4). No note other than the open map is read.
- **The key** lives only in the system keychain (a 0600 file on Linux) or the `PERSONAL_NOTE_JAM_API_KEY` environment variable, never in SQLite, backup, export, logs, the page or a response. Redirects are refused so a header cannot follow one.
- **The model can only add and react.** `jam_brain.propose` rejects any answer that removes, renames or moves a branch, names a node that is not there, or runs long, and the whole answer is dropped, so the map is never half-changed. The route returns validated edits and saves nothing; the editor applies them as one undo step and never touches the person's own branches. Branch words and emoji are drawn as text, never HTML.
- **One turn at a time**, enforced by the route (a second press is a plain 409 "still working") and the page. The model call runs in a thread, never on the event loop that saves notes.
- **Failure is visible and harmless.** No brain set up points to Settings → AI; an error or timeout is said in plain words with Try again; the map is untouched either way.
- Everything else in invariant 8 stands: no chat, no automatic suggestions, no sync, no remote agent endpoint, agents act only when they run the CLI. A plugin gains no authority by being a plugin (ADR 0006).

## Consequences
- Turning Jam on is the consent: the Settings row says each Jam sends that map and your words to the chosen model. Turning it off hides New jam and the island's jam face and refuses the route; maps already made stay ordinary mind-map notes (emoji and thumbs are fields on branches, ghosts are never saved).
- A turn already out when Jam is switched off finishes on its own (a `claude -p` call cannot be recalled) and its answer is dropped by the page.
- Anthropic's terms on subscription use outside Claude Code itself shifted in 2026: running the person's own CLI for themselves on their own machine is the case relied on; re-check before this ships to anyone else, who would bring their own sign-in or key.
- The check script (`scripts/verify-jam.mjs`) replaces the brain with a scripted one through `create_app(brain=...)`; no environment variable or setting can swap the brain in the shipped app.
