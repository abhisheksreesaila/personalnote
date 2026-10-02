# F-024 LeaferJS parity and performance scout

Date: 2026-10-01 · Scope: knowledge only, no repo changes · Engine under test: leafer-editor 2.3.0 (published 2026-09-27) vs Fabric 7.4.0 as used in `src/main.js`.
Evidence lives in the scratchpad `f024/` folder: `bench.html` (variant bench), `run.mjs` (headless Chromium + GPU, Vulkan ANGLE, RTX 3090, 1440x1000 @ DPR 2), `final-*.jsonl` (raw results), `worker.html`/`w.js` (worker test), `check.html` (API checks), `sz/` (bundle-size builds), `node_modules/` (2.3.0 sources read for every claim below).

## TL;DR

- Parity: Leafer covers selection, 4-corner transform (size-based, no text distortion), box/shift multi-select, arrow-key nudge, group/ungroup, z-order, lock, in-place text editing (real DOM contenteditable, so IME/spellcheck/paste are native), viewport (wheel/pinch/Space-pan), arrows, PNG/JPG/WebP/JSON export. App code still owns: undo/history, pen + pressure, highlighter, partial eraser, sticky auto-grow, page growth/fold/ghost/lift, connectors-to-model, copy/paste/duplicate, delete key, agent merge, print sheets. **Missing outright: SVG export** (`toSVG` is declared but not implemented in 2.3.0; Fabric has it, the app does not use it today).
- Performance: the dominant cost of the whole-desk pan is **blurred sticky shadows** (GPU-side; 4x slower frames at 5k). Leafer also does **O(N) world-transform work on every pan/zoom even for hidden elements**, so caching only pays when cached content is *detached* from the tree. Recommended defaults (below) take the 5k desk pan from 66.7 to 16.7 ms frames and 15k from 217 to 16.7 ms; zoomed-in editing at 15k drops from 100 to 33 ms. No WebGL path exists in 2.3.0 (Canvas 2D only; "future" in docs). Worker rendering works but does not make frames faster.
- Budget: Leafer piecemeal (render core + editor + text editor + viewport + arrow + export) is 96.1 KiB gz vs Fabric's 87.9 KiB as the app imports it today: +8 KiB, which puts the build at ~238 of 240 KiB *before* adapter code. Proposal: lazy-load the editing plugins (24.4 KiB) and adopt a startup budget.
- Migration: 12 vertical slices (end of report). Biggest risks: small upstream team publishing broken packages (several 2.3.0 plugins shipped with no `dist/`), Chinese-first docs, text-editor IME bug, and the Python side (FTS, CLI append, Markdown export, id repair) also reads Fabric JSON today.

## 1. Feature parity matrix

Legend for Leafer column: **core** = leafer-ui; **official** = `@leafer-in/*` (MIT, same author); **community** = `leafer-x-*`; **app** = we write it; **missing** = not available. Effort: S < 1 day, M 1–3 days, L > 3 days.

