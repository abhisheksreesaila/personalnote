// Ink in the document model (F-031): turning a drawn gesture into model objects, and the vector eraser. Pure JS (no Leafer, no DOM),
// so it is tested in Node. What it must match is the Fabric pen and eraser:
//   pen        decimated points, smoothed through quadratic midpoints (Fabric's PencilBrush path), round caps and joins
//   highlight  the same stroke with the colour at alpha 0x55 (a third); a tap is a dot
//   eraser     a stroke is split where the eraser passes (radius 13 page pixels + half the stroke width); the pieces that remain are
//              straight-line fragments through the stroke's points, densified to a 4 px spacing; a dot goes whole when touched
// Ink geometry is in its path's bounding-box frame (core/document/schema.js "ink frame"): path and points are relative to the box's
// top-left corner and the box sits at geometry.x, geometry.y.
import { isLocked, stacking } from '../../core/document/operations.js'
import { pathBounds, shiftPath } from '../../core/document/geometry.js'
import { applyMatrix, placementMatrix } from './placement.js'

export const ERASER_RADIUS = 13
export const HIGHLIGHT_ALPHA = 0x55 / 255
export const DECIMATE = 0.8 // page pixels at zoom 1 (Fabric divides by the zoom)
const FRAGMENT_SPACING = 4

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y)
export const newInkId = () => `res_${globalThis.crypto.randomUUID().replaceAll('-', '')}`

// Fabric's decimatePoints: keep the first and last, and any point at least `minimum` from the last one kept.
export function decimate(points, minimum = DECIMATE) {
  if (points.length <= 2) return points
  const kept = [points[0]]
  let last = points[0]
  for (let index = 1; index < points.length - 1; index += 1) {
    if (distance(last, points[index]) >= minimum) { last = points[index]; kept.push(last) }
  }
  kept.push(points[points.length - 1])
  return kept
}

// Fabric's createSVGPathFromPoints: M first, a Q per point (control = the point, end = the midpoint to the next), L last.
export function smoothPath(points) {
  const path = [['M', points[0].x, points[0].y]]
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    if (from.x !== to.x || from.y !== to.y) path.push(['Q', from.x, from.y, (from.x + to.x) / 2, (from.y + to.y) / 2])
  }
  const last = points[points.length - 1]
  path.push(['L', last.x, last.y])
  return path
}

const IDENTITY = { rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const COMMON = { opacity: 1, visible: true, strokeUniform: false, blend: 'source-over', extras: {} }

// The stacking value above everything now there.
export function topZ(doc) {
  let top = -1
  doc.objects.forEach((object, index) => { top = Math.max(top, object?.z ?? index) })
  return top + 1
}

function tinted(tool, color) {
  return tool === 'highlight' ? { color, alpha: HIGHLIGHT_ALPHA } : { color }
}

// A drawn stroke -> a model object. `points` are page coordinates as the pointer gave them; `scale` is the view zoom (the decimation
// distance is in screen pixels, like Fabric's). Fewer than two distinct points make a dot.
export function inkObject({ points, tool, color, width, z, scale = 1, id = newInkId() }) {
  const distinct = points.filter((point, index) => index === 0 || point.x !== points[0].x || point.y !== points[0].y)
  if (distinct.length < 2) return dotObject({ point: points[0], tool, color, width, z, id })
  const kept = decimate(points, DECIMATE / scale)
  const path = smoothPath(kept)
  const bounds = pathBounds(path)
  return {
    type: 'ink', z, id,
    geometry: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height, ...IDENTITY },
    ...COMMON, kind: 'stroke', tool, width, cap: 'round', join: 'round', ...tinted(tool, color),
    path: shiftPath(path, -bounds.left, -bounds.top),
    points: kept.map((point) => ({ x: point.x - bounds.left, y: point.y - bounds.top })),
  }
}

export function dotObject({ point, tool, color, width, z, id = newInkId() }) {
  const radius = width / 2
  return {
    type: 'ink', z, id,
    geometry: { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2, ...IDENTITY },
    ...COMMON, kind: 'dot', tool, radius, ...tinted(tool, color),
  }
}

