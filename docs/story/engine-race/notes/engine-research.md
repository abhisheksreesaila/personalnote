# Canvas engine research: PixiJS v8 vs. batteries-included alternatives

Date: 2026-10-01. Sources: npm registry (`npm view`), GitHub API (`gh api repos/...`), official docs.
Bundle sizes from bundlephobia (full package, min+gz, before tree-shaking). "Unverified" = not confirmed from a primary source.

## 0. What Personal Note's canvas does today (Fabric 7.4)

Typed text (Textbox/IText, fonts, prettify), stickies (`Sticky` Textbox subclass), rounded-rect shapes,
images (data URLs, 1400 px cap), ink (PencilBrush, highlighter, eraser), connectors/arrows attached to objects
(`connector-object.js`, `connectors.js`), selection + resize/rotate + multi-select, undo/redo (`history.js`),
snapping, pan/zoom via `viewportTransform`, page tiles/fold lines/"Page N" painted in `before:render`, page growth,
edge ghost, drag lift, minimap, print (`window.print` of the canvas), Fabric-JSON persistence with FTS from text.
Mind maps are a separate lazy SVG module and are **not affected** by an engine change.

## 1. PixiJS v8 ecosystem, battery by battery

PixiJS itself: v8.22.0 released 2026-10-01, 48k stars, MIT, very active (monthly minors). Full package
~261 KB gz (bundlephobia, untree-shaken; a tree-shaken v8 app is smaller - exact figure unverified).
Recent relevant additions: experimental Canvas renderer (8.16/8.18), Graphics-to-SVG export (8.18),
tagged/styled text runs (8.16/8.18), SplitText, HTML-in-canvas `HTMLSource` (8.19).

