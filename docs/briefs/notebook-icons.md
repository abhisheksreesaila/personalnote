# Notebooks with a personality

Status: approved
<!-- Approved 2026-10-16: the captain said "run this in autopilot and just ship it however you see fit" after reading the drafts.
2026-10-16, captain: "the notebooks should have a personality … Twitter things … a Twitter symbol … a bunch of links …
a web icon … household chores … a house … more personal and more colorful". Clarify chose "guessed, you can change it". -->

## Why (the mission)
- Why this exists, in one sentence: a notebook you recognise by its icon and colour feels like yours and is found at a glance.
- If it disappeared tomorrow: a list of grey names.

## What it does
- The core job: give every notebook an icon and a colour.
1. **Guessed from the name** when it's made: "Chores" → house, "Links" → globe, "X bookmarks" → the X logo, "Recipes" → pot, and so on from a small built-in word list (assumed: a list, not a model; no network). No match → the notebook's first letter on its colour.
2. **An emoji at the start of the name always wins**: "🏠 Chores" shows the house emoji.
3. **Click the icon to change it**: about 40 icons, any emoji, 8 colours. The choice is saved with the notebook and travels in backups (a backup version bump if the format needs it).
- Not now: icons per note; pictures as icons.

## How it should look and feel
- Three words: personal, colourful, quiet.
- Like: Notion's page icons, Apple Notes' folder colours. Icons tinted with the notebook colour in the notes panel and the island card.

## How we'll know it worked
- The captain's notes panel shows a different icon and colour per notebook without him setting any; he can change one in two clicks.

## Decisions and trade-offs
- Guessed and changeable: colourful from day one; con: a wrong guess until changed.
