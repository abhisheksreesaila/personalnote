# Lessons

<!-- One line per lesson, added when you correct Claude or a mistake gets caught:
- YYYY-MM-DD · the rule that prevents it, and why
Claude reads this at the start of each session. -->
- 2026-09-30 · Before offering interpretations of a product idea, check what the app already implements (e.g. "expand/shrink" = existing draw.io-style page growth), so questions start from what's built.
- 2026-09-30 · Worktree subagents branch from origin/main, not local main; when local main is ahead, tell builders to rebase onto local main before finishing. Never chain `git commit -a` after a merge that may conflict — it commits the conflict markers.
- 2026-09-30 · A Fabric 7 subclass must set its own defaults in its constructor (`super(); Object.assign(this, X.ownDefaults); this.setOptions(options)`); a `static ownDefaults` alone is silently ignored.
- 2026-09-30 · Never have the client guess a future revision (e.g. in-flight R+1) to save on close — it can overwrite an agent's write; send the last confirmed revision and accept a conflict.
- 2026-09-30 · Builders and reviewers must stop every server, browser and window they start, and never use the app's real port (3137) or the captain's real database; a leftover old server on 3137 made the captain's test open stale code.
- 2026-09-30 · Guard every browser-storage access (localStorage can be missing in WebKit web views) and check frontend changes in a non-Chromium engine; tests/test_webview_smoke.py loads the built app in the system web view with a hidden window.
- 2026-10-02 · Never use broad pkill patterns (e.g. `pkill -f headless`) — other projects' sessions run headless browsers on this machine; stop only the PIDs you started.
- Cleanup deletes only exact paths you created; never `rm -rf` with a glob (a reviewer's `/var/tmp/tmp*/t.db` could have hit other projects' files).
- An engine port needs a feature inventory of the old app (every tool, button, shortcut) checked off before calling parity; four Fabric features (shape tool, Clear all, voice placement, agent flag) slipped through slice-by-slice reviews.
- Test and benchmark runs on the captain's machine are headless (or under a virtual display); never open visible browser windows, never in a loop that respawns them.
- Rendering choices are decided by the in-app comparison on the real Mac, not by headless runs: headless ranked the gesture transform best, the Mac ranked it worst.
- Before merging anything into leafer, run every verify-* script (one at a time), not just the ones the change seems to touch: a CSS-only dock fix broke the IME text check because the test clicked where the dock used to be inert.
