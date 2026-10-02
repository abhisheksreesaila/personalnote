// The rules for text and sticky editing on the document model (F-029), as pure functions: no Leafer, no DOM, tested in Node.
// scene.js and text.js call these; an edit is an `op` of { id, before, after } changes for the undo history (core/document/history.js).
import { paletteKeyFor } from '../../core/document/palette.js'
import { isLocked } from '../../core/document/operations.js'
import { STICKY_MIN_HEIGHT, STICKY_PADDING, STICKY_WIDTH } from '../editor/objects.js'
import { applyMatrix, placementMatrix } from './placement.js'
import { prettifyText } from '../editor/prettify.js'

const UPRIGHT = { rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const isTextual = (object) => object?.type === 'text' || object?.type === 'sticky'
const byId = (doc, id) => doc.objects.find((object) => object?.id === id)

export const nextZ = (doc) => doc.objects.reduce((top, object, index) => Math.max(top, (object?.z ?? index) + 1), 0)

// A text made by a click: the way the Fabric path makes one (an IText, so a point text that is as wide as its words).
// `style` is the model's text style (fontFamily, fontSize, color ...).
export function newText({ id, z, point, style }) {
  return { id, type: 'text', mode: 'point', z, content: '', style: { fontWeight: 'normal', fontStyle: 'normal', textAlign: 'left', lineHeight: 1.45, padding: 8, ...style }, geometry: { x: point.x, y: point.y, width: 0, height: 0, ...UPRIGHT } }
}

// A sticky made by a click is centred on it, empty. `fill` is the paper, `ink` the writing.
export function newSticky({ id, z, point, fill, ink, style }) {
  const width = STICKY_WIDTH
  const height = STICKY_MIN_HEIGHT
  const object = { id, type: 'sticky', z, content: '', color: fill, style: { ...style, color: ink }, geometry: { x: point.x - width / 2, y: point.y - height / 2, width, height, ...UPRIGHT } }
  const key = paletteKeyFor(fill)
  if (key) object.colorKey = key
  return object
}

const result = (label, changes) => ({ op: { label, changes } })

// New words (and the size they now need) for one text or sticky. Nothing to record when nothing changed; a locked object refuses.
export function planSetContent(doc, { id, content, geometry }) {
  const object = byId(doc, id)
  if (!isTextual(object) || isLocked(object)) return result('Edit text', [])
  const patch = geometry ? { ...object.geometry, ...geometry } : object.geometry
  const same = (object.content ?? '') === content && Object.keys(patch).every((key) => patch[key] === object.geometry[key])
  if (same) return result('Edit text', [])
  return result('Edit text', [{ id, before: object, after: { ...object, content, geometry: patch } }])
}

// A style change for the text and stickies among `ids`: `style` (font, size, colour ...) is merged into the text style; `paper`
// ({ fill, ink }) is the sticky's colour and its writing colour. Locked objects stay as they are.
export function planSetStyle(doc, { ids, style, paper }) {
  const changes = []
  for (const id of ids) {
    const object = byId(doc, id)
    if (!isTextual(object) || isLocked(object)) continue
    let after = object
    if (style) after = { ...after, style: { ...after.style, ...style } }
    if (paper && object.type === 'sticky') {
      after = { ...after, color: paper.fill, style: { ...after.style, color: paper.ink } }
      const key = paletteKeyFor(paper.fill)
      if (key) after.colorKey = key
      else delete after.colorKey
    }
    if (after !== object) changes.push({ id, before: object, after })
  }
  return result('Text style', changes)
}

// Prettify (the same mechanical tidy as the Fabric path: prettifyText on the whole of each text) for every text and sticky that is not
// locked. `fit(object)` gives the geometry the new words need. One op, so one undo step; nothing to record when all is tidy already.
export function planPrettify(doc, { fit }) {
  const changes = []
  for (const object of doc.objects) {
    if (!isTextual(object) || isLocked(object)) continue
    const content = prettifyText(object.content ?? '')
    if (content === (object.content ?? '')) continue
    const next = { ...object, content }
    changes.push({ id: object.id, before: object, after: { ...next, geometry: fit(next) } })
  }
  return result('Prettify', changes)
}

// The geometry an object has once its words are measured: `content` is the size of the laid-out words ({ width, height }, for a
// sticky inside its padding). A point text is as big as its words; a text box keeps its width and is as tall as its lines; a sticky
// keeps its width, grows to hold its words, and is never shorter than the minimum or than it already is. The top-left corner stays
// where it is on the page, whether the object is turned or not (the box turns about its centre, which moves when the size does).
export function fitGeometry(object, content) {
  const g = object.geometry
  let width = g.width
  let height = g.height
  if (object.type === 'sticky') height = Math.max(STICKY_MIN_HEIGHT, content.height + STICKY_PADDING * 2)
  else if (object.mode === 'point') { width = content.width; height = content.height } else height = content.height
  if (width === g.width && height === g.height) return g
  const corner = applyMatrix(placementMatrix(g), { x: 0, y: 0 })
  const moved = applyMatrix(placementMatrix(g, { width, height }), { x: 0, y: 0 })
  return { ...g, width, height, x: (g.x ?? 0) + corner.x - moved.x, y: (g.y ?? 0) + corner.y - moved.y }
}

// A page point in an object's own frame (origin at its box's top-left corner, before any transform), or null for a degenerate matrix.
export function toLocal(geometry, size, point) {
  const m = placementMatrix(geometry, size)
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) < 1e-12) return null
  const dx = point.x - m.e
  const dy = point.y - m.f
  return { x: (m.d * dx - m.c * dy) / det, y: (-m.b * dx + m.a * dy) / det }
}

// The topmost text or sticky (not locked) under a page point. `sizes` maps id -> { width, height } for objects whose size is not stored.
export function objectAt(doc, sizes, point) {
  const order = doc.objects.map((object, index) => [object, index]).sort(([a, i], [b, j]) => ((b.z ?? j) - (a.z ?? i)) || (j - i))
  for (const [object] of order) {
    if (!isTextual(object) || isLocked(object) || !object.geometry) continue
    const size = sizes.get(object.id) ?? {}
    const width = size.width ?? object.geometry.width ?? 0
    const height = size.height ?? object.geometry.height ?? 0
    const local = toLocal(object.geometry, { width, height }, point)
    if (local && local.x >= 0 && local.x <= width && local.y >= 0 && local.y <= height) return object
  }
  return null
}