| Feature | Fabric today (how) | Leafer 2.3 | Effort | Notes |
|---|---|---|---|---|
| Typed text: multi-line, wrap, font, size, color | `IText` (free text) / `Textbox` (wrap), fonts via `fonts.js`, `refreshCanvasTextMetrics` after font load | core `Text`: `width`+`textWrap`, `fontFamily/Size/Weight`, `italic`, `textDecoration`, `letterSpacing`, `lineHeight`, `padding`, `textOverflow` | S | Same font-load race applies: re-layout after `document.fonts` (Leafer caches text layout per element). |
| Alignment | `textAlign` | core `textAlign`, `verticalAlign`, `autoSizeAlign` | S | |
| Rich text (mixed styles in one box) | not used (no `styles` writes in main.js) | core `Text` is single-style; `HTMLText` (official `@leafer-in/html`) renders HTML but is not editable in place | — | Not needed today; a future "bold one word" ask would be L. |
| IME / composition | Fabric hidden textarea | official text-editor = real `contenteditable` overlay | S + bug | **Bug:** its Enter handler (`TextEditor.ts` onKeydown) ignores `e.isComposing`, so confirming a CJK candidate with Enter inserts a line break. Patch in adapter (capture-phase keydown) or upstream. Also leaves a zero-width space after trailing newlines (the showdown already strips it). |
| Spellcheck | none (Fabric hidden textarea sets `spellcheck="false"`) | contenteditable → browser default spellcheck | S | New capability: squiggles show in the overlay while editing; set `spellcheck` explicitly. |
| Copy/paste of text | native in textarea | native in contenteditable; plain-text paste handler built in | S | |
| Selection + transform handles | Fabric controls (8 + rotate), text uses scale | official `@leafer-in/editor`: 4 corners + edges, rotate by grabbing just outside a corner (or `circle` handle), `editSize: 'size'` default so text boxes resize instead of stretching | S | Captain's preferred look. Hide middle points via `middlePoint`/`point` config. |
| Multi-select (shift, box) | built in | official editor `multipleSelect`, `boxSelect` (on by default) | S | |
| Keyboard nudge | not implemented today | official editor `keyEvent`, `arrowStep` 1, `arrowFastStep` 10 | S | Must not fire while typing (editor disables keyEvent while text editor open). |
| Delete key | app keydown removes active objects | app (editor exposes `list`) | S | |
| Group / ungroup | not used today | official `editor.group()` / `ungroup()` (runtime-checked OK) | S | Needs document-model support for groups. |
| Z-order | `preserveObjectStacking:false` (selection lifts) | official `editor.toTop()/toBottom()`, core `zIndex` | S | |
| Lock | connectors use `lockMovement*` | official `editor.lock()` → core `locked` (checked) | S | |
| Copy/paste/duplicate objects | not implemented today | core `clone()` / `toJSON()`; clipboard is app | M | Must regenerate `semanticId`s and remap connectors. |
| Undo/redo | app: whole-canvas JSON snapshots (`snapshot()`/`restoreHistory`) | missing (no official history plugin) | M | Keep app-side but snapshot the *document model*, not engine JSON; restore by diffing, not by reloading every object (current Fabric `loadFromJSON` reload is O(N)). |
| Pen / ink | Fabric `PencilBrush`, `decimate 0.8`, no pressure | core `Pen`/`Path` API; no brush tool. Community `leafer-x-brush-eraser` 0.2.0 (gesture capture + preview, no pressure) | M | The showdown's app-code pen (one Path updated per coalesced pointer event, smoothing via quadratic midpoints) already feels right. |
| Pressure | none | `PointerEvent.pressure` passed through (`interaction-web`), no variable-width stroke | L | Needs our own variable-width outline (e.g. perfect-freehand-style polygon). Optional; not a Fabric regression. |
| Highlighter | pen with `${color}55` | app (Path with alpha); core `blendMode: 'multiply'` available for a truer marker | S | |
| Eraser (stroke + partial) | app: `splitStrokeAt` splits ink paths by `inkPoints` | app (port as-is; it is engine-independent geometry). Core also has `eraser: 'pixel'` masking | M | Keep vector splitting: pixel erase is lossy and breaks search/export. |
| Stickies, auto-grow | `Sticky` Textbox subclass, padded wrap, min height, own shadow | core `Text` with `padding` + `boxStyle` (fill, radius, shadow) + `autoHeight`; or Rect + Text pair | M | For speed use paper Rect + Text + baked shadow (see §2). `heightRange` gives min height. |
| Shapes | `Rect` rounded | core Rect / Ellipse / Polygon / Star / Line | S | |
| Images: drop, resize | `FabricImage` from data URL (≤1400 px), picker + drop | core `Image` / image fill; editor resizes | S | Data URLs in JSON stay app-side. |
| Image crop | not implemented | community `leafer-x-clip-resize-inner-editor` 1.10 | M | Optional. |
| Connectors following objects | app `Connector` FabricObject + `connectors.js` index by `semanticId` | official `Arrow` (12 end styles) + app index (showdown does this, two-pass read/write). New official `@leafer-in/linker` auto-follows `BoundsEvent.WORLD` of its nodes, **but 2.3.0 was published without `dist/`** | M | Use Arrow + our index now; revisit Linker in a later release. `leafer-x-connector` is 2024/1.x, skip. |
| Page growth / fold / ghost / lift | app: `reconcilePages`, `before:render` tiles, `edge-ghost.js`, `lift.js` | app (pages as a background group or a `ground` layer; ghost/lift in the sky layer) | M | Logic in `navigation.js`/`edge-ghost.js` is pure and ports. |
| Snapping / guides | none | community `leafer-x-easy-snap` 1.11 (Nov 2025) or `leafer-x-snap` 1.0.7 | S–M | New capability; verify against 2.3 before adopting. |
| Zoom / pan / hand / Space-pan / pinch | app on `viewportTransform` (`viewport.js`, keyboard-pan, temporary hand, middle drag, touch pinch) | official viewport (`tree.type: 'design'`): wheel, ctrl-wheel, pinch, Space/middle drag; zoom limits | S | Keep our tool-switch rules (F-017); disable Leafer's Space handling if it conflicts. |
| Minimap / scroll indicator | app DOM (`navigation.js`) | official `@leafer-in/scroll` scrollbars, or keep app | S | Keep ours. |
| Hit-testing ink by stroke | `perPixelTargetFind` off; path bounds | core hit test on path geometry (`hitStroke: 'path'`, `hitRadius` for fat-finger) | S | Better than today. |
| Prettify | pure text function on selection | app (unchanged; uses text-editor DOM selection instead of Fabric selectionStart/End) | S | |
| Mind-map notes | separate lazy SVG module | unaffected | 0 | Only the shell's `noteType` switch touches the canvas. |
| Export PNG | print: `StaticCanvas` + `toDataURL` per page | official export: `export('png', { screenshot: bounds, pixelRatio })` per page region | S | Async; works offscreen. |
| Export SVG | not used | **missing** (`toSVG` declared, unimplemented; export('svg') returns error) | L if wanted | Only matters if a future ticket asks for SVG. |
| Print | page PNGs into print sheets | same via export | S | Print CSS unchanged. |
| Agent sync (merge by semanticId) | `mergeRemoteAppends` + `util.enlivenObjects` | app: same merge on the document model, then adapter `add()` | M | Easier once the model is engine-free. |
| Save / load | `canvas.toJSON()` stored in `notes.content` | app document model (ADR 0001) | L | Python FTS (`note_text.py`), CLI append (`services.py` writes a Fabric `Textbox`), id repair (`services.py` Connector remap) and Markdown image export (`portability.py` reads `src`) all read Fabric JSON today and must move with it. |
| Touch / pencil on phones | app pinch + finger pan off-page, touch draws on page | viewport handles pinch; pointer events carry `pointerType`/`pressure` | M | Re-verify palm/finger rules on device. |
| Accessibility | none (canvas) | none (canvas) | M | Same as today; a hidden DOM outline of text blocks would be new work. |