// The one undo step for a new stroke. `pages` is the page grid after the stroke when it grew one ({ before, after }).
export function drawOp(object, pages) {
  const op = { label: object.tool === 'highlight' ? 'Highlight' : 'Draw', changes: [{ id: object.id, before: null, after: object }], selection: { before: [], after: [] } }
  if (pages) op.page = pages
  return op
}

// ---- the eraser

function sampleCurve(start, controls, steps) {
  const points = []
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps
    const u = 1 - t
    if (controls.length === 2) points.push({ x: u * u * start.x + 2 * u * t * controls[0].x + t * t * controls[1].x, y: u * u * start.y + 2 * u * t * controls[0].y + t * t * controls[1].y })
    else points.push({ x: u ** 3 * start.x + 3 * u * u * t * controls[0].x + 3 * u * t * t * controls[1].x + t ** 3 * controls[2].x, y: u ** 3 * start.y + 3 * u * u * t * controls[0].y + 3 * u * t * t * controls[1].y + t ** 3 * controls[2].y })
  }
  return points
}

// Points along a path's commands (what Fabric's samplePathCommands gives a stroke that never had inkPoints).
export function samplePath(path) {
  const points = []
  let current = { x: 0, y: 0 }
  let subpath = current
  const push = (point) => { const previous = points.at(-1); if (!previous || distance(previous, point) > 0.01) points.push(point) }
  for (const command of path) {
    if (command[0] === 'M') { current = { x: command[1], y: command[2] }; subpath = current; push(current) }
    else if (command[0] === 'L') { current = { x: command[1], y: command[2] }; push(current) }
    else if (command[0] === 'Q') {
      const control = { x: command[1], y: command[2] }
      const end = { x: command[3], y: command[4] }
      sampleCurve(current, [control, end], Math.max(2, Math.ceil((distance(current, control) + distance(control, end)) / 5))).forEach(push)
      current = end
    } else if (command[0] === 'C') {
      const first = { x: command[1], y: command[2] }
      const second = { x: command[3], y: command[4] }
      const end = { x: command[5], y: command[6] }
      sampleCurve(current, [first, second, end], Math.max(3, Math.ceil((distance(current, first) + distance(first, second) + distance(second, end)) / 5))).forEach(push)
      current = end
    } else if (command[0] === 'Z') { current = subpath; push(current) }
  }
  return points
}

export function densify(points, spacing = FRAGMENT_SPACING) {
  if (points.length < 2) return points
  const dense = [points[0]]
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    const steps = Math.max(1, Math.ceil(distance(start, end) / spacing))
    for (let step = 1; step <= steps; step += 1) dense.push({ x: start.x + (end.x - start.x) * (step / steps), y: start.y + (end.y - start.y) * (step / steps) })
  }
  return dense
}

const meanScale = (matrix) => (Math.hypot(matrix.a, matrix.b) + Math.hypot(matrix.c, matrix.d)) / 2

// The stroke's points on the page, densified; its width on the page; and the page box that holds all of it.
function pageGeometry(object) {
  const g = object.geometry
  const matrix = placementMatrix(g, { width: g.width, height: g.height })
  const scale = meanScale(matrix)
  if (object.kind === 'dot') {
    const center = applyMatrix(matrix, { x: g.width / 2, y: g.height / 2 })
    const radius = Math.max(Math.abs((g.width ?? 0) * (g.scaleX ?? 1)), Math.abs((g.height ?? 0) * (g.scaleY ?? 1))) / 2
    return { center, radius, box: { left: center.x - radius, top: center.y - radius, right: center.x + radius, bottom: center.y + radius } }
  }
  const raw = Array.isArray(object.points) && object.points.length > 1 ? object.points : samplePath(object.path ?? [])
  const points = densify(raw.map((point) => applyMatrix(matrix, point)))
  const half = (object.width ?? 1) * scale / 2
  let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity
  for (const point of points) { left = Math.min(left, point.x); top = Math.min(top, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y) }
  return { points, half, scale, box: { left: left - half, top: top - half, right: right + half, bottom: bottom + half } }
}

