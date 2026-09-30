# Lessons

<!-- One line per lesson, added when you correct Claude or a mistake gets caught:
- YYYY-MM-DD · the rule that prevents it, and why
Claude reads this at the start of each session. -->
- 2026-09-30 · Before offering interpretations of a product idea, check what the app already implements (e.g. "expand/shrink" = existing draw.io-style page growth), so questions start from what's built.
- 2026-09-30 · Worktree subagents branch from origin/main, not local main; when local main is ahead, tell builders to rebase onto local main before finishing. Never chain `git commit -a` after a merge that may conflict — it commits the conflict markers.
- 2026-09-30 · A Fabric 7 subclass must set its own defaults in its constructor (`super(); Object.assign(this, X.ownDefaults); this.setOptions(options)`); a `static ownDefaults` alone is silently ignored.
- 2026-09-30 · Never have the client guess a future revision (e.g. in-flight R+1) to save on close — it can overwrite an agent's write; send the last confirmed revision and accept a conflict.
