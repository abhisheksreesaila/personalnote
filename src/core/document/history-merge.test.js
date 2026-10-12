// F-030 review fixes: a step never spans a merge; z after a real JSON Canvas merge; connectors; open groups; the byte cap at 600 objects.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHistory } from './history.js'
import { readJsonCanvas, writeJsonCanvas } from './jsoncanvas.js'
import { validateDocument } from './validate.js'

const geometry = (x, y) => ({ x, y, width: 100, height: 60, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 })
const sticky = (n, extra = {}) => ({ id: `o${n}`, type: 'sticky', z: n, content: `note ${n}`, color: '#fff2a8', geometry: geometry(n * 10, n * 5), ...extra })
const makeDoc = (count = 5) => ({ schemaVersion: 1, page: { columns: 1, rows: 1 }, objects: Array.from({ length: count }, (_, n) => sticky(n)), extras: {} })
const move = (object, dx) => ({ ...object, geometry: { ...object.geometry, x: object.geometry.x + dx } })
const byId = (doc, id) => doc.objects.find((object) => object.id === id)
const moveOp = (history, id, dx) => { const before = byId(history.doc, id); return { label: 'Move', changes: [{ id, before, after: move(before, dx) }] } }
const textOf = (doc, id) => byId(doc, id).content
const withText = (doc, id, content) => ({ ...doc, objects: doc.objects.map((o) => (o.id === id ? { ...o, content } : o)) })
const connector = (id, fromId, toId, z) => ({ id, type: 'connector', z, fromId, toId })
const connectorDoc = () => ({ ...makeDoc(4), objects: [sticky(0, { id: 'a' }), sticky(1, { id: 'b' }), connector('c', 'a', 'b', 2), sticky(3, { id: 'd' })] })
const valid = (doc) => { const { ok, errors } = validateDocument(doc, { strict: false }); assert.ok(ok, JSON.stringify(errors)); return doc }
const throughJsonCanvas = (doc) => readJsonCanvas(JSON.parse(JSON.stringify(writeJsonCanvas(doc))))

test('coalescing does not continue across a merge', () => {
  const history = createHistory({ doc: makeDoc(), coalesceMs: 10_000 })
  history.record(moveOp(history, 'o1', 5), { coalesce: 'k' })
  history.mergeRemote(withText(history.doc, 'o1', 'AGENT'))
  history.record(moveOp(history, 'o1', 5), { coalesce: 'k' })
  assert.equal(history.stats().undoSteps, 2)
  history.undo()
  assert.equal(textOf(history.doc, 'o1'), 'AGENT')
  assert.equal(byId(history.doc, 'o1').geometry.x, 15)
  history.undo()
  assert.equal(textOf(history.doc, 'o1'), 'AGENT')
  assert.equal(byId(history.doc, 'o1').geometry.x, 10)
})

test('a group open across a merge becomes two steps', () => {
  const history = createHistory({ doc: makeDoc() })
  history.begin('Edit')
  history.record(moveOp(history, 'o1', 5))
  history.mergeRemote(withText(history.doc, 'o1', 'AGENT'))
  history.record(moveOp(history, 'o1', 5))
  history.end()
  assert.equal(history.stats().undoSteps, 2)
  history.undo()
  history.undo()
  assert.equal(textOf(history.doc, 'o1'), 'AGENT')
  assert.equal(byId(history.doc, 'o1').geometry.x, 10)
})

test('cancelling a group after a merge leaves the agent text', () => {
  const history = createHistory({ doc: makeDoc() })
  history.begin('Edit')
  history.record(moveOp(history, 'o1', 5))
  history.mergeRemote(withText(history.doc, 'o1', 'AGENT'))
  history.record(moveOp(history, 'o1', 5))
  history.end({ cancel: true })
  assert.equal(textOf(history.doc, 'o1'), 'AGENT')
  assert.equal(byId(history.doc, 'o1').geometry.x, 15)
})

test('a merge through JSON Canvas renumbers z; undoing a delete keeps order and unique z', () => {
  const history = createHistory({ doc: valid(makeDoc(4)) })
  history.record({ changes: [{ id: 'o1', before: byId(history.doc, 'o1'), after: null }] })
  history.mergeRemote(throughJsonCanvas(history.doc))
  assert.deepEqual(history.doc.objects.map((o) => [o.id, o.z]), [['o0', 0], ['o2', 1], ['o3', 2]])
  history.undo()
  assert.deepEqual(history.doc.objects.map((o) => o.id), ['o0', 'o1', 'o2', 'o3'])
  assert.deepEqual(history.doc.objects.map((o) => o.z), [0, 1, 2, 3])
  valid(history.doc)
  history.redo()
  assert.deepEqual(history.doc.objects.map((o) => o.id), ['o0', 'o2', 'o3'])
  valid(history.doc)
})

