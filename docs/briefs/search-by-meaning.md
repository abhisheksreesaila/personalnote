# Search by meaning (EmbeddingGemma 2, on this device)

Status: approved
<!-- 2026-10-16: the captain asked by voice for the next release to "power the search with Gemma 2 embeddings, on device,
test how heavy it makes the app", plus Nemotron for voice, built overnight and packaged for the morning. Calls the
request leaves open are marked (assumed). Voice already ships nvidia/nemotron-3.5-asr-streaming-0.6b (voice_runtime.py),
the newest Nemotron ASR found on 2026-10-16, so voice needs no change in this release. -->

## Why (the mission)
- Why this exists, in one sentence: find a note by what it means ("why am I tired" finds *Sleep log*), not only by the exact words in it, without anything leaving the machine.
- Why now: Google released EmbeddingGemma 2 on 2026-10-06 (Apache 2.0, text weights ~270M); a spike on 2026-10-16 found the right note 6 of 6 times with no shared words, 20–90 ms per search on a laptop CPU.
- If it disappeared tomorrow: search keeps needing the exact word you wrote months ago.

## Who it's for
- First: the captain on the Mac, searching with ⌘K for a half-remembered note.

## What it does
1. **An optional download, like voice.** Settings gets "Search by meaning: Download (≈315 MB)". It fetches a pinned llama.cpp server build (≈17 MB, official ggml-org release b11681, sha256-checked) and the EmbeddingGemma 2 Q8 model (`ggml-org/embeddinggemma-2-GGUF`, revision bfcd2987…, 296 MB, sha256 2188ac1d…) from Hugging Face, verifies both, and installs them beside the database. The app download does not grow (assumed). Progress and failures show in place; a failure leaves search working as today.
2. **A quiet index.** Once installed, notes are embedded in the background (title + the same text search already reads), stored in SQLite next to the notes, refreshed when a note changes. Secure notes are never embedded (an embedding leaks content). Saving and typing never wait on it (invariant 1). Vectors are derived data: not in backup or export; rebuilt if missing (assumed).
3. **Search finds by meaning.** The omnibar keeps today's title and word matches first; below them a "By meaning" group lists the closest notes not already shown (assumed: top 5 above a similarity floor). Without the download, search is exactly as today. The CLI gets `personal-note search --meaning "…"` so local agents can use it too.
4. The engine runs only while the app is open, on a loopback port, started on first use and stopped with the app (assumed).
- Not now: searching inside pictures or audio (the model can, later), "related notes" suggestions, a chat.

## How it should look and feel
- Invisible until useful: the same ⌘K, a second group of results. Three words: private, quick, forgiving.

## How we'll know it worked
- A meaning query finds the right note on the captain's own notebook; keyword search unchanged when the model is absent.
- Typing speed (speed test) unchanged with indexing running.
- The download works on the Mac app and the Linux bundle from the release.

## Invariant change
AGENTS.md invariant 8 ("no model worker") becomes: one optional local embedding worker for search, downloaded on request, loopback only, never sent anything off the machine.
