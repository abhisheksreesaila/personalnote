# Leafer performance pass: before and after (F-034)

Numbers for the blog (F-037). "Before" is the Leafer canvas as F-032 left it (commit 596495c); "after" is the end of F-034. Every number is
a median (p50), a slow tail (p95) or the worst case (max) of the time between animation frames in milliseconds: 16.7 is 60 frames a second.
The engine race itself (`index.html`, `stress-harness/`, `screens/`) is untouched and still runs.

## How it was measured

- `scripts/benchmark-f034.mjs`: real mouse, pen and keyboard input driven into the real app (Vite dev server, mocked `/api`, headless
  Chromium), one input per frame. `scripts/benchmark-f034-matrix.mjs` runs it over the whole matrix and prints the tables below; every
  optimization has a switch (`window.__pnPerf`, `src/modules/canvas-leafer/perf.js`) so it was measured off and on, not assumed.
- Two notes: the F-002 benchmark note (600 objects, 12 pages, no stickies) and a generated stress note (`src/modules/speedtest/stress-note.js`:
  5,296 objects, 37% text, 21% stickies, 16% shapes, 26% pen lines, arrows; 20 pages; seeded, so it is the same every time).
- Two renderers: **with the graphics card** (Chromium on Vulkan, RTX 3090: what a Mac or a Linux desktop does) and **software rendering**
  (SwiftShader: a computer with no usable graphics card, a virtual machine; the worst case). devicePixelRatio 1 and 2.
- The same checks run inside the real desktop app on any machine: `npm run speedtest` (README, "Speed test").
- Caveats: one run per cell, another builder was using the machine at times, so differences of one frame (16.7 ms) are noise. The first
  frame of a drag and the save of an edit show up as single long frames (the max column), not in p50 or p95.

## What changed, and what it bought

| change | measured effect |
|---|---|
| Undo and redo redraw only the objects the step names (they redrew the whole note) | 5,296 objects: undo 290 ms to 10 ms median (the call), 305 ms to 23 ms to the frame after; 600 objects: 147 ms to 3.4 ms. Back under the 10 ms target on the 616-object note (3.4 ms). |
| The first save of a note is written ahead in idle time (it wrote every object, 150 ms on 5,000, right after the first edit) and Leafer's first layout likewise | the 150 ms frame after the first edit is gone (max of the drag rows: 150 to 50 ms on the stress note at dpr 2). |
| Page bitmaps while a zoomed-out view moves (adaptive: only on a machine seen to need them) | zoomed-out pan, stress note: p95 100 to 16.7 ms in software rendering, 33 to 16.8 ms with the graphics card at dpr 2; 16,000 objects on 36 pages, graphics card: p95 83 to 16.7 ms, slow frames 211 to 5 of 482. |
| The canvas draws at most 2 device pixels per CSS pixel | dpr 3 screen, stress note, graphics card: dragging 40 objects p95 217 to 17 ms (software rendering: 1033 to 600). |
| Baked sticky shadows (already in P-03; measured now) | graphics card: zoomed-out pan p95 100 (live blurred shadows) to 33 ms (baked). In software rendering the live blur was not slower in this test, so the baked image is kept for the machines that have a graphics card. |
| Leaving a note sends nothing when nothing changed | the unchanged note was sent back on every switch and every close; now no request. |
| Pen lines handed to the engine as numbers | about 55 ms less of the 1,400 ms it takes to open the stress note (opening: 1,655 to 1,389 ms). |
| Culling off-screen pages | no measurable gain with the bitmaps showing (5,296 and 16,000 objects, both renderers): dropped. |
| Typing | no change, and nothing to fix: key to paint is 16 ms with the graphics card on both notes (software rendering is raster-bound: 32 to 120 ms before and after). An earlier "typing is slow" reading was a measurement artifact of a timer-based probe; the browser's own event timing is used now. |

What the profiling also showed, left for later: every pointer move walks all objects to find what is under it (about 4.7 ms per move at 5,300
objects in a CPU profile; it grows with the object count), because Leafer's hit test does not stop at the first hit.

## Tables

### 600 objects, devicePixelRatio 1, with the graphics card

