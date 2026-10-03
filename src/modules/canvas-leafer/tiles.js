// Page bitmaps (F-034, F-024 §2 points 2-3): while the note is panned or zoomed out below `perf.lodZoom`, it is shown as one bitmap per page
// and the vector objects are put down (taken off the stage, not hidden: Leafer works on every attached object at every pan and zoom
// step, hidden or not). When the movement stops, or the person touches the note, the vectors come back and the bitmaps go.
//
// Why only while moving: the bitmaps are a picture of the note, so nothing can be picked or edited on them. The note is always vectors at
// rest, so every edit, selection and pixel is the engine's own; a bitmap is only what a moving view shows for a fraction of a second.
//
// When: 'always', or 'adaptive' (the default): on a machine whose zoomed-out pans are already smooth the bitmaps never come into play; once
// the frames of such a pan are seen to be slow (a computer without a graphics card, a very dense desk), they are built in idle time, one
// page at a time, and used from then on. 'off' never.
//
// A bitmap is made with the page's margin (BLEED) so an object across a page edge shows whole.
import { Bounds, Canvas, Group, Matrix } from 'leafer-ui'
import { quietFor } from './perf.js'

const BLEED = 40
const MEMORY_BUDGET = 96 * 1024 * 1024 // bytes of bitmap for the whole note
const GESTURE_GAP = 500 // ms: view changes closer than this belong to one pan or zoom (the steps of a pan that is slow are far apart)
const SLOW_FRAME = 26 // ms
const SLOW_COUNT = 6 // slow frames within the last WINDOW gesture frames mean the machine needs the bitmaps
const WINDOW = 24

const FREE_AFTER = 30000 // ms zoomed in before the bitmaps (megabytes) are let go
const SAMPLE_QUIET = 300 // ms without a view change: the frame sampler stops

