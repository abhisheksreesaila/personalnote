# Mac run, v0.4.0-preview.3, render-mode comparison (2026-10-03)

WebKit (WKWebView) on Mac, dpr 2, 3420x2214, Apple GPU. p50/p95/max ms, median of two runs.

Key findings:
- Page bitmaps at every zoom: pan and zoom a perfect 17 ms on both the 5,296-object stress note and a 590-object note.
- "Slide the picture" (gesture transform, preview 3 default) was worse than classic on WebKit: pan at 100% p95 62 vs 31 (stress), zoom p95 51.5 vs 32.5 (590 note), typing key-to-frame p95 36.5 vs 25.5.
- DPR 1 made multi-object drag smooth: 27 (stress) and 17.5 (590) p95, vs 38–53.
- Lesson: headless Chromium/WebKit on Linux ranked the gesture transform first; the real Mac ranked it last. Only the Mac run decides.

Decision: build a hybrid (bitmaps while navigating, live vectors while editing, 1x drag layer for group drags) as the default for preview 4.