| scenario | before p50 | before p95 | before max | after p50 | after p95 | after max |
|---|---:|---:|---:|---:|---:|---:|
| open (to first settled frame, cold) | 864 | - | - | 793 | - | - |
| pan, zoomed out to 30% | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 | 16.8 |
| zoom (ctrl+wheel) from 30% | 16.7 | 16.7 | 16.8 | 16.7 | 16.7 | 16.8 |
| pan at 100% | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 | 16.8 |
| drag one object (100%) | 16.7 | 16.8 | 33.3 | 16.7 | 16.7 | 16.8 |
| drag 30 selected objects (100%) | 16.7 | 16.8 | 16.8 | 16.7 | 16.7 | 16.8 |
| undo (25 steps, the call) | 146.5 | 159.4 | 170.9 | 3.4 | 4.8 | 5.2 |
| undo (25 steps, to the frame after) | 151.3 | 175 | 175.5 | 16.7 | 17.1 | 17.5 |
| redo (25 steps, the call) | 140.2 | 153.8 | 155.1 | 3.1 | 3.8 | 4.4 |
| redo (25 steps, to the frame after) | 144.3 | 158.2 | 159.4 | 16.6 | 17.5 | 32.5 |
| pen strokes (100%): frame gaps | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 | 16.8 |
| typing 80 characters: frame gaps | 16.7 | 16.7 | 16.8 | 16.7 | 16.7 | 16.8 |
| typing 80 characters: key to paint | - | - | - | 16 | 16 | 24 |

### 600 objects, devicePixelRatio 2, with the graphics card

| scenario | before p50 | before p95 | before max | after p50 | after p95 | after max |
|---|---:|---:|---:|---:|---:|---:|
| open (to first settled frame, cold) | 915 | - | - | 804 | - | - |
| pan, zoomed out to 30% | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 | 16.8 |
| zoom (ctrl+wheel) from 30% | 16.7 | 16.7 | 16.8 | 16.7 | 16.7 | 16.8 |
| pan at 100% | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 | 16.8 |
| drag one object (100%) | 16.7 | 16.8 | 16.8 | 16.7 | 16.8 | 16.8 |
| drag 30 selected objects (100%) | 16.7 | 16.7 | 16.8 | 16.7 | 16.7 | 16.8 |
| undo (25 steps, the call) | 142.2 | 154.3 | 159.5 | 3.3 | 4 | 4 |
| undo (25 steps, to the frame after) | 146.7 | 160.7 | 164.1 | 16.7 | 17.9 | 18 |
| redo (25 steps, the call) | 138.9 | 151 | 157.8 | 3.1 | 4.2 | 4.4 |
| redo (25 steps, to the frame after) | 143.2 | 157.7 | 162.2 | 16.6 | 17.3 | 17.4 |
| pen strokes (100%): frame gaps | 16.7 | 16.7 | 16.8 | 16.7 | 16.7 | 16.8 |
| typing 80 characters: frame gaps | 16.7 | 16.8 | 16.8 | 16.7 | 16.8 | 16.8 |
| typing 80 characters: key to paint | - | - | - | 16 | 16 | 24 |

### 5296 objects (stress), devicePixelRatio 1, with the graphics card

| scenario | before p50 | before p95 | before max | after p50 | after p95 | after max |
|---|---:|---:|---:|---:|---:|---:|
| open (to first settled frame, cold) | 1667 | - | - | 1409 | - | - |
| pan, zoomed out to 30% | 16.7 | 33.4 | 33.4 | 16.7 | 16.8 | 33.5 |
| zoom (ctrl+wheel) from 30% | 16.7 | 16.7 | 33.4 | 16.7 | 16.8 | 50 |
| pan at 100% | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 | 16.8 |
| drag one object (100%) | 16.7 | 16.8 | 66.7 | 16.7 | 16.8 | 66.6 |
| drag 40 selected objects (100%) | 16.7 | 16.8 | 150 | 16.7 | 16.8 | 16.8 |
| undo (25 steps, the call) | 289.8 | 328.8 | 361.9 | 9.8 | 13.3 | 17.5 |
| undo (25 steps, to the frame after) | 309 | 343.8 | 376.5 | 22.7 | 27.7 | 31.8 |
| redo (25 steps, the call) | 285.5 | 320.9 | 321.2 | 9.1 | 11.6 | 13.9 |
| redo (25 steps, to the frame after) | 302.4 | 335.6 | 341.1 | 21.4 | 26.6 | 30.3 |
| pen strokes (100%): frame gaps | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 | 33.4 |
| typing 80 characters: frame gaps | 16.7 | 16.7 | 16.8 | 16.7 | 16.7 | 16.8 |
| typing 80 characters: key to paint | - | - | - | 16 | 16 | 32 |

### 5296 objects (stress), devicePixelRatio 2, with the graphics card

