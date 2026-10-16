# X bookmarks land in Personal Note

Status: approved
<!-- Approved 2026-10-16: the captain said "run this in autopilot and just ship it however you see fit" after reading the drafts.
2026-10-16, captain by voice: "I bookmark a lot … but it's forgotten … hooks up to Twitter, downloads all the bookmarks
… lines them up in the inbox … with a Twitter symbol … I can just move around and drop it into a note". Clarify round 1
chose the official API with auto-sync; (assumed) marks calls the captain left open. -->

## Why (the mission)
- Why this exists, in one sentence: bookmarks on X are where good posts go to be forgotten; here they line up where you already sort your thinking.
- Why now: X's pay-per-use API lists reading your own bookmarks at about $0.001 a post (an "owned read"; one developer was billed $0.005 in April 2026, so the console is the truth).
- If it disappeared tomorrow: the bookmarks tab on X, scrolled once and never again.

## Who it's for
- First: the captain, who bookmarks a lot on X and wants to do something with them later.
- The moment: opening Personal Note and seeing what he saved this week.

## What it does
- The core job: bring every X bookmark into Personal Note, ready to read, drop into a note or file.
1. **Connect X once** in Settings (sign in to X in the browser; the app keeps a refresh token in the system keychain). A step-by-step script walks the captain through making the X developer app (assumed: the captain's own developer app, so his reads are "owned reads").
2. **Auto-sync:** on app start and every hour while open, new bookmarks arrive in an **X bookmarks** notebook (X icon) under Inbox (assumed: its own notebook rather than mixed into Inbox, so Inbox stays your own captures), newest first; each is a small card: author, text, first picture, link, date. Never fetched twice.
3. **Use them:** drag a bookmark onto any note (it lands as a link card with the text), move it to another notebook, or mark it done (archived, not deleted). Searchable like any note, including by meaning.
- Not now: posting, liking or un-bookmarking on X; threads expanded; videos downloaded; other sites (a later "web clips" brief).

## How it should look and feel
- Three words: tidy, glanceable, yours.
- Like: Readwise Reader's feed (a card per saved item), Raindrop's previews.
- One screen: the X bookmarks notebook open, 20 cards, one being dragged onto a note.

## How we'll know it worked
- A bookmark made on the phone shows up in Personal Note within the hour, once, and can be dropped onto a note in one drag.
- "Done" for v1: connect, first full import, hourly new ones, drag onto note, works after a restart without signing in again.

## Constraints and risks
- Money: about $1 per 1,000 posts read; the first import of a long history is the biggest bill. The cap: first import stops at 800 posts (the API returns at most the latest 800 bookmarks anyway) (assumed).
- Network: the first outbound link besides the opt-in downloads; only to api.x.com, only after "Connect X", only for bookmarks. AGENTS.md invariant 8 ("no sync") gets a line for it.
- Riskiest assumption: X's OAuth 2.0 sign-in with PKCE can return to a loopback address on the captain's Mac. Cheapest test: the setup script does one real sign-in and lists 5 bookmarks before any UI.

## Decisions and trade-offs
- Official API with auto-sync: reliable, nothing to remember; con: a one-time developer app setup and a small bill.
