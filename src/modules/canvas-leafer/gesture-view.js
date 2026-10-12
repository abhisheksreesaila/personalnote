// Gesture transform (F-034): while the view is panned or zoomed, the canvas that is already drawn is moved with a CSS transform (the browser's
// compositor does it, on the GPU) instead of being drawn again at every step; the note is drawn once more when the gesture settles. Leafer has no
// per-object cache, so a drawn frame costs as much as the visible objects, and on a retina WebKit screen that was 84 ms per pan step.
//
// The canvas is drawn a margin larger than the window on every side, so a pan does not show blank edges. When a pan or a zoom outruns that margin
// (or the picture would be scaled too far to look right) the note is drawn again at once and the gesture goes on from there.
//
// Pure rules here (tested without a browser); `createGestureView` is the small controller that scene.js drives.
import { quietFor } from './perf.js'

// How far past the window the canvas is drawn on each side, in CSS pixels: `fraction` of the window's width and height, kept inside a budget of
// device pixels shared by the two layers (each is a bitmap in memory, so one canvas gets half).
export function marginFor(size, { fraction = 0.2, pixelRatio = 1, budget = 24e6 } = {}) {
  if (!(fraction > 0) || !(size.width > 0) || !(size.height > 0)) return 0
  let margin = Math.round(Math.min(size.width, size.height) * fraction)
  const pixels = (extra) => 2 * (size.width + 2 * extra) * (size.height + 2 * extra) * pixelRatio * pixelRatio // two layers
  while (margin > 0 && pixels(margin) > budget) margin -= 8
  return Math.max(0, margin)
}

// Where the canvas element goes (translate by tx, ty, then scale by k, about its own top-left corner) so that the note drawn for `rendered` looks like
// `view`. Both are { x, y, scale }; the canvas is placed `margin` before the window's top-left and the note is drawn `margin` into it.
export function transformFor(rendered, view, margin) {
  const k = view.scale / rendered.scale
  return { k, tx: view.x - k * rendered.x + margin * (1 - k), ty: view.y - k * rendered.y + margin * (1 - k) }
}

// Does the moved canvas still cover the whole window?
export function covers(transform, size, margin, slack = 2) {
  const left = -margin + transform.tx
  const top = -margin + transform.ty
  const right = left + transform.k * (size.width + 2 * margin)
  const bottom = top + transform.k * (size.height + 2 * margin)
  return left <= -slack && top <= -slack && right >= size.width + slack && bottom >= size.height + slack
}

// A point drawn on the canvas (canvas pixels) -> where it is in the window now (the canvas element's own pixels moved by the transform).
export function mapPoint(transform, margin, point) {
  return { x: -margin + transform.tx + transform.k * point.x, y: -margin + transform.ty + transform.k * point.y }
}

export const IDENTITY = Object.freeze({ k: 1, tx: 0, ty: 0 })
const MIN_K = 0.5 // a picture scaled further than this looks too soft (or too small to cover the window): the note is drawn again
const MAX_K = 2.5

// How soon after one draw the next intermediate draw may come. A draw of a dense note takes a good part of a second on a slow machine; drawing again
// and again during one long pan or zoom would make the gesture slower than drawing every step was. Between two draws the canvas keeps moving (a blank
// edge or a soft picture for a moment is better than a stalled gesture), so the gap follows the time the last draw took.
export function drawGap(lastDrawMs, floor = 120, ceiling = 1000) {
  return Math.min(ceiling, Math.max(floor, Math.round((lastDrawMs || 0) * 3)))
}

// `elements()` are the canvas elements to move; `moved()` runs after they were moved or put back; `commit(view, { paint })` puts the note's layers at `view` and (when `paint`) draws them NOW (synchronously), so the new picture
// and the removal of the transform reach the screen in the same frame.
export function createGestureView({ elements, commit, moved = () => {}, margin = () => 0, size, quiet = 120, schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id), now = () => performance.now() }) {
  let committed = null // the view the canvas shows
  let latest = null // the view the person has asked for
  let transform = IDENTITY
  let timer = null
  let pending = false
  let lastDrawAt = -Infinity
  let lastDrawMs = 0
  let lastInputAt = -Infinity
  let step = 0 // the smoothed gap between two input steps of this gesture, ms: slow frames (a slow machine) make the gaps longer than `quiet`
  const counters = { moves: 0, settles: 0, intermediate: 0, held: 0 }

  function clear() {
    transform = IDENTITY
    for (const element of elements()) element.style.transform = ''
    moved()
  }

  const recent = [] // the last draws: how long each took and why (for checks and the benchmark)
  function draw(view, paint = true, why = 'redraw') {
    if (timer) { cancel(timer); timer = null }
    pending = false
    committed = { ...view }
    const began = now()
    commit(committed, { paint })
    clear() // same task as the draw: the new picture and the end of the transform are one frame
    lastDrawMs = now() - began
    recent.push([why, Math.round(lastDrawMs), Math.round(began)]); if (recent.length > 40) recent.shift()
    lastDrawAt = now()
  }

  function place() {
    const value = `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.k})`
    for (const element of elements()) { element.style.transformOrigin = '0 0'; element.style.transform = value }
    moved() // (Leafer maps a pointer to the canvas by the canvas's rectangle on the screen, and it reads that rectangle moved or not)
  }

  // The gesture is over (or something needs the picture to be exact): draw the note at the view that was asked for.
  function settle() {
    if (!pending || !latest) return false
    counters.settles += 1
    draw(latest, true, 'settle')
    return true
  }

  return {
    // The view changes (a pan step, a zoom step, a jump).
    setView(view) {
      const at = now()
      const gap = at - lastInputAt
      lastInputAt = at
      step = gap < 600 ? (step ? step * 0.7 + gap * 0.3 : gap) : 0
      latest = { ...view }
      if (!committed) return draw(view)
      const next = transformFor(committed, view, margin())
      if (next.k < MIN_K || next.k > MAX_K || !covers(next, size(), margin())) {
        if (now() - lastDrawAt >= drawGap(lastDrawMs)) { counters.intermediate += 1; return draw(view, true, 'edge') }
        counters.held += 1 // too soon after the last draw: the canvas goes on moving
      }
      transform = next
      pending = true
      counters.moves += 1
      place()
      if (timer) cancel(timer)
      timer = schedule(() => { timer = null; settle() }, quietFor(quiet, step))
    },
    settle,
    // Draw the view now (the note's own edit changed what the layers need, or the window was resized).
    // `paint: false` leaves the drawing to the engine's next frame (an edit that is still changing the nodes: they and the view reach the screen together).
    redraw(view = latest ?? committed, { paint = true } = {}) {
      if (!view) return
      latest = { ...view }
      draw(view, paint)
    },
    // Forget what was drawn (the canvases were resized or cleared): the next view is drawn at once.
    reset() { if (timer) cancel(timer); timer = null; pending = false; committed = null; clear() },
    get pending() { return pending },
    get transform() { return transform },
    get committed() { return committed },
    // Where a point of the canvas (the picture's own pixels) is in the window now.
    map: (point) => mapPoint(transform, margin(), point),
    stats: () => ({ ...counters, pending, margin: margin(), recent: [...recent] }),
    destroy() { if (timer) cancel(timer); timer = null; clear() },
  }
}
