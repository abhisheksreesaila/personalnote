# Secure notes design

Chosen: **Option B, quiet cover** (captain, 2026-10-13).
Mock: https://claude.ai/artifact/7CGbPKqudFnYheroYrLNhn, "Secure notes" tab (source in `docs/design/sidebar-and-secure-mock.html`; re-implement, don't ship it).

## Tokens and components
- Secure colour: a new skin token `--sk-secure` with `--sk-secure-soft` and `--sk-secure-line`, one value per skin. Crayon/Paper `#6a46c9` / `#efe9fb` / `#d9cdf6`; Night `#c3a8ff` / `rgba(195,168,255,.13)` / `rgba(195,168,255,.32)`. Added to src/skins.css beside the other `--sk-*` tokens.
- In the sidebar: a secure note's row uses the lucide `lock` icon in place of its note icon, text in `--sk-secure`.
- Locked note (cover): the page keeps its title (Bricolage, `--sk-display`) with a lock icon; the whole page is `--sk-secure-soft`; centred, a 92px round fingerprint button (`--sk-panel`, `--sk-shadow`, lucide `fingerprint` 42px in `--sk-secure`), heading "Touch to open", line "Secure note · hidden from screen sharing" in `--ui-muted`, and a "Use recovery key" text link in `--sk-secure` that turns into a monospace key field.
- On Linux the same cover asks for the passphrase (a field plus Open) instead of the fingerprint.
- Unlocked note: the page gets a 3px inset top edge in `--sk-secure`; the top bar shows a pill (`--sk-secure-soft` fill, `--sk-secure-line` border, `--sk-secure` text, shield icon): "Hidden from screen sharing · locks in 4:59" with a Lock button.
- Make secure: in the note's menu. The first time, a sheet shows the recovery key (Geist Mono 17px, 8 groups of 4, dashed `--sk-secure-line` box), a warning callout ("It is shown once. Without it, a lost Mac means lost secure notes. Keep it in a password manager or on paper, not in a note."), Copy, and Done, which stays disabled until "I saved it somewhere safe" is ticked.
- Touch ID itself is the Mac's own system prompt; the app draws nothing for it.

## States
- Locked, unlocking (fingerprint button pulses while the system prompt is up), wrong or cancelled ("Not opened. Try again." under the button), unlocked, auto-locked (the cover returns and the pill disappears).
- It locks when you open another note, after 5 quiet minutes, or when the Mac sleeps.
- Recovery key entered wrong: "That key doesn't match. Check the groups and try again."
- Long titles: one line with an ellipsis on the cover; full title once open.