| scenario | before p50 | before p95 | before max | after p50 | after p95 | after max |
|---|---:|---:|---:|---:|---:|---:|
| open (to first settled frame, cold) | 1655 | - | - | 1389 | - | - |
| pan, zoomed out to 30% | 16.7 | 33.4 | 50 | 16.7 | 16.8 | 33.2 |
| zoom (ctrl+wheel) from 30% | 16.7 | 33.3 | 50.1 | 16.7 | 16.8 | 50 |
| pan at 100% | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 | 16.8 |
| drag one object (100%) | 16.7 | 16.7 | 66.7 | 16.7 | 16.8 | 66.7 |
| drag 40 selected objects (100%) | 16.7 | 16.7 | 150 | 16.7 | 16.8 | 50.1 |
| undo (25 steps, the call) | 286.8 | 320.7 | 332.3 | 10 | 13 | 16.4 |
| undo (25 steps, to the frame after) | 304.6 | 338.7 | 346.3 | 22.5 | 27.7 | 31 |
| redo (25 steps, the call) | 280.8 | 308.3 | 319.4 | 10.2 | 11.6 | 14.6 |
| redo (25 steps, to the frame after) | 296.6 | 326.9 | 337.9 | 22.7 | 27.2 | 31.3 |
| pen strokes (100%): frame gaps | 16.7 | 16.7 | 16.8 | 16.7 | 16.7 | 16.8 |
| typing 80 characters: frame gaps | 16.7 | 16.7 | 16.8 | 16.7 | 16.7 | 16.8 |
| typing 80 characters: key to paint | - | - | - | 16 | 16 | 32 |

### 600 objects, devicePixelRatio 1, software rendering (no graphics card)

| scenario | before p50 | before p95 | before max | after p50 | after p95 | after max |
|---|---:|---:|---:|---:|---:|---:|
| open (to first settled frame, cold) | 742 | - | - | 655 | - | - |
| pan, zoomed out to 30% | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 | 16.8 |
| zoom (ctrl+wheel) from 30% | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 | 16.8 |
| pan at 100% | 16.7 | 16.8 | 16.8 | 16.7 | 16.7 | 16.8 |
| drag one object (100%) | 16.7 | 16.7 | 33.3 | 16.7 | 16.8 | 33.3 |
| drag 30 selected objects (100%) | 16.7 | 33.4 | 33.4 | 16.7 | 33.4 | 50 |
| undo (25 steps, the call) | 148.6 | 158.3 | 168.9 | 4 | 6.4 | 7.8 |
| undo (25 steps, to the frame after) | 164.7 | 178.6 | 188.4 | 31.2 | 42.6 | 44.1 |
| redo (25 steps, the call) | 140.5 | 154.4 | 154.8 | 4.3 | 5.9 | 6 |
| redo (25 steps, to the frame after) | 156 | 170.1 | 170.8 | 30.9 | 41.8 | 47.2 |
| pen strokes (100%): frame gaps | 16.7 | 16.7 | 16.8 | 16.7 | 16.7 | 16.8 |
| typing 80 characters: frame gaps | 16.7 | 16.7 | 16.8 | 16.7 | 16.7 | 16.8 |
| typing 80 characters: key to paint | - | - | - | 40 | 48 | 48 |

### 600 objects, devicePixelRatio 2, software rendering (no graphics card)

| scenario | before p50 | before p95 | before max | after p50 | after p95 | after max |
|---|---:|---:|---:|---:|---:|---:|
| open (to first settled frame, cold) | 1354 | - | - | 1145 | - | - |
| pan, zoomed out to 30% | 16.7 | 83.4 | 100.1 | 16.7 | 66.7 | 116.7 |
| zoom (ctrl+wheel) from 30% | 16.7 | 83.4 | 100.1 | 16.7 | 83.4 | 116.7 |
| pan at 100% | 16.7 | 83.4 | 83.4 | 16.7 | 83.4 | 83.4 |
| drag one object (100%) | 33.2 | 66.6 | 116.6 | 33.3 | 50.1 | 99.9 |
| drag 30 selected objects (100%) | 16.7 | 150 | 166.7 | 33.3 | 133.4 | 150 |
| undo (25 steps, the call) | 157.9 | 171.4 | 192.2 | 5.1 | 7.7 | 33.5 |
| undo (25 steps, to the frame after) | 242.7 | 255.4 | 274.8 | 98.2 | 102.9 | 124.6 |
| redo (25 steps, the call) | 150.8 | 163 | 166.9 | 4 | 7 | 32.2 |
| redo (25 steps, to the frame after) | 233.8 | 249.9 | 255.4 | 95.9 | 105.4 | 124.6 |
| pen strokes (100%): frame gaps | 16.7 | 16.8 | 83.4 | 16.7 | 16.8 | 83.4 |
| typing 80 characters: frame gaps | 33.3 | 66.7 | 83.4 | 33.4 | 66.7 | 83.4 |
| typing 80 characters: key to paint | - | - | - | 104 | 152 | 192 |