// `onExit()` runs when the vectors are back (the scene puts back what it did not do while they were off the stage); `pending()` is true while a
// picture is still loading (a bitmap made now would show it empty); `raf` times rendered frames.
export function createTileLod({ leafer, world, perf, pageW, pageH, pixelRatio: initialPixelRatio, getPages, getSize, onExit = () => {}, pending = () => false, now = () => performance.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id), raf = (fn) => requestAnimationFrame(fn) }) {
  let mode = perf.pageBitmaps
  let pixelRatio = initialPixelRatio
  const layer = new Group({ hittable: false, hitChildren: false })
  const tiles = new Map() // 'c,r' -> { node, built }
  let version = 0
  let active = false
  let slow = mode === 'always'
  let gaps = []
  let lastView = 0
  let step = 0 // the smoothed gap between two steps of a pan or zoom, ms
  let sampling = false
  let freeTimer = null
  let quietTimer = null
  let buildTimer = null
  let at = 0 // where the vectors sit in the stage's stack
  let latest = { x: 0, y: 0, scale: 1 }
  const counters = { views: 0, enters: 0, exits: 0, builds: 0, buildMs: 0, notReady: 0 }

  const key = (c, r) => `${c},${r}`
  // The bitmaps are made for the zoom the view has now (a little finer), not for the finest zoom they may be shown at: the fewer pixels a
  // moving frame has to copy and scale, the cheaper it is, and a bitmap is only on screen for a moment. A bitmap far off the zoom of the
  // view is made again when things are quiet.
  const OVERSAMPLE = 1.25
  const tileScale = (view) => {
    const { columns, rows } = getPages()
    const fit = Math.sqrt(MEMORY_BUDGET / Math.max(1, columns * rows * (pageW + 2 * BLEED) * (pageH + 2 * BLEED) * 4))
    return Math.max(0.1, Math.min(view.scale * pixelRatio * OVERSAMPLE, perf.lodZoom * pixelRatio, fit))
  }
  const stale = (tile, view) => { const ratio = tileScale(view) / (tile.scale || 1); return ratio > 1.6 || ratio < 0.5 }

  // The pages on screen (with a margin of one page's tenth), as { c0, c1, r0, r1 } (inclusive).
  function visible(view) {
    const { columns, rows } = getPages()
    const size = getSize()
    const margin = 0.1
    const left = -view.x / view.scale
    const top = -view.y / view.scale
    const right = left + size.width / view.scale
    const bottom = top + size.height / view.scale
    return {
      c0: Math.max(0, Math.floor(left / pageW - margin)), c1: Math.min(columns - 1, Math.floor(right / pageW + margin)),
      r0: Math.max(0, Math.floor(top / pageH - margin)), r1: Math.min(rows - 1, Math.floor(bottom / pageH + margin)),
    }
  }
  const each = (box, run) => { for (let r = box.r0; r <= box.r1; r += 1) for (let c = box.c0; c <= box.c1; c += 1) run(c, r) }

  function ready(box) {
    let all = true
    each(box, (c, r) => { if (tiles.get(key(c, r))?.built !== version) all = false })
    return all
  }

  // One page's bitmap: the note drawn into a canvas of its own, from the live nodes (only the objects that touch the page are drawn).
  function build(c, r) {
    try { buildTile(c, r) } catch (error) {
      // Something in the engine did not take it: no bitmaps from now on, the vectors carry on as before.
      console.warn('page bitmaps are off:', error)
      mode = 'off'
      exit()
      for (const tile of tiles.values()) tile.node.destroy?.()
      tiles.clear()
    }
  }

  function buildTile(c, r) {
    const t0 = now()
    const scale = tileScale(latest)
    const width = pageW + 2 * BLEED
    const height = pageH + 2 * BLEED
    let tile = tiles.get(key(c, r))
    if (!tile) {
      tile = { node: new Canvas({ x: c * pageW - BLEED, y: r * pageH - BLEED, width, height, pixelRatio: scale, hittable: false, smooth: true }), built: -1, scale }
      tiles.set(key(c, r), tile)
    } else if (tile.scale !== scale) { tile.node.pixelRatio = scale; tile.scale = scale }
    const { canvas } = tile.node
    // Cleared whole, whatever transform the last draw left on the context (a clear under a scale clears only part of it).
    const { context, view } = canvas
    context.save()
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, view.width, view.height)
    context.restore()
    const matrix = new Matrix(world.worldTransform).invert()
    matrix.multiplyParent(new Matrix().translate(BLEED - c * pageW, BLEED - r * pageH))
    world.__render(canvas, { matrix: matrix.withScale(), bounds: new Bounds(0, 0, width, height) })
    tile.node.paint()
    tile.built = version
    counters.builds += 1
    counters.buildMs += now() - t0
  }

  // Bitmaps of pages that are not in the note any more (the grid folded back) are let go.
  function prune() {
    const { columns, rows } = getPages()
    for (const [id, tile] of tiles) {
      const [c, r] = id.split(',').map(Number)
      if (c >= columns || r >= rows) { tile.node.remove(); tile.node.destroy?.(); tiles.delete(id) }
    }
  }

  // Idle time: the pages on screen first, then the rest, one page at a time.
  function buildNext() {
    buildTimer = null
    if (active || (mode === 'off') || !slow || latest.scale >= perf.lodZoom) return // not while the view is zoomed in: nothing would use them
    prune()
    if (pending()) { buildTimer = schedule(buildNext, 500); return } // a picture is still loading
    const { columns, rows } = getPages()
    const box = visible(latest)
    const order = []
    each(box, (c, r) => order.push([c, r]))
    for (let r = 0; r < rows; r += 1) for (let c = 0; c < columns; c += 1) if (!(c >= box.c0 && c <= box.c1 && r >= box.r0 && r <= box.r1)) order.push([c, r])
    const next = order.find(([c, r]) => { const tile = tiles.get(key(c, r)); return !tile || tile.built !== version || stale(tile, latest) })
    if (!next) return
    build(next[0], next[1])
    buildTimer = schedule(buildNext, 40)
  }
  function wantBuild(delay = 400) {
    if (mode === 'off' || !slow || buildTimer || active) return
    buildTimer = schedule(buildNext, delay)
  }

  function place(view) {
    layer.set({ x: view.x, y: view.y, scaleX: view.scale, scaleY: view.scale })
  }

  function enter(view) {
    const box = visible(view)
    if (!ready(box)) { counters.notReady += 1; wantBuild(60); return false }
    at = world.parent ? world.parent.children.indexOf(world) : 0
    const stage = world.parent
    world.remove()
    layer.set({ x: view.x, y: view.y, scaleX: view.scale, scaleY: view.scale })
    for (const tile of tiles.values()) if (tile.node.parent) tile.node.remove()
    for (const tile of tiles.values()) if (tile.built === version) layer.add(tile.node)
    stage.addAt(layer, at)
    active = true
    counters.enters += 1
    return true
  }

  function exit() {
    if (quietTimer) { cancel(quietTimer); quietTimer = null }
    if (!active) return false
    const stage = layer.parent
    layer.remove()
    for (const tile of tiles.values()) if (tile.node.parent) tile.node.remove()
    stage.addAt(world, Math.min(at, stage.children.length))
    active = false
    counters.exits += 1
    onExit()
    wantBuild()
    return true
  }

  // Times the frames that really get drawn while the view moves (animation-frame gaps), until the movement stops.
  function sample() {
    if (sampling) return
    sampling = true
    let last = now()
    const tick = () => {
      const t = now()
      gaps.push(t - last)
      last = t
      if (gaps.length > WINDOW) gaps.shift()
      if (gaps.filter((value) => value > SLOW_FRAME).length >= SLOW_COUNT) { slow = true; sampling = false; gaps = []; wantBuild(60); return }
      if (t - lastView > SAMPLE_QUIET || active) { sampling = false; gaps = []; return }
      raf(tick)
    }
    raf(tick)
  }

  // Called with every view change, before the note's layer is moved. Returns true while the bitmaps are on the stage.
  function view(next, { zoomedOutLimit = perf.lodZoom } = {}) {
    latest = next
    counters.views += 1
    if (mode === 'off') return false
    const t = now()
    const gap = t - lastView
    const moving = gap < GESTURE_GAP
    if (moving && gap > 0) step = step ? step * 0.7 + gap * 0.3 : gap
    else if (!moving) step = 0
    lastView = t
    if (next.scale >= zoomedOutLimit) {
      if (active) exit()
      gaps = []
      if (slow && !freeTimer && tiles.size) freeTimer = schedule(() => { freeTimer = null; if (latest.scale >= perf.lodZoom) { for (const tile of tiles.values()) tile.node.destroy?.(); tiles.clear(); version += 1 } }, FREE_AFTER)
      return false
    }
    if (freeTimer) { cancel(freeTimer); freeTimer = null }
    if (!active) {
      // Is this machine slow at it? The frames the screen really shows while the view moves tell (the steps of a pan come at the pace of the frames).
      if (mode === 'adaptive' && !slow) sample()
      if (slow) wantBuild(400) // (a no-op once they are all made)
      if (!slow || !moving) return false
      if (!enter(next)) return false
    } else place(next)
    if (quietTimer) cancel(quietTimer)
    quietTimer = schedule(exit, quietFor(perf.lodQuiet, step))
    return true
  }

  return {
    view,
    exit,
    // The note changed (an edit, a merge, an undo, new fonts): every bitmap is out of date; they are made again when things are quiet.
    invalidate() {
      exit()
      version += 1
      wantBuild(900)
    },
    // A different note, or a different grid: the bitmaps of the old one go.
    reset() {
      exit()
      for (const tile of tiles.values()) tile.node.destroy?.()
      tiles.clear()
      version += 1
      gaps = []
      wantBuild(900)
    },
    // The perf switches changed (the speed test's comparison, Settings > Render mode): the mode and the pixel ratio follow, the old bitmaps go.
    retune(next) {
      mode = next.mode
      if (next.pixelRatio) pixelRatio = next.pixelRatio
      slow = mode === 'always'
      exit()
      for (const tile of tiles.values()) tile.node.destroy?.()
      tiles.clear()
      version += 1
    },
    get active() { return active },
    stats: () => ({ mode, active, slow, tiles: tiles.size, current: [...tiles.values()].filter((tile) => tile.built === version).length, ...counters }),
    // For checks: build every page now.
    buildAll() {
      const { columns, rows } = getPages()
      for (let r = 0; r < rows; r += 1) for (let c = 0; c < columns; c += 1) build(c, r)
    },
    forceSlow() { slow = true },
    destroy() {
      exit()
      if (buildTimer) cancel(buildTimer)
      if (freeTimer) cancel(freeTimer)
      for (const tile of tiles.values()) tile.node.destroy?.()
      tiles.clear()
      layer.destroy?.()
    },
  }
}