| Battery | Library | Status for v8 | Verdict |
|---|---|---|---|
| (a) Pan/zoom/culling viewport | [pixi-viewport](https://github.com/pixijs-userland/pixi-viewport) 6.0.3 | peer `pixi.js >=8`; last release 2024-11-27, last commit 2025-02; 1.2k stars, 144 open issues | Works, but **coasting** (no release in ~2 yrs). Small enough to fork. Pixi v8 also has built-in `Culler`/`cullable` for offscreen culling. |
| (b) Selection + transform handles | [@pixi-essentials/transformer](https://github.com/ShukantPal/pixi-essentials) 3.0.4 | **v7 only** (peer `@pixi/core ^7`), last release 2023-10. Repo ported other packages to v8 (2024-10) but not transformer; [issue #105](https://github.com/ShukantPal/pixi-essentials/issues/105) "v8 support for Transformer?" still open | **No maintained v8 transformer.** `@quinninc/pixi-transformer` 0.1.8 (peer `pixi.js ^8.2.1`, 2026-01) exists but its GitHub repo returns 404 and maturity is unknown - treat as unusable (unverified). Must hand-build (or port the v7 transformer). |
| (c) Editable text (cursor, selection, IME, multiline) | [@pixi/ui](https://github.com/pixijs/ui) 2.4.1 `Input` | Official, active (2026-10-01). Hidden native `<input>` with composition (IME) handling - **single-line only** (`hiddenField.ts` creates `<input>`, not `<textarea>`) | Not enough for note text. `pixi-text-input` 1.2.1 is pixi v4-era. Standard approach: **DOM overlay** (`<textarea>`/contentEditable positioned over the object while editing, Pixi draws it otherwise). No library packages that overlay for Pixi - hand-build. |
| (d) Freehand ink | [perfect-freehand](https://github.com/steveruizok/perfect-freehand) 1.2.3 | Renderer-agnostic, 5.7k stars, MIT, ~2 KB gz, release 2026-02 | Use it: points -> outline polygon -> Pixi `Graphics.poly().fill()`. Highlighter = alpha/blend mode. Eraser hit-testing is ours. |
| (e) Hit testing / spatial index | [rbush](https://github.com/mourner/rbush) 4.0.1 (2.3 KB gz) or [flatbush](https://www.npmjs.com/package/flatbush) 4.6.2 (static) | Engine-agnostic, MIT, maintained | Use rbush (dynamic inserts/removes). Pixi's federated events do per-object hit tests; fine for clicks, but marquee/eraser/connector-snap queries want rbush. |
| (f) Serialization | none | Pixi has no scene serializer (confirmed: no toJSON/fromJSON in v8 API; `Graphics`->SVG export only) | Must own the document model (we should anyway, see section 4). |
| (g) Connectors/arrows | none for Pixi | No maintained Pixi connector lib found | Hand-build. Our current `connectors.js` geometry is largely engine-independent and ports. |
| (h) Crisp text at zoom | Pixi `Text`, `HTMLText`, `BitmapText` | `BitmapText` supports MSDF/SDF fonts ([docs](https://pixijs.com/8.x/guides/components/scene-objects/text/bitmap)) - sharp at any scale, very fast | **Caveat for a notes app:** MSDF needs pre-generated atlases per font (AssetPack/msdf-bmfont), weak for emoji/CJK/arbitrary user fonts. `Text` is canvas-rasterized to a texture: blurry when zoomed unless we re-rasterize at the new resolution (cost scales with text count). Plan: `Text` with resolution bumped on zoom-settle + debounced re-raster for visible objects only. Hand-built policy. |

Net: Pixi gives fast rendering, events, culling, ink and spatial index via libs. **Transformer, rich text
editing, connectors, serialization, undo, snapping, print/export are all ours.**

## 2. Alternative engines

| Engine | Renderer | Perf claims | Built-in editing | License | Current / last release | Size (gz) | Notes |
|---|---|---|---|---|---|---|---|
| **PixiJS v8** + libs | WebGL2 / WebGPU (Canvas experimental) | Captain's test: 60 fps @ 5k objects; Bunnymark 100k sprites | None (see section 1) | MIT | 8.22.0, 2026-10-01 | ~261 KB full | GPU-fast; editor batteries missing |
| **[LeaferJS](https://www.leaferjs.com/en/)** (`leafer-ui` + [`leafer-in`](https://github.com/leaferjs/leafer-in)) | **Canvas 2D** (pluggable; no WebGL renderer shipped - repo has no WebGL code) | Own benchmark: 1M rects created in 1.28 s, 0.32 GB, 60 fps single-drag @1M; **pan 55 fps / zoom 16 fps @100k** (Pixi 17 / 13 in their test, default config) | Editor (move/scale/rotate/skew, multi-select, box select, group, lock), text-editor (contentEditable DOM overlay, verified in source), viewport, scroll, arrow (12 heads), export (PNG/JPG/SVG/JSON), find, state, html, flow layout. Plugin `linker` exists but its README is empty; connector is a community plugin | MIT (commercial "PxGrow" pro suites exist) | 2.3.0, 2026-09-27 | ~70 KB core (vendor figure; editor plugins extra) | Most batteries; dirty-rect partial rendering explains drag numbers. Docs mostly Chinese, small team, `leafer-in` repo 29 stars. Undo/history plugin: not found among official plugins (unverified). |
| **[Konva](https://konvajs.org)** | Canvas 2D (layer per canvas) | No big-scene claims; perf guide relies on caching, `listening(false)`, manual culling | Transformer (resize/rotate/multi), drag, events, toJSON. Text editing = DIY textarea overlay (documented demo) | MIT | 10.7.0, 2026-09-23, 14.8k stars | ~55 KB | Same performance class as Fabric; no speed win. |
| **[tldraw SDK](https://tldraw.dev)** | DOM/SVG shapes (React) | Culling via `display:none`; default **maxShapesPerPage 4,000** (configurable to 10k); zoom debounced >500 shapes | Everything (selection, text, arrows, ink, undo, multiplayer) | **Proprietary**: license key required in production; free only for dev/localhost, non-commercial hobby license by application, commercial from **~$6,000/yr** (third-party report), 100-day trial; may transmit usage data | 5.5.0, 2026-09-30, 50.7k stars | ~530 KB | Needs React (against house stack), paid, shape cap below the 5k target. Ruled out. |
| **[Excalidraw](https://github.com/excalidraw/excalidraw)** | Canvas 2D (rough.js style) | No large-scene claims | Full whiteboard app as a React component | MIT | 0.18.1, 2026-04-20, 133k stars | ~353 KB | An app, not an engine; hand-drawn look, React. Not a fit. |
| **[@antv/g](https://github.com/antvis/G)** | Canvas 2D / SVG / **WebGL / WebGPU**, switchable | Culling + dirty rects; no published editor-scale numbers found | Plugins: dragndrop, annotation (selection/transform - details unverified), yoga layout, rough; text editing plugin claimed on site (unverified) | MIT | 6.3.1, 2025-12-24; last commit 2026-03 | unverified | Viz-oriented; maintenance slowing (no release in 9 months). Risky. |
| **[Two.js](https://github.com/jonobr1/two.js)** | SVG / Canvas / WebGL | none for editors | None (drawing API only) | MIT | 0.8.24, 2026-08-29, 8.7k stars | ~49 KB | No editing batteries; WebGL renderer is secondary. |
| **[Pencil.js](https://github.com/pencil-js/pencil.js)** | Canvas 2D | none | Basic draggable/resizable components | MIT | 3.2.0, 2024-09 (stale), 288 stars | unverified | Stale. Ruled out. |
| **[Graphite](https://github.com/GraphiteEditor/Graphite)** | Rust/WASM, own renderer (Vello) | n/a | Full editor app | Apache-2.0 | active, 27k stars | n/a | An application, not an embeddable JS library. Ruled out. |
| **Fabric.js** (today) | Canvas 2D | Captain: ~30 fps with stutters @5k | Everything we use | MIT | 7.4.0, 31k stars | ~92 KB | Baseline. |

Honest reading of the benchmarks:
- The only GPU engine with editor batteries is @antv/g, and it is viz-focused and slowing down.
- Leafer is **not GPU**. Its headline numbers come from cheap object creation and dirty-region redraws (drag
  of one item). Full-scene redraws (pan/zoom) are still Canvas 2D bound: its own table shows 16 fps zoom at
  100k. At 5k objects it is probably fine, but **nobody has measured it on our scene** (unverified).
- The captain's Pixi-vs-Fabric test is real, but Fabric may have been at defaults. Fabric settings like
  `skipOffscreen`, `objectCaching`, `renderOnAddRemove:false`, and caching static page tiles can narrow the gap
  (size of the gain unverified for our note). Also, a 5k test with rectangles flatters Pixi; 5k **text**
  objects in Pixi each need a texture and re-rasterization on zoom, which is where Pixi slows down.

## 3. Effort to reach parity with today's canvas (one focused developer)

### (a) PixiJS v8 + libraries: ~14-18 weeks

| Work item | Library help | Hand-built | Weeks |
|---|---|---|---|
| Engine-independent document model + Fabric->model migration + save/load/FTS extraction | - | all | 1.5-2 |
| Scene sync (model -> Pixi display objects, diffing, z-order) | Pixi | sync layer | 1 |
| Viewport pan/zoom, culling, keyboard pan, zoom steps, minimap, page tiles/folds/labels, page growth, edge ghost | pixi-viewport, Pixi Culler | desk painting, glue | 1-1.5 |
| Selection, marquee, multi-select, resize/rotate handles, lift on drag, snapping | rbush | **transformer + snapping** | 2.5-3 |
| Text and stickies: render, wrap, fonts, DOM-overlay editing (caret, selection, IME, multiline), prettify hookup, crisp-at-zoom re-raster policy | Pixi Text/HTMLText | **overlay editor, measurement parity DOM vs Pixi** | 2.5-3 |
| Ink, highlighter, eraser (pressure, smoothing, partial erase) | perfect-freehand, rbush | eraser | 1-1.5 |
| Shapes, images (texture loading, sizing, drop/picker) | Pixi | glue | 0.5-1 |
| Connectors/arrows attached to objects, re-route on move | - | port `connectors.js` geometry, render | 1 |
| Undo/redo on model commands | - | command history | 0.5-1 |
| Print and export (SVG/PNG/PDF-by-print), screen-only theme vs saved appearance | Pixi `extract`, Graphics->SVG | **SVG export from model** | 1-1.5 |
| Tests, benchmarks (5k mixed scene), touch/pen input, desktop-app (pywebview/WebKit WebGL) checks, polish | - | - | 2 |

### (b) Best alternative, LeaferJS: ~8-11 weeks (if it passes the perf spike)

Built in: viewport/zoom, editor (handles, multi-select, group, lock), in-place text editor (DOM overlay),
arrow heads, PNG/SVG export, JSON export. Still hand-built: document model + migration (1.5-2), model<->Leafer
sync (1), stickies/fonts/prettify on top of its text editor (1), ink via perfect-freehand + eraser (1-1.5),
connectors (community plugin or port ours, 1), undo/redo (0.5-1, no official plugin found), snapping (community
plugin or ours, 0.5), page tiles/desk/minimap/ghost/lift (1), print/export fit (0.5-1), tests/polish (1.5-2).
Risks: Chinese-first docs, small maintainer team, Canvas 2D ceiling on full redraws, editor UX may need heavy
restyling to match our chrome.

## 4. Storage: own the document model (yes, for every option)

Store our own versioned, engine-independent JSON in `notes.content`, not Fabric/Pixi/Leafer JSON. Reasons:
engine swaps become a renderer change, not a data migration; backup/import/export (`portability.py`) and FTS
read stable fields; the CLI and agents can read/write notes without an engine; invariant 6 (lossless versioned
backup) is easier to keep. Mind maps already work this way (normalized map JSON).

Outline (canvas note):

```json
{
  "schema": "personal-note/canvas", "version": 2,
  "pages": { "columns": 1, "rows": 3, "size": { "w": 816, "h": 1056 } },
  "objects": [
    { "id": "o_01", "type": "text",   "x": 80, "y": 120, "w": 420, "h": 0, "rotation": 0, "z": 10,
      "text": "Plain text with \n newlines", "style": { "font": "Inter", "size": 18, "color": "#222",
      "weight": 400, "italic": false, "align": "left", "lineHeight": 1.3 } },
    { "id": "o_02", "type": "sticky", "x": 520, "y": 120, "w": 200, "h": 200, "rotation": -2, "z": 11,
      "text": "Call Sam", "color": "c3", "style": { "font": "Inter", "size": 16 } },
    { "id": "o_03", "type": "shape",  "kind": "rect", "x": 60, "y": 400, "w": 240, "h": 120, "z": 5,
      "radius": 12, "fill": "c2", "stroke": { "color": "#333", "width": 2 } },
    { "id": "o_04", "type": "image",  "x": 320, "y": 400, "w": 300, "h": 200, "z": 6,
      "asset": "sha256:...", "natural": { "w": 1400, "h": 933 } },
    { "id": "o_05", "type": "ink",    "tool": "pen", "color": "#1a1a1a", "size": 3, "z": 20,
      "points": [[12.5, 40.1, 0.5], [13.0, 41.2, 0.55]], "origin": { "x": 100, "y": 700 },
      "freehand": { "thinning": 0.5, "smoothing": 0.5 } },
    { "id": "o_06", "type": "connector", "z": 4,
      "from": { "object": "o_02", "anchor": "auto" }, "to": { "object": "o_03", "anchor": "auto" },
      "route": "straight", "heads": { "start": "none", "end": "arrow" }, "stroke": { "color": "#333", "width": 2 } }
  ]
}
```

Rules: colors are palette keys (`c1..c5`) or hex so skins keep working; ink stores raw points (not the
outline) so smoothing can change; images reference an asset (data URL inline in v1 or a separate `assets`
table keyed by hash - decide separately; backups must include them); ids are stable for connectors, undo and
future sync; FTS indexes `text` of text/sticky objects. Write a one-time, tested Fabric-JSON -> v2 converter
run on load (keep the original in backup until verified). This step is worth doing **first, on Fabric**, since
it is needed by every option and de-risks the switch.

## 5. Recommendation

1. **Do the engine-independent document model now, on Fabric** (about 2 weeks). It is required by every path,
   makes the engine swappable, and lets the next decision be made on data rather than a prototype.
2. **Run a 3-day like-for-like spike** on one realistic 5,000-object note (about 40% text/stickies, 40% ink,
   rest shapes/images/connectors), measuring drag, pan, zoom-settle and text sharpness in the desktop window
   (pywebview's WebKit, not just Chrome): (i) Fabric tuned (`skipOffscreen`, object caching, static desk layer),
   (ii) Leafer + editor, (iii) Pixi + Text re-raster policy. The captain's 60 vs 30 fps result likely used
   simple shapes and default Fabric; text-heavy notes are exactly where Pixi's advantage shrinks.
3. **Decision rule:**
   - If tuned Fabric holds about 55+ fps on the realistic note: stay; cheapest by far.
   - Else if Leafer holds 55+ fps on pan and zoom: choose **Leafer** (about 8-11 weeks); it is the only option
     whose transformer, text editing and export are maintained libraries.
   - Else choose the **hybrid: PixiJS v8 for rendering + pixi-viewport + perfect-freehand + rbush + DOM overlay
     for text editing + our own selection/transform layer and connectors** (about 14-18 weeks). Accept that
     the transformer, text-edit overlay, connectors, undo and export are hand-built, because no maintained v8
     library exists for them today.
4. Rule out tldraw (paid production license, React, 4,000-shape default cap), Excalidraw and Graphite (apps,
   not engines), Konva (no speed gain over Fabric), Pencil.js (stale), Two.js (no editing), @antv/g (viz focus,
   slowing releases).

Bottom line: the captain's condition ("Pixi only if the batteries exist as maintained libraries") is **not
met** for PixiJS v8: viewport, ink and spatial index are covered, but selection/transform, multiline text
editing, connectors and serialization are not. Leafer is the closest batteries-included option but is a
Canvas 2D engine, so its speed on our scene must be measured before committing.

## Sources

- npm registry metadata via `npm view` (versions, release dates, peer deps, licenses), 2026-10-01
- GitHub API repo stats via `gh api repos/<owner>/<repo>`, 2026-10-01
- PixiJS releases: https://github.com/pixijs/pixijs/releases ; text docs: https://pixijs.com/8.x/guides/components/scene-objects/text ; BitmapText/MSDF: https://pixijs.com/8.x/guides/components/scene-objects/text/bitmap
- pixi-viewport: https://github.com/pixijs-userland/pixi-viewport
- pixi-essentials transformer v8 issue: https://github.com/ShukantPal/pixi-essentials/issues/105
- @pixi/ui Input source (`src/input/Input.ts`, `hiddenField.ts`): https://github.com/pixijs/ui
- perfect-freehand: https://github.com/steveruizok/perfect-freehand ; rbush: https://github.com/mourner/rbush
- LeaferJS site/benchmarks: https://www.leaferjs.com/en/ ; plugins: https://www.leaferjs.com/ui/plugin/ ; leafer-in source (text-editor uses contentEditable): https://github.com/leaferjs/leafer-in
- Konva performance: https://konvajs.org/docs/performance/All_Performance_Tips.html
- tldraw license: https://github.com/tldraw/tldraw/blob/main/LICENSE.md ; pricing: https://tldraw.dev/pricing ; performance: https://tldraw.dev/sdk-features/performance ; $6k/yr figure: https://appdevelopermagazine.com/tldraw-sdk-4.0-release-new-starter-kits-and-licensing-model/ (third-party, unverified)
- AntV G: https://g.antv.antgroup.com/en/guide/introduce ; Excalidraw, Two.js, Pencil.js, Graphite GitHub repos
- Bundle sizes: https://bundlephobia.com (pixi.js, fabric, konva, two.js, tldraw, excalidraw, perfect-freehand, rbush)