### 5296 objects (stress), devicePixelRatio 1, software rendering (no graphics card)

| scenario | before p50 | before p95 | before max | after p50 | after p95 | after max |
|---|---:|---:|---:|---:|---:|---:|
| open (to first settled frame, cold) | 1578 | - | - | 1369 | - | - |
| pan, zoomed out to 30% | 16.7 | 100 | 100.1 | 16.7 | 16.7 | 100.1 |
| zoom (ctrl+wheel) from 30% | 16.7 | 83.4 | 133.4 | 16.7 | 83.3 | 100 |
| pan at 100% | 16.7 | 83.4 | 100.1 | 16.7 | 100 | 116.7 |
| drag one object (100%) | 16.7 | 16.8 | 83.3 | 16.7 | 16.8 | 133.2 |
| drag 40 selected objects (100%) | 16.7 | 166.7 | 200 | 16.7 | 166.7 | 200 |
| undo (25 steps, the call) | 289.9 | 334.1 | 376.2 | 12.1 | 16.8 | 19.2 |
| undo (25 steps, to the frame after) | 362.1 | 414.9 | 460.1 | 83.3 | 95.6 | 111.3 |
| redo (25 steps, the call) | 285.4 | 313.7 | 316.3 | 12.8 | 15 | 17.5 |
| redo (25 steps, to the frame after) | 356.7 | 386.8 | 389.5 | 83.3 | 87.8 | 92.3 |
| pen strokes (100%): frame gaps | 16.7 | 16.8 | 16.8 | 16.7 | 16.7 | 16.8 |
| typing 80 characters: frame gaps | 16.7 | 16.8 | 16.8 | 16.7 | 16.7 | 16.8 |
| typing 80 characters: key to paint | - | - | - | 48 | 48 | 48 |

### 5296 objects (stress), devicePixelRatio 2, software rendering (no graphics card)

| scenario | before p50 | before p95 | before max | after p50 | after p95 | after max |
|---|---:|---:|---:|---:|---:|---:|
| open (to first settled frame, cold) | 2236 | - | - | 1930 | - | - |
| pan, zoomed out to 30% | 16.7 | 350 | 366.7 | 16.7 | 316.7 | 383.4 |
| zoom (ctrl+wheel) from 30% | 33.3 | 349.9 | 400 | 33.4 | 350 | 433.3 |
| pan at 100% | 16.7 | 299.9 | 316.7 | 16.8 | 283.4 | 316.7 |
| drag one object (100%) | 16.7 | 66.7 | 299.9 | 16.7 | 66.7 | 299.9 |
| drag 40 selected objects (100%) | 16.7 | 550.1 | 633.3 | 16.7 | 550.1 | 616.6 |
| undo (25 steps, the call) | 310.1 | 339.4 | 348.6 | 17.4 | 21.6 | 23.1 |
| undo (25 steps, to the frame after) | 571 | 600.3 | 608.5 | 280.7 | 287.9 | 288.5 |
| redo (25 steps, the call) | 300.1 | 332.1 | 336.1 | 16.7 | 24 | 38.9 |
| redo (25 steps, to the frame after) | 560.3 | 596.3 | 598.5 | 282.5 | 289.9 | 304 |
| pen strokes (100%): frame gaps | 16.7 | 16.8 | 83.3 | 16.7 | 16.8 | 66.8 |
| typing 80 characters: frame gaps | 33.2 | 66.7 | 83.4 | 33.3 | 66.8 | 266.6 |
| typing 80 characters: key to paint | - | - | - | 104 | 168 | 216 |

### One switch at a time

