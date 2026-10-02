import assert from 'node:assert/strict'
import test from 'node:test'
import { createHistory } from '../../core/document/history.js'
import { PAGE } from '../../core/document/schema.js'
import { finalizeOp, growForDrag, settlePages, shiftedDocument, shiftedObject } from './pages.js'

const UPRIGHT = { rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const box = (id, x, y, width = 100, height = 60) => ({ id, type: 'image', z: 0, geometry: { x, y, width, height, ...UPRIGHT } })
const doc = (objects, columns = 1, rows = 1) => ({ schemaVersion: 1, page: { columns, rows }, objects: objects.map((object, z) => ({ ...object, z })), extras: {} })
const W = PAGE.width
const H = PAGE.height
const objectOf = (d, id) => d.objects.find((o) => o.id === id)
const rects = (left, top, right, bottom) => ({ left, top, right, bottom })

test('content past the right or bottom edge adds a page, up to 6 px of overflow is allowed', () => {
  assert.deepEqual(settlePages({ columns: 1, rows: 1 }, rects(10, 10, W + 6, 100)), { columns: 1, rows: 1, shiftX: 0, shiftY: 0 })
  assert.deepEqual(settlePages({ columns: 1, rows: 1 }, rects(10, 10, W + 7, H + 7)), { columns: 2, rows: 2, shiftX: 0, shiftY: 0 })
  assert.equal(settlePages({ columns: 1, rows: 1 }, rects(0, 0, 3 * W, 10)).columns, 3)
})

test('content past the left or top edge adds a page there and moves everything by a page', () => {
  assert.deepEqual(settlePages({ columns: 1, rows: 1 }, rects(-7, 10, 100, 100)), { columns: 2, rows: 1, shiftX: W, shiftY: 0 })
  assert.deepEqual(settlePages({ columns: 2, rows: 1 }, rects(10, -1200, W + 300, 100)), { columns: 2, rows: 3, shiftX: 0, shiftY: 2 * H })
  assert.deepEqual(settlePages({ columns: 1, rows: 1 }, rects(-6, 10, 100, 100)), { columns: 1, rows: 1, shiftX: 0, shiftY: 0 })
})

test('an emptied page folds back: the last one anywhere, the first one with everything moved back', () => {
  assert.deepEqual(settlePages({ columns: 3, rows: 1 }, rects(10, 10, W + 50, 100)), { columns: 2, rows: 1, shiftX: 0, shiftY: 0 })
  assert.deepEqual(settlePages({ columns: 3, rows: 1 }, rects(W + 20, 10, 2 * W + 40, 100)), { columns: 2, rows: 1, shiftX: -W, shiftY: 0 })
  assert.deepEqual(settlePages({ columns: 1, rows: 4 }, rects(10, 3 * H + 5, 100, 3 * H + 90)), { columns: 1, rows: 1, shiftX: 0, shiftY: -3 * H }) // folds all the way, not one page per edit
  assert.deepEqual(settlePages({ columns: 3, rows: 3 }, null), { columns: 1, rows: 1, shiftX: 0, shiftY: 0 })
})

test('while dragging, a page appears 24 px before the edge in every direction and nothing folds back', () => {
  assert.equal(growForDrag({ columns: 1, rows: 1 }, rects(100, 100, W - 25, 200)).changed, false)
  assert.deepEqual(growForDrag({ columns: 1, rows: 1 }, rects(100, 100, W - 23, 200)), { columns: 2, rows: 1, shiftX: 0, shiftY: 0, changed: true })
  assert.deepEqual(growForDrag({ columns: 1, rows: 1 }, rects(23, 100, 200, 200)), { columns: 2, rows: 1, shiftX: W, shiftY: 0, changed: true })
  assert.deepEqual(growForDrag({ columns: 1, rows: 1 }, rects(100, -100, 200, 200)), { columns: 1, rows: 2, shiftX: 0, shiftY: H, changed: true })
  assert.equal(growForDrag({ columns: 3, rows: 1 }, rects(100, 100, 200, 200)).changed, false)
})

test('an edit that pushes an object over the right edge adds a page in the same step, and one undo takes both back', () => {
  const before = doc([box('a', 100, 100), box('b', 300, 300)])
  const moved = { ...before.objects[0], geometry: { ...before.objects[0].geometry, x: W - 40 } }
  const { op, shift } = finalizeOp(before, { label: 'Move', changes: [{ id: 'a', before: before.objects[0], after: moved }] })
  assert.deepEqual(shift, { x: 0, y: 0 })
  assert.deepEqual(op.page, { before: { columns: 1, rows: 1 }, after: { columns: 2, rows: 1 }, shift: { x: 0, y: 0 } })
  const history = createHistory({ doc: before })
  history.record(op)
  assert.equal(history.doc.page.columns, 2)
  assert.equal(history.undo().page, true)
  assert.deepEqual(history.doc, before)
  history.redo()
  assert.equal(history.doc.page.columns, 2)
})

test('an object dragged over the left edge adds a page there: every object, connectors included, moves a page, and undo moves them back', () => {
  const a = box('a', 100, 100)
  const b = box('b', 400, 300)
  const connector = { id: 'c', type: 'connector', fromId: 'a', toId: 'b', z: 2, geometry: { x: 210, y: 130, width: 190, height: 200, ...UPRIGHT }, reverseX: false, reverseY: false }
  const before = doc([a, b, connector])
  const left = { ...a, geometry: { ...a.geometry, x: -50 } }
  const { op, shift } = finalizeOp(before, { label: 'Move', changes: [{ id: 'a', before: a, after: left }] })
  assert.deepEqual(shift, { x: W, y: 0 })
  assert.deepEqual(op.page.shift, { x: W, y: 0 })
  const history = createHistory({ doc: before })
  history.record(op)
  const next = history.doc
  const at = (id) => next.objects.find((object) => object.id === id)
  assert.equal(at('a').geometry.x, -50 + W)
  assert.equal(at('b').geometry.x, 400 + W)
  assert.equal(next.page.columns, 2)
  const ends = at('c').geometry
  assert.ok(ends.x >= -50 + W + 100, 'the arrow starts at the moved object, past its right edge')
  const undone = history.undo()
  assert.deepEqual(undone.pageShift, { x: -W, y: 0 })
  assert.deepEqual(history.doc, before)
  assert.deepEqual(history.redo().pageShift, { x: W, y: 0 })
})

test('moving an object moves the connectors on it, both ends, and no other connector', () => {
  const a = box('a', 100, 100)
  const b = box('b', 400, 100)
  const c = box('c', 100, 600)
  const first = { id: 'ab', type: 'connector', fromId: 'a', toId: 'b', z: 3, geometry: { x: 206, y: 130, width: 188, height: 1, ...UPRIGHT }, reverseX: false, reverseY: false }
  const second = { id: 'ca', type: 'connector', fromId: 'c', toId: 'a', z: 4, geometry: { x: 150, y: 166, width: 1, height: 428, ...UPRIGHT }, reverseX: false, reverseY: true }
  const before = doc([a, b, c, first, second])
  const moved = { ...b, geometry: { ...b.geometry, y: 300 } }
  const { op } = finalizeOp(before, { label: 'Move', changes: [{ id: 'b', before: b, after: moved }] })
  assert.deepEqual(op.changes.map((change) => change.id).sort(), ['ab', 'b'])
  const arrow = op.changes.find((change) => change.id === 'ab').after
  assert.ok(arrow.geometry.height > 50, 'the arrow now runs down to the moved object')
  assert.equal(arrow.reverseX, false)
})

test('a connector left without an end goes with it', () => {
  const a = box('a', 100, 100)
  const b = box('b', 400, 100)
  const link = { id: 'ab', type: 'connector', fromId: 'a', toId: 'b', z: 2, geometry: { x: 206, y: 130, width: 188, height: 1, ...UPRIGHT }, reverseX: false, reverseY: false }
  const { op } = finalizeOp(doc([a, b, link]), { label: 'Erase', changes: [{ id: 'b', before: b, after: null }] })
  assert.deepEqual(op.changes.map((change) => [change.id, change.after]).sort(), [['ab', null], ['b', null]])
})

test('an object that arrives after a step that moved the frame is moved back with the rest when the step is undone, and forward again on redo', () => {
  const a = box('a', 100, 100)
  const b = box('b', 400, 300)
  const before = doc([a, b])
  const { op } = finalizeOp(before, { label: 'Move', changes: [{ id: 'a', before: a, after: { ...a, geometry: { ...a.geometry, x: -50 } } }] })
  const history = createHistory({ doc: before })
  history.record(op)
  assert.equal(objectOf(history.doc, 'b').geometry.x, 400 + W)
  // an agent writes an object in the user's frame (the merge put it there)
  history.mergeRemote({ ...history.doc, objects: [...history.doc.objects, { ...box('agent', 120 + W, 900), z: 9 }] })
  history.undo()
  assert.equal(objectOf(history.doc, 'agent').geometry.x, 120)
  assert.equal(objectOf(history.doc, 'agent').geometry.y, 900)
  assert.equal(objectOf(history.doc, 'b').geometry.x, 400)
  history.redo()
  assert.equal(objectOf(history.doc, 'agent').geometry.x, 120 + W)
  assert.equal(objectOf(history.doc, 'b').geometry.x, 400 + W)
})

test('the op names only what the edit changed: the other objects are not part of it', () => {
  const a = box('a', 100, 100)
  const before = doc([a, box('b', 400, 300)])
  const { op } = finalizeOp(before, { label: 'Move', changes: [{ id: 'a', before: a, after: { ...a, geometry: { ...a.geometry, x: -50 } } }] })
  assert.deepEqual(op.changes.map((change) => change.id), ['a'])
  assert.equal(op.changes[0].after.geometry.x, -50 + W)
  assert.deepEqual(op.page.shift, { x: W, y: 0 })
})

test('an unknown object moves with the frame and keeps the page it is on from folding', () => {
  const raw = { type: 'Triangle', left: W + 100, top: 50, width: 80, height: 60 }
  const unknown = { type: 'unknown', z: 1, raw }
  assert.equal(shiftedObject(unknown, 5, 7).raw.left, W + 105)
  assert.equal(shiftedObject(unknown, 5, 7).raw.top, 57)
  const a = box('a', 100, 100)
  const before = { ...doc([a], 2, 1), objects: [{ ...a, z: 0 }, unknown] }
  const { op } = finalizeOp(before, { label: 'Move', changes: [{ id: 'a', before: a, after: { ...a, geometry: { ...a.geometry, x: 120 } } }] })
  assert.equal(op.page, undefined, 'the second page stays: something is on it')
})

test('moving everything off the right page folds it away in the same step', () => {
  const a = box('a', W + 100, 100)
  const before = doc([a, box('b', 20, 20)], 2, 1)
  const home = { ...a, geometry: { ...a.geometry, x: 300 } }
  const { op } = finalizeOp(before, { label: 'Move', changes: [{ id: 'a', before: a, after: home }] })
  assert.deepEqual(op.page.after, { columns: 1, rows: 1 })
})

test('a re-stack or a lock does not touch the page grid', () => {
  const a = box('a', 100, 100)
  const stale = doc([a], 4, 1) // a note with spare pages
  const { op } = finalizeOp(stale, { label: 'Lock', changes: [{ id: 'a', before: a, after: { ...a, locked: true } }] })
  assert.equal(op.page, undefined)
})

test('shifting a document moves every object that has a geometry', () => {
  const shifted = shiftedDocument(doc([box('a', 10, 10), { id: 'u', type: 'unknown', raw: {} }]), 5, 7)
  assert.equal(shifted.objects[0].geometry.x, 15)
  assert.equal(shifted.objects[0].geometry.y, 17)
  assert.equal(shifted.objects[1].raw !== undefined, true)
})

test('a later edit folded into a step that moved the frame undoes into the old frame (reviewer repro: move A with a prepended column, then move C)', () => {
  const a = box('a', 100, 100)
  const c = box('c', 300, 600)
  const before = doc([a, c])
  const history = createHistory({ doc: before })
  const first = finalizeOp(before, { label: 'Move', changes: [{ id: 'a', before: a, after: { ...a, geometry: { ...a.geometry, x: -50 } } }] }).op
  history.record(first, { coalesce: 'k' })
  const cNow = objectOf(history.doc, 'c')
  history.record({ label: 'Move', changes: [{ id: 'c', before: cNow, after: { ...cNow, geometry: { ...cNow.geometry, y: cNow.geometry.y + 50 } } }] }, { coalesce: 'k' })
  assert.equal(history.stats().undoSteps, 1, 'one step')
  history.undo()
  assert.equal(objectOf(history.doc, 'c').geometry.x, 300)
  assert.equal(objectOf(history.doc, 'c').geometry.y, 600)
  assert.equal(objectOf(history.doc, 'a').geometry.x, 100)
})

test('an object an agent moved since keeps its position on undo but still moves back with the frame', () => {
  const a = box('a', 100, 100)
  const before = doc([a, box('b', 400, 300)])
  const history = createHistory({ doc: before })
  history.record(finalizeOp(before, { label: 'Move', changes: [{ id: 'a', before: a, after: { ...a, geometry: { ...a.geometry, x: -50 } } }] }).op)
  const aNow = objectOf(history.doc, 'a')
  history.mergeRemote({ ...history.doc, objects: history.doc.objects.map((o) => (o.id === 'a' ? { ...aNow, geometry: { ...aNow.geometry, y: 700 } } : o)) })
  history.undo()
  assert.equal(objectOf(history.doc, 'a').geometry.y, 700, 'the agent\'s move is kept')
  assert.equal(objectOf(history.doc, 'a').geometry.x, -50, 'and it moved back a page with the frame (the agent kept it where the user had put it)')
  assert.equal(objectOf(history.doc, 'b').geometry.x, 400)
})
