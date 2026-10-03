// The canvas's performance settings (F-034). Every optimization can be switched off from outside (a benchmark sets `window.__pnPerf` before the
// app starts, see scripts/benchmark-f034.mjs) so that its effect is measured, not assumed. The defaults are what ships.
//
//   bakedShadow   a sticky's drop shadow is one shared image (true) or a live blur on every sticky (false)
//   dprCap        the most device pixels per CSS pixel the canvas draws (2: a 3x phone screen is drawn at 2x); 0 = no cap
//   pageBitmaps   below `lodZoom` the note is shown as one bitmap per page while it is panned and zoomed, and the vector objects are put
//                 down meanwhile: 'adaptive' (only on a machine that shows it needs them), 'always', or 'off' (see tiles.js)
//   lodZoom       the zoom below which the page bitmaps may be used
//   partRender    Leafer redraws only the part of the screen that changed (true) or the whole canvas every frame (false)
//   lodQuiet      milliseconds without a view change after which the vectors come back (checks hold the bitmaps up with a large value)
export const PERF_DEFAULTS = Object.freeze({ bakedShadow: true, dprCap: 2, pageBitmaps: 'adaptive', lodZoom: 0.6, lodQuiet: 170, partRender: true })

export function readPerf(source = globalThis.__pnPerf) {
  return { ...PERF_DEFAULTS, ...(source && typeof source === 'object' ? source : {}) }
}

// The device pixel ratio the canvas draws at.
export function pixelRatioFor(devicePixelRatio, perf) {
  const ratio = devicePixelRatio || 1
  return perf.dprCap > 0 ? Math.min(perf.dprCap, ratio) : ratio
}

// The render strategies the speed test compares (Compare render modes) and Settings > Performance > Render mode lets a person feel. Each is a patch
// over the defaults; 'default' is what ships.
export const RENDER_MODES = Object.freeze({
  default: Object.freeze({}),
  bitmaps: Object.freeze({ pageBitmaps: 'always', lodZoom: 100 }),
  dpr1: Object.freeze({ dprCap: 1 }),
  noShadow: Object.freeze({ bakedShadow: false }),
  fullRender: Object.freeze({ partRender: false }),
})
// What the Settings select offers (the others are for the speed test's comparison only).
export const SETTINGS_RENDER_MODES = Object.freeze(['default', 'bitmaps', 'dpr1'])
