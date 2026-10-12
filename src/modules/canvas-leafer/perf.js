// The canvas's performance settings (F-034). Every optimization can be switched off from outside (a benchmark sets `window.__pnPerf` before the
// app starts, see scripts/benchmark-f034.mjs) so that its effect is measured, not assumed. The defaults are what ships.
//
//   bakedShadow   a sticky's drop shadow is one shared image (true) or a live blur on every sticky (false)
//   dprCap        the most device pixels per CSS pixel the canvas draws (2: a 3x phone screen is drawn at 2x); 0 = no cap
//   pageBitmaps   below `lodZoom` the note is shown as one bitmap per page while it is panned and zoomed, and the vector objects are put
//                 down meanwhile: 'adaptive' (only on a machine that shows it needs them), 'always', or 'off' (see tiles.js)
//   lodZoom       the zoom below which the page bitmaps may be used
//   partRender    Leafer redraws only the part of the screen that changed (true) or the whole canvas every frame (false)
//   hybrid        the default render mode (see tiles.js): the page bitmaps are used at every zoom level while the view moves (pageBitmaps 'always', lodZoom
//                 high), crisp at the device resolution, an edit makes only the touched pages out of date, and a drag of a crowd is drawn at 1x
//   tileBudget    hybrid: megabytes of page bitmaps for the whole note (the pages on screen first)
//   dragCrowd     hybrid: a drag or resize of more than this many objects is drawn at one device pixel per CSS pixel while it moves (sharp on drop); 0 = never
//   gestureTransform  while the view is panned or zoomed the drawn canvas is moved with a CSS transform and the note is drawn once more when the
//                 gesture settles (gesture-view.js); it replaces the page bitmaps, so pageBitmaps is 'off' with it
//   gestureMargin how far past the window the canvas is drawn on each side, as a fraction of the window (a pan has that much before it shows blank)
//   gestureQuiet  milliseconds without a view change after which the gesture has settled and the note is drawn again
//   lodQuiet      milliseconds without a view change after which the vectors come back (checks hold the bitmaps up with a large value)
export const PERF_DEFAULTS = Object.freeze({ bakedShadow: true, dprCap: 2, pageBitmaps: 'always', lodZoom: 100, lodQuiet: 170, partRender: true, gestureTransform: false, gestureMargin: 0.2, gestureQuiet: 120, hybrid: true, tileBudget: 128, dragCrowd: 3 })

export function readPerf(source = globalThis.__pnPerf) {
  const given = source && typeof source === 'object' ? source : {}
  const merged = { ...PERF_DEFAULTS, ...given }
  // Asking for the page bitmaps by name (a check, the 'bitmaps' mode) means that strategy, not the gesture transform on top of it.
  if (!('gestureTransform' in given) && given.pageBitmaps && given.pageBitmaps !== 'off') merged.gestureTransform = false
  return merged
}

// The device pixel ratio the canvas draws at.
export function pixelRatioFor(devicePixelRatio, perf) {
  const ratio = devicePixelRatio || 1
  return perf.dprCap > 0 ? Math.min(perf.dprCap, ratio) : ratio
}

// The render strategies the speed test compares (Compare render modes) and Settings > Performance > Render mode lets a person feel. Each is a patch
// over the defaults; 'default' is what ships.
export const RENDER_MODES = Object.freeze({
  default: Object.freeze({}), // hybrid: page bitmaps while navigating, live vectors for editing
  gestureTransform: Object.freeze({ gestureTransform: true, pageBitmaps: 'off', hybrid: false, dragCrowd: 0 }), // preview 3's default: "Slide picture"
  classic: Object.freeze({ gestureTransform: false, pageBitmaps: 'adaptive', lodZoom: 0.6, hybrid: false, dragCrowd: 0 }), // before the gesture transform: every pan step is drawn, the page bitmaps help a slow machine
  bitmaps: Object.freeze({ pageBitmaps: 'always', lodZoom: 100, hybrid: false, dragCrowd: 0 }),
  dpr1: Object.freeze({ dprCap: 1, gestureTransform: true, pageBitmaps: 'off', hybrid: false, dragCrowd: 0 }),
  noShadow: Object.freeze({ bakedShadow: false }),
  fullRender: Object.freeze({ partRender: false }),
})
// What the Settings select offers (the others are for the speed test's comparison only).
export const SETTINGS_RENDER_MODES = Object.freeze(['default', 'classic', 'bitmaps', 'gestureTransform', 'dpr1'])

const QUIET_MAX = 900 // ms: the longest the vectors wait, however slow the frames are

// How long the view must be still before the vectors come back. `base` (perf.lodQuiet) assumes frames of a few milliseconds; when the steps of a
// pan come further apart than that (a slow machine) the gaps between two steps are longer than `base`, the vectors would come back in every gap and
// go again on the next step (the bitmaps flicker in and out). The wait follows the measured step: more than two of them.
export function quietFor(base, stepMs) {
  if (!(stepMs > 0)) return base
  return Math.min(QUIET_MAX, Math.max(base, Math.round(stepMs * 2.5)))
}
