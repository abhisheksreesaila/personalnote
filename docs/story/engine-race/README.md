# The engine race: Fabric vs Pixi vs Leafer

Keepsake for the blog post on how Personal Note was made fast (see F-037 in docs/plan.md).
Not throwaway test code: this is the evidence behind ADR 0001.

- `index.html` — the side-by-side prototype: the same note drawn by Fabric.js, PixiJS and LeaferJS at 500 → 100,000 objects, with live frame timing and editing (handles, multi-drag, pen, rotate, marquee, text and sticky editing). Open it in a browser; libraries load from public CDNs.
- `screens/` — captures from the runs (GPU vs software rendering, 500–100,000 objects, phone width, Fabric vs Leafer editing side by side).
- `stress-harness/` — the headless benchmark harness and its raw result files (run with Playwright; `npm i playwright fabric` in that folder first).
- `notes/` — the engine research and the F-024 Leafer report as written at the time. The maintained version is docs/research/f024-leafer.md.