## 2. Performance on the Engine Showdown scene

Setup: scene generator copied from the showdown (`makeScene`: 37% labels, 21% stickies, 16% shapes, 26% ink, 10% connectors, 12 pages). Note the density: 15k objects is ~1,250 per page and 50k is ~4,200 per page, far beyond the 600-object benchmark note. Phases, each ~1.4–1.8 s driven per animation frame: **pan** (whole desk at fit zoom), **zoom** (fit → 5x → fit), **pan1** (pan at 100% around the busiest object), **hub** (drag the most-connected object). Numbers are median frame times in ms (p95s are in the raw `final-*.jsonl`) (16.7 = 60 fps; frames are vsync-quantised). "draw" is CPU time in Leafer's render call; the gap between draw and frame time is GPU rasterisation of the 2D canvas.

Variants (each alone, then combined):
- `noshadow`: stickies as paper Rect + Text with no shadow (lower bound).
- `bakedshadow`: one pre-rendered shadow image, stretched under each sticky (no live blur).
- `textlod`: below 60% zoom hide text, arrows and shadows (one `visible` toggle per page sub-group).
- `bitmap+detach`: per-page bitmap (Leafer `Canvas` element, drawn once with `canvas.draw(pageGroup)`) shown below 60% zoom; the vector page groups are **removed** from the tree, not hidden.
- `pr1`: pixelRatio 1 instead of 2 (upper bound of "reduce pixel ratio while panning").
- `layers`: the dragged object and its arrows move to a separate Leafer layer for the drag.
- `cull`: page groups outside the viewport (+200 px) are detached.
- `nohit`: `hitChildren: false` on page groups (affects hit testing only; no render change, measured equal to base).