| run | scenario | p50 | p95 | max | slow frames |
|---|---|---:|---:|---:|---:|
| gpu-baked-shadow-off-dpr2 | pan, zoomed out to 30% | 16.7 | 16.8 | 150 | 2 |
| gpu-baked-shadow-off-dpr2 | zoom (ctrl+wheel) from 30% | 16.7 | 16.8 | 99.9 | 6 |
| gpu-baked-shadow-off-dpr2 | pan at 100% | 16.7 | 16.8 | 16.8 | 0 |
| gpu-baked-shadow-off-dpr2 | drag one object (100%) | 16.7 | 16.8 | 100.1 | 2 |
| gpu-baked-shadow-off-dpr2 | drag 40 selected objects (100%) | 16.7 | 16.7 | 16.8 | 0 |
| gpu-big-bitmaps-always-dpr2 | pan, zoomed out to 30% | 16.7 | 16.8 | 66.7 | 5 |
| gpu-big-bitmaps-always-dpr2 | zoom (ctrl+wheel) from 30% | 16.7 | 16.8 | 133.4 | 13 |
| gpu-big-bitmaps-always-dpr2 | pan at 100% | 16.7 | 16.7 | 16.8 | 0 |
| gpu-big-bitmaps-off-dpr2 | pan, zoomed out to 30% | 16.7 | 83.3 | 133.2 | 211 |
| gpu-big-bitmaps-off-dpr2 | zoom (ctrl+wheel) from 30% | 16.7 | 50 | 83.4 | 50 |
| gpu-big-bitmaps-off-dpr2 | pan at 100% | 16.7 | 16.7 | 16.8 | 0 |
| gpu-big-dpr-cap-off-dpr2 | pan, zoomed out to 30% | 16.7 | 83.3 | 133.2 | 216 |
| gpu-big-dpr-cap-off-dpr2 | zoom (ctrl+wheel) from 30% | 16.7 | 49.9 | 83.4 | 53 |
| gpu-big-dpr-cap-off-dpr2 | pan at 100% | 16.7 | 16.7 | 16.8 | 0 |
| gpu-bitmaps-always-dpr2 | pan, zoomed out to 30% | 16.7 | 16.8 | 33.4 | 3 |
| gpu-bitmaps-always-dpr2 | zoom (ctrl+wheel) from 30% | 16.7 | 16.8 | 50.1 | 4 |
| gpu-bitmaps-always-dpr2 | pan at 100% | 16.7 | 16.7 | 16.8 | 0 |
| gpu-bitmaps-always-dpr2 | drag one object (100%) | 16.7 | 16.8 | 66.6 | 1 |
| gpu-bitmaps-always-dpr2 | drag 40 selected objects (100%) | 16.7 | 16.7 | 50 | 1 |
| gpu-bitmaps-off-baked-off-dpr2 | pan, zoomed out to 30% | 16.7 | 100 | 116.8 | 209 |
| gpu-bitmaps-off-baked-off-dpr2 | zoom (ctrl+wheel) from 30% | 16.7 | 50 | 116.7 | 40 |
| gpu-bitmaps-off-baked-off-dpr2 | pan at 100% | 16.7 | 16.7 | 16.8 | 0 |
| gpu-bitmaps-off-baked-off-dpr2 | drag one object (100%) | 16.7 | 16.8 | 100.1 | 2 |
| gpu-bitmaps-off-baked-off-dpr2 | drag 40 selected objects (100%) | 16.7 | 16.8 | 33.4 | 5 |
| gpu-bitmaps-off-dpr2 | pan, zoomed out to 30% | 16.7 | 33.4 | 50 | 109 |
| gpu-bitmaps-off-dpr2 | zoom (ctrl+wheel) from 30% | 16.7 | 33.3 | 66.7 | 23 |
| gpu-bitmaps-off-dpr2 | pan at 100% | 16.7 | 16.8 | 16.8 | 0 |
| gpu-bitmaps-off-dpr2 | drag one object (100%) | 16.7 | 16.8 | 16.8 | 0 |
| gpu-bitmaps-off-dpr2 | drag 40 selected objects (100%) | 16.7 | 16.8 | 83.3 | 1 |
| gpu-default-dpr2 | pan, zoomed out to 30% | 16.7 | 16.8 | 33.4 | 2 |
| gpu-default-dpr2 | zoom (ctrl+wheel) from 30% | 16.7 | 16.7 | 50.1 | 4 |
| gpu-default-dpr2 | pan at 100% | 16.7 | 16.8 | 16.8 | 0 |
| gpu-default-dpr2 | drag one object (100%) | 16.7 | 16.8 | 66.7 | 1 |
| gpu-default-dpr2 | drag 40 selected objects (100%) | 16.7 | 16.8 | 66.6 | 1 |
| sw-baked-shadow-off-dpr1 | pan, zoomed out to 30% | 16.7 | 16.7 | 50 | 1 |
| sw-baked-shadow-off-dpr1 | zoom (ctrl+wheel) from 30% | 16.7 | 33.4 | 66.8 | 33 |
| sw-baked-shadow-off-dpr1 | pan at 100% | 16.7 | 50 | 50.1 | 120 |
| sw-baked-shadow-off-dpr1 | drag one object (100%) | 16.7 | 16.8 | 100.1 | 4 |
| sw-baked-shadow-off-dpr1 | drag 40 selected objects (100%) | 16.7 | 133.4 | 183.3 | 62 |
| sw-big-bitmaps-always-dpr1 | pan, zoomed out to 30% | 16.7 | 16.8 | 166.7 | 3 |
| sw-big-bitmaps-always-dpr1 | zoom (ctrl+wheel) from 30% | 16.7 | 116.7 | 216.6 | 107 |
| sw-big-bitmaps-always-dpr1 | pan at 100% | 16.7 | 116.7 | 133.3 | 157 |
| sw-big-bitmaps-off-dpr1 | pan, zoomed out to 30% | 16.7 | 183.3 | 199.9 | 121 |
| sw-big-bitmaps-off-dpr1 | zoom (ctrl+wheel) from 30% | 16.7 | 133.3 | 183.3 | 106 |
| sw-big-bitmaps-off-dpr1 | pan at 100% | 16.7 | 116.7 | 133.3 | 157 |
| sw-big-dpr-cap-off-dpr1 | pan, zoomed out to 30% | 16.7 | 183.3 | 200 | 121 |
| sw-big-dpr-cap-off-dpr1 | zoom (ctrl+wheel) from 30% | 16.7 | 133.3 | 183.4 | 101 |
| sw-big-dpr-cap-off-dpr1 | pan at 100% | 16.7 | 116.7 | 133.3 | 155 |
| sw-bitmaps-always-dpr1 | pan, zoomed out to 30% | 16.7 | 16.7 | 99.9 | 3 |
| sw-bitmaps-always-dpr1 | zoom (ctrl+wheel) from 30% | 16.7 | 83.3 | 116.6 | 100 |
| sw-bitmaps-always-dpr1 | pan at 100% | 16.7 | 83.4 | 116.6 | 142 |
| sw-bitmaps-always-dpr1 | drag one object (100%) | 16.7 | 16.8 | 83.4 | 1 |
| sw-bitmaps-always-dpr1 | drag 40 selected objects (100%) | 16.7 | 166.7 | 200 | 61 |
| sw-bitmaps-off-baked-off-dpr1 | pan, zoomed out to 30% | 16.7 | 66.6 | 66.8 | 55 |
| sw-bitmaps-off-baked-off-dpr1 | zoom (ctrl+wheel) from 30% | 16.7 | 50 | 83.4 | 46 |
| sw-bitmaps-off-baked-off-dpr1 | pan at 100% | 16.7 | 50 | 50.1 | 120 |
| sw-bitmaps-off-baked-off-dpr1 | drag one object (100%) | 16.7 | 16.8 | 116.6 | 4 |
| sw-bitmaps-off-baked-off-dpr1 | drag 40 selected objects (100%) | 16.7 | 149.9 | 183.2 | 61 |
| sw-bitmaps-off-dpr1 | pan, zoomed out to 30% | 16.7 | 100 | 100.1 | 54 |
| sw-bitmaps-off-dpr1 | zoom (ctrl+wheel) from 30% | 16.7 | 83.4 | 133.4 | 113 |
| sw-bitmaps-off-dpr1 | pan at 100% | 16.7 | 83.4 | 100.1 | 141 |
| sw-bitmaps-off-dpr1 | drag one object (100%) | 16.7 | 16.8 | 133.3 | 3 |
| sw-bitmaps-off-dpr1 | drag 40 selected objects (100%) | 16.7 | 166.7 | 200 | 62 |
| sw-default-dpr1 | pan, zoomed out to 30% | 16.7 | 16.8 | 116.7 | 3 |
| sw-default-dpr1 | zoom (ctrl+wheel) from 30% | 16.7 | 83.3 | 100 | 100 |
| sw-default-dpr1 | pan at 100% | 16.7 | 83.4 | 100.1 | 145 |
| sw-default-dpr1 | drag one object (100%) | 16.7 | 16.8 | 149.9 | 3 |
| sw-default-dpr1 | drag 40 selected objects (100%) | 16.7 | 166.7 | 200 | 62 |