function fragmentObject(points, source, scale, z) {
  const path = [['M', points[0].x, points[0].y], ...points.slice(1).map((point) => ['L', point.x, point.y])]
  const bounds = pathBounds(path)
  const fragment = {
    type: 'ink', z, id: newInkId(),
    geometry: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height, ...IDENTITY },
    opacity: source.opacity ?? 1, visible: source.visible ?? true, strokeUniform: false, blend: source.blend ?? 'source-over', extras: {},
    kind: 'stroke', tool: source.tool, width: (source.width ?? 1) * scale, cap: 'round', join: 'round', color: source.color,
    path: shiftPath(path, -bounds.left, -bounds.top),
    points: points.map((point) => ({ x: point.x - bounds.left, y: point.y - bounds.top })),
  }
  if (source.alpha !== undefined) fragment.alpha = source.alpha
  return fragment
}

// One erasing gesture over a document. The document is not changed: each `at` / `between` returns what changed on screen
// ({ removed: [ids], added: [objects] }, or null) and `plan()` gives the whole gesture as one undo step.
export function createEraser(doc, { radius = ERASER_RADIUS } = {}) {
  const originals = new Map() // id -> the object as the document has it, for each original removed or split
  const added = new Map() // id -> the fragment objects standing now
  const live = [] // { object, geometry } the ink an eraser can still touch
  const stack = stacking(doc).map((object, index) => object.z ?? index)
  for (const object of doc.objects) {
    if (object?.type !== 'ink' || !object.id || !object.geometry || isLocked(object)) continue
    live.push({ object, ...pageGeometry(object) })
  }

  const nextAbove = (z) => stack.filter((value) => value > z).reduce((least, value) => Math.min(least, value), z + 1)

  function remove(item) {
    live.splice(live.indexOf(item), 1)
    if (added.has(item.object.id)) added.delete(item.object.id)
    else originals.set(item.object.id, item.object)
  }

  function hit(item, point) {
    const { box } = item
    if (point.x < box.left - radius || point.x > box.right + radius || point.y < box.top - radius || point.y > box.bottom + radius) return false
    if (item.object.kind === 'dot') return distance(item.center, point) <= item.radius + radius
    const reach = radius + item.half
    return item.points.some((candidate) => distance(candidate, point) <= reach)
  }

  function eraseAt(point) {
    const removed = []
    const created = []
    for (const item of [...live]) {
      if (!hit(item, point)) continue
      remove(item)
      removed.push(item.object.id)
      if (item.object.kind === 'dot') continue
      const reach = radius + item.half
      const runs = []
      let run = []
      for (const candidate of item.points) {
        if (distance(candidate, point) > reach) run.push(candidate)
        else { if (run.length > 1) runs.push(run); run = [] }
      }
      if (run.length > 1) runs.push(run)
      const z = item.object.z ?? 0
      const top = nextAbove(z)
      runs.forEach((points, index) => {
        const fragment = fragmentObject(points, item.object, item.scale, z + (index * (top - z)) / runs.length)
        stack.push(fragment.z)
        added.set(fragment.id, fragment)
        live.push({ object: fragment, ...pageGeometry(fragment) })
        created.push(fragment)
      })
    }
    return removed.length ? { removed, added: created } : null
  }

  // The eraser's path from one pointer position to the next, a step at a time so a fast sweep leaves no gap.
  function between(from, to) {
    const steps = Math.max(1, Math.ceil(distance(from, to) / (radius * 0.45)))
    const removed = []
    const created = []
    for (let step = 1; step <= steps; step += 1) {
      const result = eraseAt({ x: from.x + (to.x - from.x) * (step / steps), y: from.y + (to.y - from.y) * (step / steps) })
      if (!result) continue
      for (const id of result.removed) {
        const at = created.findIndex((object) => object.id === id)
        if (at !== -1) created.splice(at, 1)
        else removed.push(id)
      }
      created.push(...result.added)
    }
    return removed.length || created.length ? { removed, added: created } : null
  }

  return {
    at: eraseAt,
    between,
    get changed() { return originals.size > 0 || added.size > 0 },
    // The gesture as one op, or null when nothing was erased.
    plan(pages) {
      const changes = [
        ...[...originals].map(([id, before]) => ({ id, before, after: null })),
        ...[...added.values()].map((object) => ({ id: object.id, before: null, after: object })),
      ]
      if (!changes.length) return null
      const op = { label: 'Erase', changes, selection: { before: [], after: [] } }
      if (pages) op.page = pages
      return op
    },
  }
}
