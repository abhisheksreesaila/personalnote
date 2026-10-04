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
//
// Hybrid (perf.hybrid, the default render mode): the bitmaps are used at EVERY zoom level, from the first step of a pan or zoom, and the vectors come
// back when the view settles. The pages on screen are made at the full device pixel ratio (crisp at rest zoom), the pages near them a little coarser,
// the far ones coarse, all inside one memory budget; a view whose pages could not be made crisp inside it (zoomed far in: few objects on screen, so
// the vectors are cheap) does not use the bitmaps. An edit makes only the pages it touched out of date (`invalidate(rects)`), and everything is
// made again in idle time: after a settle for the zoom the view has now, after an edit for the touched pages.
import { Bounds, Canvas, Group, Matrix } from 'leafer-ui'
import { quietFor } from './perf.js'
import { planScales } from './tile-plan.js'

const BLEED = 40
const MEMORY_BUDGET = 96 * 1024 * 1024 // bytes of bitmap for the whole note (not hybrid; hybrid reads perf.tileBudget)
const BUSY_RETRY = 150 // ms: idle work waits this long after the last view change
const EDIT_QUIET = 150 // ms: ... and this long after the last edit
const BANDS = 4 // a page's bitmap is drawn in this many horizontal bands, one per timer tick, so no single synchronous draw is longer than a quarter of a page
const BAND_GAP = 12 // ms between two bands (input gets its turn)
const JIT_MS = 100 // hybrid: when a pan or zoom starts, the pages that are out of date (an edit) or soft (a zoom) are made on the spot while that is expected to take no longer than this together (by the pages made so far: about two vector frames); a single page is always made; beyond that the vectors show until idle time has made them
const SOFT = 0.8 // hybrid: a bitmap made for less than this share of the zoom now is soft; it is not shown by a new pan, it is made again first
const GESTURE_GAP = 500 // ms: view changes closer than this belong to one pan or zoom (the steps of a pan that is slow are far apart)
const SLOW_FRAME = 26 // ms
const SLOW_COUNT = 6 // slow frames within the last WINDOW gesture frames mean the machine needs the bitmaps
const WINDOW = 24

const FREE_AFTER = 30000 // ms zoomed in before the bitmaps (megabytes) are let go
const SAMPLE_QUIET = 300 // ms without a view change: the frame sampler stops

