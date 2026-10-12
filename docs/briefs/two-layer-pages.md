# Two-layer pages (Milestone 1)

Status: approved
<!-- Approved by the captain on 2026-10-11 ("break it into smaller tickets in the plan, build them, test first"). -->
<!-- Written with the captain via /clarify on 2026-10-11. Assumptions are marked (assumed).
     Nothing gets built until the captain changes the line above to approved.
     Feel reference: prototype https://claude.ai/artifact/AKJea2GZJmZRFH49NnWcPm (branch prototype/two-layers). -->

## Why (the mission)
- Why this exists, in one sentence: writers want structure (proper Markdown, one block after another) and readers want to mark up, draw and whiteboard; a page with a text layer and an ink layer gives both in one note, and agents read it as plain Markdown.
- Why now, and why you: the prototype felt like "what I wanted all these years"; no app the captain knows does flowing text plus ink that follows the words.
- If it disappeared tomorrow: back to Markdown apps you can't draw in, and whiteboards whose text is loose and unstructured.

## Who it's for
- First: the captain, taking notes daily on the Mac.
- The moment: writing notes or a doc, then wanting to circle, sketch or explain with a diagram without leaving the page.
- Today: Markdown editors (no ink) or the current canvas (ink, but loose free-floating text).

## What it does
- Core job: write in Markdown, draw on top, and keep both in order.
- v1 does:
  1. **A page note** that opens by default: CodeMirror 6 Markdown, one continuous page with faint page marks, growing as you write or draw.
  2. **Two layers of ink.** Marks on words follow those words through every edit (circles, underlines, highlights; margin marks follow their line). A drawing on empty space stands on its own in the page and can hold shapes and **text objects** (word art: big or small text placed freely, not Markdown).
  3. **Fold behind a word.** Link any drawing to a word; it can fold away and the word becomes a teal link that slides the drawing out, smoothly, on click. Fold all / unfold all.
- Also in v1: Write/Draw modes (Esc returns to writing), one undo for text and ink, agents read and write the Markdown through the CLI and ink re-finds its words (loose ink waits in a tray, never lost), search, backup and Markdown export.
- Not in v1: changing the canvas or mind map notes (they stay as they are, still available), real separate sheets (Word-style pagination), converting old canvas notes, agent-made drawings, ghost branches (Milestone 2), meeting capture (Milestone 3), phones.

## How it should look and feel
- Three words: calm, paper, direct. (assumed)
- The prototype's look, for the whole app (captain's call): ivory paper on a warm desk, Literata text at 18 px with roomy lines, Bricolage headings, Figtree controls, teal link words, purple for agent things. Replaces earlier colour guidance.
- The one screen: a page with Markdown text, a few marks on words, and one teal word with a drawing sliding out of it.
- Motion: the fold opens and closes in about 0.6 s with a liquid ease; text below glides, never jumps.

## How we'll know it worked
- The captain uses page notes daily on the Mac within a week of the app build. (assumed)
- Done for v1: everything in "What it does" works in the Mac app; pen and typing stay smooth on a long page; a page survives save, reload, backup/import, export and an agent rewrite with its ink in place.

## Constraints and risks
- Storage: the Markdown is canonical and stays clean; ink, drawings, links and fold state live beside it in the same note row (see ADR 0003). Search, CLI read and export use the Markdown.
- Riskiest assumption: anchors survive real editing (paragraph split/merge, agent rewrites). Cheapest test: the prototype's cases become automated tests first.
- Performance: CodeMirror is lazy-loaded with the page note; the bundle budget still holds for the main chunk.
- Mac web view (Safari engine) is untested by the prototype: check pen, IME and the fold animation there early.

## Decisions and trade-offs
- Page is the default new note; canvas and mind map stay. Pro: writing-first. Con: canvas becomes secondary.
- Continuous page with page marks, not real sheets. Pro: cheap, smooth. Con: print splits wherever a mark falls.
- Drawings on empty space stand alone; linking to a word is the user's choice. Pro: no guessed links. Con: a standalone drawing still moves down when text is added above it.
- Merged the Leafer engine into main first (2026-10-11). Pro: one branch. Con: the Mac zoom hitches ship to main unfixed for now.
- CodeMirror 6 for the text layer. Pro: Markdown stays the source, position mapping makes anchors cheap. Con: about 0.3–0.5 MB more, lazy-loaded.

## Open questions
- Should the canvas note's Leafer ink (pressure, smoothing) be reused for page ink, or does SVG ink suffice? (engineering call in the plan)
- Fold state: saved per note (everyone sees it folded) or per viewer? (assumed: saved with the note)