| Variant | 5k pan · zoom · pan@100% · drag | 15k | 50k |
|---|---|---|---|
| Baseline (showdown config: Text + boxStyle blur shadow) | 67 · 17 · 17 · 17 | 217 · 33 · 100 · 17 | 683 · 117 · 467 · 83 |
| No sticky shadow (lower bound) | 17 · 17 · 17 · 17 | 50 · 33 · 33 · 17 | 283 · 100 · 100 · 17 |
| Baked shadow image | 17 · 17 · 17 · 17 | 83 · 33 · 50 · 17 | 350 · 117 · 133 · 17 |
| Text/arrow/shadow LOD < 60% | 67 · 17 · 17 · 17 | 200 · 33 · 83 · 17 | 117 · 133 · 383 · 83 |
| Page bitmaps < 60%, vectors detached | 17 · 17 · 17 · 17 | 17 · 33 · 100 · 17 | 17 · 117 · 217 · 83 |
| pixelRatio 1 (vs 2) | 50 · 17 · 17 · 17 | 183 · 33 · 83 · 17 | 383 · 83 · 167 · 67 |
| Active layer for dragged object | 67 · 17 · 17 · 17 | 216 · 33 · 100 · 17 | 683 · 100 · 467 · 17 |
| Detach off-screen pages | 67 · 17 · 17 · 17 | 217 · 33 · 100 · 17 | 683 · 100 · 217 · 83 |
| Baked shadow + text LOD + cull | 17 · 17 · 17 · 17 | 33 · 33 · 33 · 17 | 117 · 83 · 83 · 17 |
| **Recommended: baked shadow + text LOD + page bitmaps + drag layer + cull** | 17 · 17 · 17 · 17 | 17 · 33 · 33 · 17 | 17 · 67 · 83 · 17 |
| Recommended + pixelRatio 1 | 17 · 17 · 17 · 17 | 17 · 17 · 33 · 17 | 17 · 50 · 100 · 17 |

| CPU draw ms (median) for the same rows | 5k | 15k | 50k |
|---|---|---|---|
| Baseline (showdown config: Text + boxStyle blur shadow) | 13 · 3.8 · 3.6 · 1.2 | 55 · 13 · 21 · 3.7 | 673 · 59 · 102 · 11 |
| No sticky shadow (lower bound) | 8.3 · 3.4 · 3.7 · 1.2 | 51 · 17 · 23 · 2.9 | 272 · 58 · 103 · 8.7 |
| Baked shadow image | 12 · 4.5 · 4.0 · 1.4 | 64 · 18 · 27 · 3.3 | 396 · 67 · 123 · 13 |
| Text/arrow/shadow LOD < 60% | 7.9 · 4.4 · 3.6 · 1.4 | 30 · 16 · 23 · 3.1 | 821 · 74 · 106 · 15 |
| Page bitmaps < 60%, vectors detached | 0.2 · 4.0 · 4.3 · 1.3 | 0.2 · 15 · 24 · 3.4 | 0.2 · 78 · 80 · 13 |
| pixelRatio 1 (vs 2) | 11 · 2.5 · 3.5 · 1.2 | 57 · 14 · 23 · 3.4 | 554 · 58 · 72 · 11 |
| Active layer for dragged object | 13 · 3.7 · 3.5 · 0.1 | 60 · 15 · 21 · 0.2 | 673 · 58 · 109 · 0.2 |
| Detach off-screen pages | 12 · 1.6 · 2.4 · 1.2 | 60 · 4.7 · 17 · 3.5 | 664 · 18 · 43 · 12 |
| Baked shadow + text LOD + cull | 5.4 · 1.4 · 2.7 · 1.4 | 23 · 5.7 · 18 · 3.8 | 99 · 21 · 45 · 11 |
| Recommended | 0.2 · 2.1 · 3.2 · 0.2 | 0.2 · 6.3 · 22 · 0.1 | 0.2 · 22 · 59 · 0.2 |
| Recommended + pixelRatio 1 | 0.2 · 2.7 · 3.4 · 0.2 | 0.2 · 4.7 · 19 · 0.1 | 0.2 · 22 · 77 · 0.2 |

