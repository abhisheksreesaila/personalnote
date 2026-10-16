# Everything beyond the notebook is a plugin

Status: approved
<!-- Approved 2026-10-16: the captain said "run this in autopilot and just ship it however you see fit" after reading the drafts.
2026-10-16, captain: "we built a strong base … now we can diverge into all these external use cases keeping in mind
that everything should be a plugin. If someone doesn't need any of this, they should just get the notebook. Even the mind
map is a plugin that's added by default, but they can switch it off or not even download it … I need a notebook. Oh, I
need a mind map. Oh, I want a mind map AI that builds itself. Ultimately I want someone to listen to my meeting notes and
talk to me." (assumed) marks calls the captain left open. -->

## Why (the mission)
- Why this exists, in one sentence: each person grows Personal Note from a plain notebook into exactly the tool they need, and nobody carries what they don't use.
- Why now: the core (canvas, page notes, search, backup, islands) is solid; what's coming next (jams, X bookmarks, a meeting companion) is optional by nature and some of it talks to the outside world.

## What it does
- The core job: switch whole capabilities on and off, and download the heavy ones only when wanted.
1. **The core is the notebook**: notebooks, canvas and page notes, word search, backup and export, the islands. Always there.
2. **Settings → Plugins** lists each plugin with what it does, its size, what it needs (a download, the network, a model) and an on/off switch. Off means: none of its buttons, menus or shortcuts show, its code isn't loaded, it starts nothing and contacts nothing, and its notes and data stay safe (a mind map opens read-only with "turn on Mind maps to edit") (assumed).
3. **The first plugins** are today's optional parts moved behind the switch, then the new ones:
   - Mind maps (on by default), Voice (download), Search by meaning (download): existing.
   - Jam sessions (needs Mind maps + Voice + a model), X bookmarks (needs the network): docs/briefs/jam-sessions.md, x-bookmarks.md.
   - Later: **Meeting companion**: listens to a meeting, keeps live notes, and talks it through with you afterwards (its own brief).
- Not now: plugins written by other people (installing code from outside). Plugins are built in, written by us, each in its own module; `plugin_manifest.py` stays the future door for outside plugins (assumed).

## How it should look and feel
- Three words: light, honest, yours.
- Like: Obsidian's core plugins page (a switch per feature, clear descriptions), VS Code's "downloads on first use".

## How we'll know it worked
- With every plugin off, the app is just the notebook: no plugin code in the first load, no mic, no mind-map button, no network, and the bundle's first load is smaller than today's.
- Turning a plugin on works without a restart; turning it off hides it without losing anything.

## Constraints and risks
- Each existing feature (mind map, voice, meaning search) has to move behind one plugin boundary without breaking the 30-odd verify scripts.
- Riskiest assumption: the main shell (src/main.js) can learn about plugins through a small host contract (register buttons, note types, omnibar actions, settings rows) rather than a rewrite. Cheapest test: move Mind maps first, the plugin with the most touch points.
- Invariant 8 and docs/MODULE-CONTRACTS.md change: modules become switchable built-in plugins with a declared contract and capabilities (an ADR).

## Decisions and trade-offs
- Built-in plugins only, for now: safe (no outside code), fast to build; con: nobody else can write one yet.
- Off = hidden and not loaded, data kept: the notebook stays light and nothing is lost; con: some plugins' notes open read-only while off.