// `onExit()` runs when the vectors are back (the scene puts back what it did not do while they were off the stage); `pending()` is true while a
// picture is still loading (a bitmap made now would show it empty); `raf` times rendered frames.
export function createTileLod({ leafer, world, perf, pageW, pageH, pixelRatio: initialPixelRatio, getPages, getSize, onExit = () => {}, pending = () => false, busy = () => false, now = () => performance.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id), raf = (fn) => requestAnimationFrame(fn) }) {
  let mode = perf.pageBitmaps
  let pixelRatio = initialPixelRatio
  const layer = new Group({ hittable: false, hitChildren: false })
  const tiles = new Map() // 'c,r' -> { node, built }
  let version = 0
  let active = false
  let slow = mode === 'always'
  let gaps = []
  let lastView = 0
  let lastEdit = -Infinity
  let step = 0 // the smoothed gap between two steps of a pan or zoom, ms
  let sampling = false
  let freeTimer = null
  let quietTimer = null
  let buildTimer = null
  let at = 0 // where the vectors sit in the stage's stack
  let latest = { x: 0, y: 0, scale: 1 }
  const counters = { views: 0, enters: 0, exits: 0, builds: 0, buildMs: 0, notReady: 0, maxBuildMs: 0, maxBandMs: 0, evicted: 0, jitBuilds: 0, jitMs: 0 }
  let job = null // the page bitmap being drawn band by band: { c, r, tile, band, ms }

  const key = (c, r) => `${c},${r}`
  // The bitmaps are made for the zoom the view has now (a little finer), not for the finest zoom they may be shown at: the fewer pixels a
  // moving frame has to copy and scale, the cheaper it is, and a bitmap is only on screen for a moment. A bitmap far off the zoom of the
  // view is made again when things are quiet.
  const OVERSAMPLE = 1.25
  const hybrid = () => Boolean(perf.hybrid)
  const tileScale = (view) => {
    const { columns, rows } = getPages()
    const fit = Math.sqrt(MEMORY_BUDGET / Math.max(1, columns * rows * (pageW + 2 * BLEED) * (pageH + 2 * BLEED) * 4))
    return Math.max(0.1, Math.min(view.scale * pixelRatio * OVERSAMPLE, perf.lodZoom * pixelRatio, fit))
  }
  // Hybrid: the resolution of each page's bitmap by how near the page is to the window. `tier` 0 = on screen, 1 = within a tenth of a page of it, 2 = the
  // rest. Pages on screen get the device resolution while they fit in 80% of the budget, the near ones what is left (75%), the far ones the remainder.
  const AREA = (pageW + 2 * BLEED) * (pageH + 2 * BLEED) * 4 // bytes of one page's bitmap at scale 1
  const count = (box) => Math.max(0, box.c1 - box.c0 + 1) * Math.max(0, box.r1 - box.r0 + 1)
  const tierOf = (box, c, r) => (c >= box.c0 && c <= box.c1 && r >= box.r0 && r <= box.r1 ? 1 : 2)
  function planFor(view) {
    const { columns, rows } = getPages()
    const strict = visible(view, 0)
    const near = visible(view, 0.1)
    const nStrict = count(strict)
    const nNear = count(near) - nStrict
    const nFar = columns * rows - count(near)
    const full = view.scale * pixelRatio
    const { scales, crisp } = planScales({ full, strict: nStrict, near: nNear, far: nFar, area: AREA, budget: (perf.tileBudget ?? 128) * 1024 * 1024 })
    return { strict, near, scales, full, crisp }
  }
  // The scale of page (c, r)'s bitmap for `view`, and how far off a bitmap may be before it is made again.
  function targetFor(view, c, r, plan = planFor(view)) {
    if (!hybrid()) return { scale: tileScale(view), low: 0.5, high: 1.6 }
    const tier = plan.strict && c >= plan.strict.c0 && c <= plan.strict.c1 && r >= plan.strict.r0 && r <= plan.strict.r1 ? 0 : tierOf(plan.near, c, r)
    return { scale: plan.scales[tier], low: tier === 0 ? 0.97 : tier === 1 ? 0.8 : 0.5, high: 1.6 }
  }
  const stale = (tile, view, c, r, plan) => {
    const { scale, low, high } = targetFor(view, c, r, plan)
    const ratio = (tile.scale || 1) / scale
    return ratio < low || ratio > high
  }

  // The pages on screen (with a margin of one page's tenth), as { c0, c1, r0, r1 } (inclusive).
  function visible(view, margin = 0.1) {
    const { columns, rows } = getPages()
    const size = getSize()
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
  function failed(error) {
    // Something in the engine did not take it: no bitmaps from now on, the vectors carry on as before.
    console.warn('page bitmaps are off:', error)
    mode = 'off'
    job = null
    exit()
    for (const tile of tiles.values()) tile.node.destroy?.()
    tiles.clear()
  }
  function build(c, r) {
    try { buildTile(c, r) } catch (error) { failed(error) }
  }

  // One page's bitmap is drawn in bands (BANDS), each clipped to its rows, one per timer tick: the longest synchronous stretch is a band, not a page.
  function beginTile(c, r, plan) {
    const scale = targetFor(latest, c, r).scale
    const width = pageW + 2 * BLEED
    const height = pageH + 2 * BLEED
    let tile = tiles.get(key(c, r))
    if (!tile) {
      if (plan) enforceBudget(plan, AREA * scale * scale)
      tile = { node: new Canvas({ x: c * pageW - BLEED, y: r * pageH - BLEED, width, height, pixelRatio: scale, hittable: false, smooth: true }), built: -1, scale }
      tiles.set(key(c, r), tile)
    } else if (tile.scale !== scale) {
      if (plan && scale > tile.scale) enforceBudget(plan, AREA * (scale * scale - tile.scale * tile.scale))
      tile.node.pixelRatio = scale
      tile.scale = scale
    }
    tile.built = -1 // (half drawn: never shown)
    const { context, view } = tile.node.canvas
    // Cleared whole, whatever transform the last draw left on the context (a clear under a scale clears only part of it).
    context.save()
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, view.width, view.height)
    context.restore()
    return { c, r, tile, band: 0, ms: 0, version }
  }

  function drawBand(task) {
    const t0 = now()
    const { c, r, tile } = task
    const { canvas } = tile.node
    const { context, view } = canvas
    const width = pageW + 2 * BLEED
    const height = pageH + 2 * BLEED
    const from = Math.round((task.band * view.height) / BANDS)
    const to = Math.round(((task.band + 1) * view.height) / BANDS)
    const matrix = new Matrix(world.worldTransform).invert()
    matrix.multiplyParent(new Matrix().translate(BLEED - c * pageW, BLEED - r * pageH))
    context.save()
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.beginPath()
    context.rect(0, from, view.width, to - from)
    context.clip()
    try {
      world.__render(canvas, { matrix: matrix.withScale(), bounds: new Bounds(0, (task.band * height) / BANDS - 1, width, height / BANDS + 2) })
    } finally { context.restore() }
    task.band += 1
    const spent = now() - t0
    task.ms += spent
    counters.maxBandMs = Math.max(counters.maxBandMs, spent)
    return task.band >= BANDS
  }

  function finishTile(task) {
    task.tile.node.paint()
    task.tile.built = task.version
    counters.builds += 1
    counters.buildMs += task.ms
    counters.maxBuildMs = Math.max(counters.maxBuildMs, task.ms)
  }

  function buildTile(c, r) { // all at once (checks)
    const task = beginTile(c, r, null)
    while (!drawBand(task)) { /* band after band */ }
    finishTile(task)
  }

  // Bitmaps of pages that are not in the note any more (the grid folded back) are let go.
  function prune() {
    const { columns, rows } = getPages()
    for (const [id, tile] of tiles) {
      const [c, r] = id.split(',').map(Number)
      if (c >= columns || r >= rows) { if (job && job.tile === tile) job = null; tile.node.remove(); tile.node.destroy?.(); tiles.delete(id) }
    }
  }

  const bytesOf = (tile) => { const { width, height } = tile.node.canvas?.view ?? {}; return (width ?? 0) * (height ?? 0) * 4 }
  // Hybrid: the bitmaps made for an earlier view hold memory until they are made again; the ones furthest from the window go first when the total
  // is over the budget (the pages near the window are never let go for it, so the total can pass the budget by at most the pages in and next to the window:
  // the plan keeps those inside 80% + 75% of what is left, and the check in the hybrid verify reports the number).
  function enforceBudget(plan, extra = 0) {
    const budget = (perf.tileBudget ?? 128) * 1024 * 1024
    let total = 0
    for (const tile of tiles.values()) total += bytesOf(tile)
    if (total + extra <= budget) return
    const centre = { c: (plan.near.c0 + plan.near.c1) / 2, r: (plan.near.r0 + plan.near.r1) / 2 }
    const far = []
    for (const [id, tile] of tiles) {
      const [c, r] = id.split(',').map(Number)
      if (c >= plan.near.c0 && c <= plan.near.c1 && r >= plan.near.r0 && r <= plan.near.r1) continue
      if (job && job.tile === tile) continue // (the page being drawn stays)
      far.push({ id, tile, distance: Math.hypot(c - centre.c, r - centre.r) })
    }
    far.sort((x, y) => y.distance - x.distance)
    for (const { id, tile } of far) {
      if (total + extra <= budget) break
      counters.evicted += 1
      total -= bytesOf(tile)
      tile.node.remove()
      tile.node.destroy?.()
      tiles.delete(id)
    }
  }

  // Idle time: the pages on screen first, then the rest, one page at a time.
  function buildNext() {
    buildTimer = null
    if (active || (mode === 'off') || !slow) return
    if (!hybrid() && latest.scale >= perf.lodZoom) return // not while the view is zoomed in: nothing would use them
    const plan = hybrid() ? planFor(latest) : null
    if (plan && !plan.crisp) return // zoomed in too far for the bitmaps to be crisp: the vectors are cheap there, nothing would use them
    prune()
    if (plan) enforceBudget(plan)
    if (pending()) { buildTimer = schedule(buildNext, 500); return } // a picture is still loading
    if (busy() || now() - lastView < BUSY_RETRY || now() - lastEdit < EDIT_QUIET) { buildTimer = schedule(buildNext, now() - lastEdit < EDIT_QUIET ? EDIT_QUIET : BUSY_RETRY); return } // a gesture or an edit is going on: not now
    if (job && tiles.get(key(job.c, job.r)) !== job.tile) job = null // (its page went)
    if (job) { // the page being drawn goes on, a band at a time
      try { if (drawBand(job)) { finishTile(job); job = null; if (plan) enforceBudget(plan) } } catch (error) { failed(error); return }
      buildTimer = schedule(buildNext, job ? BAND_GAP : 40)
      return
    }
    const { columns, rows } = getPages()
    const box = visible(latest)
    const order = []
    each(box, (c, r) => order.push([c, r]))
    for (let r = 0; r < rows; r += 1) for (let c = 0; c < columns; c += 1) if (!(c >= box.c0 && c <= box.c1 && r >= box.r0 && r <= box.r1)) order.push([c, r])
    if (plan) order.sort((a, b) => (targetFor(latest, a[0], a[1], plan).scale >= plan.scales[0] ? 0 : 1) - (targetFor(latest, b[0], b[1], plan).scale >= plan.scales[0] ? 0 : 1)) // (stable: the pages on screen first)
    const next = order.find(([c, r]) => { const tile = tiles.get(key(c, r)); return !tile || tile.built !== version || stale(tile, latest, c, r, plan ?? undefined) })
    if (!next) return
    try { job = beginTile(next[0], next[1], plan) } catch (error) { failed(error); return }
    buildTimer = schedule(buildNext, BAND_GAP)
  }
  function wantBuild(delay = 400) {
    if (mode === 'off' || !slow || buildTimer || active) return
    buildTimer = schedule(buildNext, delay)
  }

  function place(view) {
    layer.set({ x: view.x, y: view.y, scaleX: view.scale, scaleY: view.scale })
  }

  // The pages a navigation that starts now cannot show as they are: no bitmap, a bitmap of an earlier note (an edit), or, on the pages on screen, one made for
  // much less than the zoom the view has now (soft). Every other page shows its bitmap as it is.
  function lacking(view) {
    const plan = hybrid() ? planFor(view) : null
    const list = []
    each(visible(view), (c, r) => {
      const tile = tiles.get(key(c, r))
      const onScreen = plan && c >= plan.strict.c0 && c <= plan.strict.c1 && r >= plan.strict.r0 && r <= plan.strict.r1
      const soft = onScreen && tile && tile.scale < targetFor(view, c, r, plan).scale * SOFT
      if (!tile || tile.built !== version || soft) list.push([c, r])
    })
    return list
  }

  // Is the whole window covered by bitmaps good enough to show? (Hybrid also needs them crisp: see CRISP.)
  function usable(view) {
    if (!hybrid()) return true
    return planFor(view).crisp
  }

  function enter(view) {
    const box = visible(view)
    if (!usable(view)) return false
    const lack = lacking(view)
    if (lack.length) {
      // Mixed: the pages that are fine show their bitmaps from the first step, and only the lacking ones are drawn now (from the live vectors, a page's
      // worth of the objects each, before the vectors are taken off the stage). The vectors of the whole window cannot be kept on the stage for the others:
      // the engine draws every object it can see at every step, whatever is clipped, and that is the cost the bitmaps are there to avoid.
      const expected = lack.length * (counters.builds ? counters.buildMs / counters.builds : 0)
      if (!hybrid() || (lack.length > 1 && expected > JIT_MS) || pending()) { counters.notReady += 1; wantBuild(60); return false }
      job = null // (a page the idle build is drawing is made again whole below: its remaining bands must not be drawn over the finished page)
      const t0 = now()
      try { for (const [c, r] of lack) buildTile(c, r) } catch (error) { failed(error); return false }
      counters.jitBuilds += lack.length
      counters.jitMs += now() - t0
      enforceBudget(planFor(view))
    }
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
  function view(next, { zoomedOutLimit = hybrid() ? Infinity : perf.lodZoom, allowEnter = true } = {}) {
    latest = next
    counters.views += 1
    job = null // a page half drawn when the view moves is drawn again from the start later (the bands must all be drawn at one placement of the note)
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
    if (hybrid() && !usable(next)) { // zoomed far in: the pages cannot be made crisp, the vectors carry the view (few objects are on screen)
      if (active) exit()
      if (!freeTimer && tiles.size) freeTimer = schedule(() => { freeTimer = null; if (!usable(latest)) { for (const tile of tiles.values()) tile.node.destroy?.(); tiles.clear(); version += 1 } }, FREE_AFTER)
      return false
    }
    if (!active) {
      // Is this machine slow at it? The frames the screen really shows while the view moves tell (the steps of a pan come at the pace of the frames).
      if (mode === 'adaptive' && !slow) sample()
      if (slow) wantBuild(400) // (a no-op once they are all made)
      if (!slow || !allowEnter || (!moving && !hybrid())) return false
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
    // Hybrid: `rects` ([{ left, top, right, bottom }] in page space) are the places that changed; only the pages they touch are out of date.
    invalidate(rects) {
      exit()
      job = null
      lastEdit = now()
      if (hybrid() && rects?.length) {
        for (const [id, tile] of tiles) {
          const [c, r] = id.split(',').map(Number)
          const left = c * pageW - BLEED
          const top = r * pageH - BLEED
          if (rects.some((rect) => rect.right >= left && rect.left <= left + pageW + 2 * BLEED && rect.bottom >= top && rect.top <= top + pageH + 2 * BLEED)) tile.built = -1
        }
      } else version += 1
      wantBuild(hybrid() ? 120 : 900)
    },
    // A different note, or a different grid: the bitmaps of the old one go.
    reset() {
      exit()
      job = null
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
      job = null
      exit()
      for (const tile of tiles.values()) tile.node.destroy?.()
      tiles.clear()
      version += 1
      wantBuild(600)
    },
    get active() { return active },
    stats: () => {
      let bytes = 0
      for (const tile of tiles.values()) bytes += bytesOf(tile)
      let visibleReady = true
      const plan = hybrid() ? planFor(latest) : null
      each(visible(latest, 0), (c, r) => { const tile = tiles.get(key(c, r)); if (!tile || tile.built !== version || stale(tile, latest, c, r, plan ?? undefined)) visibleReady = false })
      if (visibleReady && !ready(visible(latest))) visibleReady = false // (the pages next to the window too: a pan shows them next)
      return { mode, active, slow, hybrid: hybrid(), jobActive: Boolean(job), jobBand: job ? job.band : -1, visibleReady, lacking: lacking(latest).length, crisp: plan ? plan.crisp : null, scales: plan ? plan.scales : null, tiles: tiles.size, current: [...tiles.values()].filter((tile) => tile.built === version).length, bytes, ...counters }
    },
    // For checks: the tile of one page ({ c, r }) as { scale, built } (or null).
    tileOf(c, r) { const tile = tiles.get(key(c, r)); return tile ? { scale: tile.scale, built: tile.built === version, canvas: tile.node.canvas?.view } : null },
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