test('a merge through JSON Canvas: undoing an add still removes the renumbered object', () => {
  const history = createHistory({ doc: valid(makeDoc(3)) })
  history.record({ changes: [{ id: 'x', before: null, after: sticky(7, { id: 'x', z: 3 }) }] })
  history.mergeRemote(throughJsonCanvas(history.doc))
  history.undo()
  assert.deepEqual(history.doc.objects.map((o) => o.id), ['o0', 'o1', 'o2'])
  valid(history.doc)
})

test('connectors: undoing a delete never restores a connector to an object the agent deleted', () => {
  const history = createHistory({ doc: connectorDoc() })
  history.record({ changes: ['a', 'c'].map((id) => ({ id, before: byId(history.doc, id), after: null })) })
  history.mergeRemote({ ...history.doc, objects: history.doc.objects.filter((o) => o.id !== 'b') })
  history.undo()
  assert.deepEqual(history.doc.objects.map((o) => o.id).sort(), ['a', 'd'])
  valid(history.doc)
})

test('connectors: undoing an add keeps an object the agent connected to since', () => {
  const history = createHistory({ doc: connectorDoc() })
  history.record({ changes: [{ id: 'x', before: null, after: sticky(9, { id: 'x', z: 4 }) }] })
  history.mergeRemote({ ...history.doc, objects: [...history.doc.objects, connector('agent-c', 'a', 'x', 5)] })
  history.undo()
  assert.ok(byId(history.doc, 'x'))
  assert.ok(byId(history.doc, 'agent-c'))
})

test('connectors: an object deleted together with its connector comes back together', () => {
  const history = createHistory({ doc: connectorDoc() })
  const start = structuredClone(history.doc)
  history.record({ changes: ['a', 'c'].map((id) => ({ id, before: byId(history.doc, id), after: null })) })
  history.undo()
  assert.deepEqual(history.doc, start)
})

test('an undo in the middle of a group closes it, nested or not', () => {
  const history = createHistory({ doc: makeDoc() })
  const start = history.doc
  history.begin('Move')
  history.begin('Inner')
  history.record(moveOp(history, 'o1', 5))
  history.end()
  history.record(moveOp(history, 'o1', 5))
  history.undo()
  assert.deepEqual(history.doc, start)
  history.end() // the caller's own end() after the group was closed for it is harmless
  history.record(moveOp(history, 'o2', 1))
  assert.equal(history.stats().undoSteps, 1)
  assert.equal(history.canRedo, false)
})

test('record does not modify the change objects it is given', () => {
  const history = createHistory({ doc: makeDoc() })
  const op = { changes: [{ id: 'o2', before: byId(history.doc, 'o2'), after: null }] }
  const frozen = JSON.stringify(op)
  Object.freeze(op.changes[0])
  history.record(op)
  assert.equal(JSON.stringify(op), frozen)
  history.undo()
  assert.deepEqual(history.doc.objects.map((o) => o.id), ['o0', 'o1', 'o2', 'o3', 'o4'])
})

test('a group closed by a merge keeps its label on both steps', () => {
  const labels = []
  const history = createHistory({ doc: makeDoc() })
  history.subscribe((event) => { if (event.type === 'undo') labels.push(event.label) })
  history.begin('Drag')
  history.record({ changes: moveOp(history, 'o1', 5).changes })
  history.mergeRemote(withText(history.doc, 'o2', 'AGENT'))
  history.record({ changes: moveOp(history, 'o1', 5).changes })
  history.end()
  history.undo()
  history.undo()
  assert.deepEqual(labels, ['Drag', 'Drag'])
})

test('connectors: a step connector the agent changed stays, so its endpoint is not removed under it', () => {
  const history = createHistory({ doc: connectorDoc() })
  history.record({ changes: [{ id: 'x', before: null, after: sticky(9, { id: 'x', z: 4 }) }, { id: 'k', before: null, after: connector('k', 'a', 'x', 5) }] })
  history.mergeRemote({ ...history.doc, objects: history.doc.objects.map((o) => (o.id === 'k' ? { ...o, color: '#ff0000' } : o)) })
  history.undo()
  const ids = history.doc.objects.map((o) => o.id)
  assert.ok(ids.includes('x') && ids.includes('k'), ids.join())
})

test('the byte cap holds on a 600-object note', () => {
  const objects = Array.from({ length: 600 }, (_, n) => sticky(n, { content: 'y'.repeat(2000) }))
  const history = createHistory({ doc: { ...makeDoc(), objects }, maxBytes: 200_000, maxSteps: 10_000 })
  for (let n = 0; n < 600; n++) history.record(moveOp(history, `o${n}`, 1))
  const { undoSteps, bytes } = history.stats()
  assert.ok(undoSteps >= 1 && undoSteps < 600, `kept ${undoSteps}`)
  assert.ok(bytes <= 200_000 + 12_000, `bytes ${bytes}`)
  while (history.undo()) valid(history.doc)
})
