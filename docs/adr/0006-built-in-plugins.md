# 0006: Optional features are built-in plugins, switched per machine

Status: accepted (2026-10-16), F-090 (brief: docs/briefs/plugins.md)

## Context
The notebook (canvas and page notes, word search, backup and export, the islands) is the core. Mind maps, voice and search by meaning are optional by nature, and what comes next (jam sessions, X bookmarks, a meeting companion) will contact the outside world. Someone who needs none of it should get just the notebook.

## Decision
- **Built-in only.** A plugin is a module we write and ship inside the app, declared once in `src/modules/plugins/builtin.js`. No outside code is installed or run; `plugin_manifest.py` stays the validated door for a future outside-plugin story and executes nothing.
- **Off means three things:** hidden (no button, menu entry, omnibar action or shortcut of its own), not loaded (its code is imported only through `registry.mountEditor`, which refuses while the plugin is off, so the chunk is never requested), and data kept (its notes still list, open read-only and travel in backup and export; nothing is deleted).
- **One choice per machine**, in `plugins.json` in the app-data folder (`plugin_settings.py`, `PERSONAL_NOTE_PLUGINS_DIR` overrides), so the page, the server and the command line read the same answer. It is never in the notes database, a backup or an export. A missing or damaged file means each plugin's default (Mind maps on).
- **The shell asks a registry** (`src/core/plugins.js`) instead of naming a plugin's feature; the contract is in docs/MODULE-CONTRACTS.md. The server refuses to create a note of an off plugin's type (`POST /api/notes` answers 409; `notes create --type mindmap` exits 2 with the reason); reading and importing are unaffected.
- Invariant 8 (no remote agent endpoint, no generative worker) is unchanged; a plugin gains no authority by being a plugin.

## Consequences
- A map opened while Mind maps is off is an outline with "Turn on Mind maps to edit" and a button; its title is read-only, and it is saved back exactly as loaded if anything triggers a save.
- Turning a plugin on or off works without a restart: the open note of that plugin is reopened the right way.
- "Not downloaded at all" (the brief's second half) needs the plugin's code split out of the first install; that is a packaging step for later, the registry already has the seam (`mountEditor`).
- Voice and Search by meaning join the registry in F-091.