Build / first draw / heap: 5k 269 / 32 ms / 43 MB; 15k 664 / 131 ms / 66 MB; 50k 2061 / 334 ms / 231 MB. Page-bitmap creation: 5k 54 ms, 15k 141 ms, 50k 456 ms. LOD switch: 1–14 ms.

Worker rendering (`@leafer/worker`, scene rendered into an OffscreenCanvas in a Web Worker, each frame handed to the page as an ImageBitmap; pan sweep): frame interval 24 ms at 5k, 83 ms at 5k with blur shadows, 86 ms at 15k, 625 ms at 50k; main-thread cost under 2 ms per frame. Worker render time equals main-thread render time.

Caveat: 50k rows get only 2–15 frames per phase, so treat them as order-of-magnitude (the 50k text-LOD pan row is noise).

### Findings

1. **Blurred sticky shadows are the biggest single cost.** At 5k the whole-desk pan is 67 ms per frame with them and 17 ms without, even though CPU draw time barely changes (13 vs 8 ms): the blur is paid by the GPU rasteriser. Leafer's "fast shadow" path (native `shadowBlur`) still blurs every sticky every frame. A baked shadow image gets the same look at 17 ms (5k) and halves the cost at 15k. **Default: bake the sticky shadow** (one shared image, or 9-slice it for odd sizes) and keep live blur only for the lifted (dragged) object.
2. **Leafer does O(N) work on every pan/zoom, even for hidden elements.** Hiding page groups (`visible = false`) behind bitmaps left pan draw at 4.9 ms at 15k. Removing them from the tree took it to 0.2 ms. Changing the zoom layer's `x/y/scale` updates the world matrix of every attached element. So any cache only helps if the cached content is **detached**. This holds for culling too: detaching off-screen pages cut zoomed-in draw time by 3x at 50k.
3. **Page bitmaps make whole-desk panning flat.** Below 60% zoom, show one Leafer `Canvas` element per page, drawn once from the page's vector group (`canvas.draw(pageGroup)`), and detach the vectors. The pan then costs 0.2 ms CPU and 16.7 ms frames at 5k, 15k and 50k. Costs: build time of 54/141/456 ms at 5k/15k/50k, so do it page by page when idle and redo only the edited page; about 5 MB per page at 1.2 device px per world unit, so cap how many pages keep bitmaps and drop the resolution for far-out views. Content that crosses a page edge is clipped in the bitmap, so draw each page with a bleed margin.
4. **Text LOD** (hide text, arrows and shadows below 60%) halves CPU draw time. It only shows in frame time once shadows are gone. It is useful when page bitmaps are not ready yet.
5. **Active layer for dragging** moves the dragged object and its arrows to their own Leafer layer. That brings drag draw time to 0.1–0.2 ms at every size and keeps 50k drags at 60 fps (83 ms frames before). It is cheap to build: move nodes on drag start and move them back on drop.
6. **pixelRatio 1 while panning** gains little (67→50 ms at 5k, 683→383 ms at 50k) and visibly blurs on retina. Changing pixelRatio also resizes the canvas. **Not recommended** as a default. Once bitmaps exist it adds nothing for desk pans.
7. **`hitChildren`/`hittable`** do not change render cost. Set them anyway (pages, arrows and shadows not hittable) for hit-test speed.
8. **Leafer has no per-element bitmap cache** in 2.3.0, despite the `cache` option named in the ticket. Grep of the sources found no `cache` attribute. The only caches are text layout, image LOD (`Platform.image.maxCacheSize`) and partial (dirty-region) rendering. `useCellRender` is a stub (`getCellList()` returns undefined). Page bitmaps (point 3) are our cache.
9. **Worker rendering works but is not faster.** The 2.3.0 `@leafer/worker` bundle crashes on load in a real worker: the new `bg-runner` plugin touches `document` and `window`. It needed two stubs (`f024/w.js`, first lines). After that, a worker renders the same scene in the same time as the main thread (10 ms at 5k, 48 ms at 15k, 296 ms at 50k without shadows). It only keeps the main thread free (under 2 ms per frame). The editor, text editor and hit testing need the DOM, so only a static layer could live there. **Verdict:** possible later for building page bitmaps off the main thread; not a rendering mode.
10. **No GPU path.** The 2.3.0 sources and bundles contain no WebGL or WebGPU (only `getContext('2d')`). The docs say the renderer is pluggable for "future support for WebGL, WebGPU, Skia" ([install/core](https://www.leaferjs.com/ui/en/guide/install/ui/core/)). There is no published roadmap date. The GPU still helps implicitly: Chrome's accelerated 2D canvas composites the page bitmaps.
11. **A PixiJS hybrid is plausible but not worth it.** Pixi would only add value as a static far-away background. Page bitmaps inside Leafer already give 16.7 ms desk pans at 50k with no second engine. Pixi v8 would add up to 219 KiB gz (full CDN build; less tree-shaken) and a second scene graph to keep in sync. Keep Pixi as the ADR's fallback for notes far beyond 15k objects per view.
12. **Remaining hot spot: zoomed-in work on a dense page.** At 15k (1,250 objects per page) pan at 100% is 33 ms with everything on; at 50k it is 83 ms. Real notes are far sparser: the F-002 benchmark note has about 50 objects per page, where every variant is at 60 fps. If dense pages matter, the next step is sub-page tiles (the same bitmap idea at 100% zoom, rebuilt per tile on edit).

**Recommended defaults:** stickies drawn as paper Rect + Text with a baked shadow (no live blur except while lifted); pages as `Group`s with `hittable: false` on decoration; off-screen pages detached; page bitmaps (detached vectors) below 60% zoom, rebuilt per page when idle after an edit; text/arrow LOD below 60% only until a page's bitmap is ready; a separate active layer for drag/transform; pixelRatio = device (max 2); no worker.

## 3. Core budget

Measured with esbuild (minified ESM, gzip -9; `f024/sz/`):

| Bundle | gzip |
|---|---|
| Fabric 7.4, only the classes `main.js` imports today | 87.9 KiB |
| `leafer-editor` full (everything in the CDN build) | 101.4 KiB |
| Leafer piecemeal: `leafer-ui` + editor + text-editor + viewport + arrow + export | 96.1 KiB |
| Leafer render core only (`leafer-ui` + viewport) | 73.1 KiB |
| Editing plugins only (editor 16.1 + text-editor 2.5 + arrow 2.7 + export 2.1 KiB, sharing core) | 24.4 KiB |

Piecemeal import works: every package ships ESM (`exports.import`). Tree-shaking saves little because plugins register themselves as side effects and the packages do not declare `sideEffects: false`. The gain over the full bundle is about 5 KiB (drops scroll, find, view, html, scale-fixed).

Today's build: 229.8 KiB gz total JS (main chunk 210 KiB) against the 240 KiB budget in `scripts/check-performance-budget.mjs`. Swapping Fabric for piecemeal Leafer adds 8.2 KiB, giving about 238 KiB *before* the adapter, document model and converter (estimate 8–12 KiB gz). Removing `sticky-object.js`, `connector-object.js` and Fabric-specific glue gives back 2–4 KiB. **Net: about 245 KiB, just over budget.**

Proposal:
- Split the budget. A **core startup budget** covers the main chunk plus static imports: **≤ 205 KiB gz**. Leafer's render core (73 KiB) loads at startup, so a note is visible and pannable at once. The editing plugins (24 KiB) are a separate chunk, preloaded when idle and awaited on first pointer-down or keypress on the canvas. Keep the aggregate budget at 240 KiB for the steady state. Allow a temporary aggregate of **330 KiB while both engines ship behind the flag** (Leafer adapter as a lazy chunk), and remove that allowance in the "remove Fabric" slice.
- Add the startup check to `npm run benchmark:bundle` (sum of the entry chunk and its static imports).

## 4. Migration plan (vertical slices)

Each slice ships on its own behind `?engine=leafer` (or a Settings toggle) until P-11. Fabric stays the default until P-11.

- **P-01 Engine-independent document model (no UI change).** `src/core/document/` holds plain JS types (`text`, `sticky`, `shape`, `ink`, `image`, `connector`, `group`), page state and a `schemaVersion`. A pure `fromFabric(json)` and `toFabric(doc)` round-trip. Checks: round-trip is deep-equal on fixtures that cover every type, including highlighter alpha, ink dots (`Circle isInk`), split ink fragments with `inkPoints`, stickies with `stickyColor`, images as data URLs, connectors with `reverseX/Y`, duplicate and missing `semanticId`s, the F-002 600-object benchmark note and a CLI-appended `Textbox`. Python mirror in `document_model.py` with the same fixtures.
- **P-02 Storage switch with originals kept.** New column `content_format` (`fabric` | `doc1`) plus `content_fabric_backup`. A one-time idempotent migration converts on read and writes `doc1` in the same transaction. Original bytes stay until a later explicit cleanup. `note_text.py`, FTS indexing, the CLI append, the `services.py` id repair and `portability.py` image extraction read `doc1`. Backup JSON gets a format version and import accepts both. Checks: migrating a copy of a real-shaped DB twice is a no-op; search results are identical before and after; the export/import round-trip is lossless; no note is ever rewritten if conversion fails (logged, left as `fabric`).
- **P-03 Leafer adapter, read-only render behind the flag.** `src/modules/canvas-leafer/` turns the document into Leafer nodes with page groups, baked sticky shadows, page tiles, fold lines, page labels and the dotted desk. Pan/zoom/hand/Space/middle-drag/pinch use our `viewport.js` rules. Checks: screenshot parity against Fabric on 5 fixtures in 3 skins (pixel diff within tolerance); opening view and minimap match; bundle checks pass with Leafer as a lazy chunk.
- **P-04 Select, move, transform, delete, z-order, lock, nudge.** Editor config: 4 corners, rotate handle, `editSize: 'size'`, box and shift select, arrow keys. Edits write back to the document model and save through the existing queue. Checks: transform round-trips through save/reload; text never stretches; Delete removes and connectors go with it; no key fires while typing.
- **P-05 Text and stickies editing.** Text editor overlay with fonts, size, colour, alignment, prettify on selection, monospace default, sticky auto-grow and min height, the IME Enter fix and zero-width-space cleanup. Checks: Japanese/Chinese IME composition commits without a stray newline (Playwright `insertText` plus a composition event test); spellcheck is on; paste is plain text; voice transcript insertion works.
- **P-06 Undo/redo on the document model.** Operation or patch history replaces whole-canvas JSON. F-013 undo for Clear all and Delete note still works. F-008's "undo after agent merge keeps agent text" is folded in. Checks: 100 alternating edits undo and redo to identical documents; undo on a 600-object note stays under 16 ms.
- **P-07 Pen, highlighter, eraser.** App-code pen (coalesced events, quadratic smoothing, decimation), highlighter alpha (optionally multiply), port of the vector split eraser, ink dots. Checks: the stroke follows the pointer with no lag at 600 objects; erasing through a stroke yields two fragments that save and undo; pressure is ignored (left for a later ticket).
- **P-08 Pages, connectors, drag lift and ghost.** Page growth/fold on drop, ghost "+ Page N" and lift in the sky layer, connectors as `Arrow`s driven by our index (two-pass read/write), active drag layer. Checks: F-005 checks pass on Leafer; dragging the most-connected object on the 600-object note runs at 60 fps.
- **P-09 Images, export, print.** Drop/picker images (≤1400 px), PNG export per page with `export('png', { screenshot })`, print preview unchanged. Checks: print sheets match Fabric output; Markdown ZIP images unchanged.
- **P-10 Performance pass and agent sync.** Page bitmaps with detach, culling, text LOD, the flag cursor placed once per frame (F-008), merge of agent appends by `semanticId` on the model. Checks: the 5k desk pans at 60 fps on the captain's Mac (retina); the 15k desk pans at 60 fps at fit; agent text appears without duplicates.
- **P-11 Phones and pencil, then default flip.** Touch rules (finger pans off-page, pen or touch draws on page, pinch), soft keyboard with the text overlay, Apple Pencil `pointerType: 'pen'`. Then Leafer becomes the default, with Fabric still reachable by flag for one release. Checks: phone-width checks from F-012/F-016; the captain uses it for a week.
- **P-12 Remove Fabric.** Delete the Fabric code, `sticky-object.js`/`connector-object.js`, the flag and the dual-engine budget allowance. Update AGENTS.md invariant 2 and ARCHITECTURE.md. Checks: aggregate JS ≤ 240 KiB and startup ≤ 205 KiB; `npm run test:ui` and API tests are green; no `fabric` import remains.

## 5. Risks and what could change the decision

- **Upstream packaging quality.** Six `@leafer-in` 2.3.0 packages were published with no `dist/` (`linker`, `bg-runner`, `motion-text`, `stroke-sides`, `transition`, `interface`), so they cannot be imported from npm. The `@leafer/worker` 2.3.0 bundle crashes in a real worker. 2.3.0 is four days old. **Pin 2.2.11 or 2.3.0 exactly, vendor nothing, and run a smoke test on every upgrade.** The core editor path (leafer-ui, editor, text-editor, viewport, arrow, export) works.
- **Small team and Chinese-first docs.** One maintainer (Chao Wan) owns most of the code; English docs are partial and some pages refuse automated fetch. The adapter must stay thin, and the model must stay engine-free (ADR 0001) so a move to Pixi or back stays possible.
- **Text editor maturity.** The editor is a plain contenteditable overlay with an IME Enter bug, zero-width-space leftovers and a global `window` keydown listener. Expect a fork or patch of `TextEditor` (about 230 lines, MIT). Rich text later would mean `HTMLText`, which cannot be edited in place.
- **Python coupling.** FTS, the CLI, id repair and the Markdown export all parse Fabric JSON. P-02 is the riskiest slice because it touches the live DB. It must be transactional, idempotent and keep the originals.
- **Measured in headless Chromium on Linux with an RTX 3090.** The captain's Mac (WebKit in the desktop app, F-011) will be slower and WebKit's canvas differs. **Re-run `f024/bench.html` in the desktop window before P-10.** Fabric-era retina checks from F-002/F-009 also remain open.
- **What could change the decision:** if the Mac re-run shows the recommended configuration still under 30 fps for the captain's real notes at fit zoom, or if WebKit's contenteditable overlay misbehaves in the native window. Then the ADR's PixiJS fallback (with a DOM text overlay, 14–18 weeks) comes back on the table. Conversely, Leafer shipping a WebGL renderer would remove most of the caching work. Nothing found here contradicts the captain's choice for notes up to 15k objects.
