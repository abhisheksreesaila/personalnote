# 0004: The two layers live inside the canvas note

Status: accepted (2026-10-12). Supersedes the "page is its own note type and the default" part of 0003.

## Context
The first Milestone 1 build made pages a separate note type with its own editor. Trying it, the captain found the canvas's bottom toolbar, zoom and growing/shrinking pages gone, and asked that every existing feature stay: "only add should be 2 layer stuff… so that it's text native but can be drawn".

## Decision
- The canvas note is the one writing surface. Text objects made from now on carry `format: 'markdown'`: their `content` is Markdown, drawn formatted (headings, emphasis, lists, quotes, code, links). Older text objects stay plain.
- Layout is done by the browser (a hidden DOM copy with the same styles), and Leafer paints what it measured: one engine lays the words out, so edit and display agree and every word's box is known.
- Marks on words belong to their text object (`marks: [{ anchor: {pos, end, quote}, dx, dy, ... }]`) and are drawn from the word boxes, so they follow reflow and edits. Ink not over words stays an ordinary ink object.
- Any object can link to a word of a Markdown text (`link: {textId, pos, end, quote}`, `folded`). A folded object is hidden; its word is teal and opens it.
- Nothing new in the note format: these fields ride in the JSON Canvas node's `pn` extension, and the node's `text` is the Markdown (JSON Canvas text nodes are Markdown already).
- New note opens a canvas again. Page notes made with 0003 still open; the type is no longer offered for new notes once the canvas has the two layers.

## Consequences
- Pages grow and fold back, print, export, search, page bitmaps and every tool keep working for Markdown text, since it is an ordinary canvas object.
- Text editing must agree with the measured layout; the editor uses the same styles as the hidden layout copy.
