import assert from 'node:assert/strict'
import test from 'node:test'
import { createHistory, diffDocuments } from './history.js'

const geometry = (x, y) => ({ x, y, width: 100, height: 60, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 })
const sticky = (n, extra = {}) => ({ id: `o${n}`, type: 'sticky', z: n, content: `note ${n}`, color: '#fff2a8', geometry: geometry(n * 10, n * 5), ...extra })
const makeDoc = (count = 5) => ({ schemaVersion: 1, page: { columns: 1, rows: 1 }, objects: Array.from({ length: count }, (_, n) => sticky(n)), extras: {} })
const move = (object, dx) => ({ ...object, geometry: { ...object.geometry, x: object.geometry.x + dx } })
const byId = (doc, id) => doc.objects.find((object) => object.id === id)
const moveOp = (history, id, dx) => { const before = byId(history.doc, id); return { label: 'Move', changes: [{ id, before, after: move(before, dx) }] } }

test('record, undo and redo restore the document exactly', () => {
  const history = createHistory({ doc: makeDoc() })
  const start = structuredClone(history.doc)
  history.record(moveOp(history, 'o1', 40))
  const moved = structuredClone(history.doc)
  assert.notDeepEqual(moved, start)
  history.undo()
  assert.deepEqual(history.doc, start)
  history.redo()
  assert.deepEqual(history.doc, moved)
})

test('100 alternating edits undo and redo to identical documents', () => {
  const history = createHistory({ doc: makeDoc(20), maxSteps: 500 })
  const states = [structuredClone(history.doc)]
  for (let n = 0; n < 100; n++) {
    const id = `o${n % 20}`
    const object = byId(history.doc, id)
    if (n % 3 === 0 && object) history.record({ changes: [{ id, before: object, after: null }] })
    else if (n % 3 === 2 && object) history.record(moveOp(history, id, n))
    else history.record({ changes: [{ id: `n${n}`, before: null, after: sticky(100 + n, { id: `n${n}` }) }] })
    states.push(structuredClone(history.doc))
  }
  for (let n = 100; n > 0; n--) { assert.ok(history.undo()); assert.deepEqual(history.doc, states[n - 1], `undo to ${n - 1}`) }
  assert.equal(history.undo(), null)
  for (let n = 1; n <= 100; n++) { assert.ok(history.redo()); assert.deepEqual(history.doc, states[n], `redo to ${n}`) }
  assert.equal(history.redo(), null)
})

test('a removed object comes back at its stacking position', () => {
  const history = createHistory({ doc: makeDoc() })
  history.record({ changes: [{ id: 'o2', before: byId(history.doc, 'o2'), after: null }] })
  assert.equal(history.doc.objects.length, 4)
  history.undo()
  assert.deepEqual(history.doc.objects.map((o) => o.id), ['o0', 'o1', 'o2', 'o3', 'o4'])
})

test('a drag or transform is one step', () => {
  const history = createHistory({ doc: makeDoc() })
  const start = history.doc
  history.begin('Move')
  for (let n = 0; n < 60; n++) history.record(moveOp(history, 'o1', 1))
  assert.equal(history.canUndo, false, 'nothing is a step until the group ends')
  history.end()
  assert.equal(history.stats().undoSteps, 1)
  assert.equal(byId(history.doc, 'o1').geometry.x, 70)
  history.undo()
  assert.deepEqual(history.doc, start)
  assert.equal(history.canUndo, false)
})

test('a cancelled group leaves no step and no change', () => {
  const history = createHistory({ doc: makeDoc() })
  const start = history.doc
  history.begin('Move')
  history.record(moveOp(history, 'o1', 30))
  history.end({ cancel: true })
  assert.deepEqual(history.doc, start)
  assert.equal(history.canUndo, false)
})

test('records with the same coalesce key inside the window are one step', () => {
  let clock = 0
  const history = createHistory({ doc: makeDoc(), coalesceMs: 500, now: () => clock })
  for (let n = 0; n < 5; n++) { history.record(moveOp(history, 'o1', 1), { coalesce: 'nudge:o1' }); clock += 100 }
  assert.equal(history.stats().undoSteps, 1)
  clock += 2000
  history.record(moveOp(history, 'o1', 1), { coalesce: 'nudge:o1' })
  assert.equal(history.stats().undoSteps, 2)
  history.undo(); history.undo()
  assert.equal(byId(history.doc, 'o1').geometry.x, 10)
})

test('a new edit after undo clears redo', () => {
  const history = createHistory({ doc: makeDoc() })
  history.record(moveOp(history, 'o1', 5))
  history.record(moveOp(history, 'o2', 5))
  history.undo()
  assert.equal(history.canRedo, true)
  history.record(moveOp(history, 'o3', 5))
  assert.equal(history.canRedo, false)
  assert.equal(history.redo(), null)
})

test('the step cap drops the oldest steps', () => {
  const history = createHistory({ doc: makeDoc(), maxSteps: 10, coalesceMs: 0 })
  for (let n = 0; n < 50; n++) history.record(moveOp(history, 'o1', 1))
  assert.equal(history.stats().undoSteps, 10)
  let undone = 0
  while (history.undo()) undone++
  assert.equal(undone, 10)
  assert.equal(byId(history.doc, 'o1').geometry.x, 10 + 40)
})

test('the byte cap drops the oldest steps; the newest step always stays', () => {
  const big = { ...sticky(0), id: 'big', content: 'x'.repeat(50_000) }
  const history = createHistory({ doc: { ...makeDoc(), objects: [big] }, maxBytes: 300_000 })
  for (let n = 0; n < 20; n++) history.record(moveOp(history, 'big', 1))
  const { undoSteps, bytes } = history.stats()
  assert.ok(undoSteps < 20 && undoSteps >= 1, `kept ${undoSteps}`)
  assert.ok(bytes <= 300_000 + 250_000)
  const tiny = createHistory({ doc: { ...makeDoc(), objects: [big] }, maxBytes: 10 })
  tiny.record(moveOp(tiny, 'big', 1))
  assert.equal(tiny.stats().undoSteps, 1)
})

test('a step shares every untouched object with the document', () => {
  const history = createHistory({ doc: makeDoc(50) })
  const before = history.doc
  history.record(moveOp(history, 'o7', 9))
  history.undo()
  history.redo()
  const shared = history.doc.objects.filter((object) => before.objects.includes(object)).length
  assert.equal(shared, 49)
})

test('page changes are undoable', () => {
  const history = createHistory({ doc: makeDoc() })
  history.record({ label: 'Add page', changes: [], page: { before: history.doc.page, after: { columns: 2, rows: 1 } } })
  assert.deepEqual(history.doc.page, { columns: 2, rows: 1 })
  const result = history.undo()
  assert.equal(result.page, true)
  assert.deepEqual(history.doc.page, { columns: 1, rows: 1 })
})

test('recordDocument diffs a new document against the current one', () => {
  const history = createHistory({ doc: makeDoc() })
  const next = { ...history.doc, objects: history.doc.objects.filter((o) => o.id !== 'o0').map((o) => (o.id === 'o3' ? move(o, 5) : o)) }
  history.recordDocument(next, { label: 'Edit' })
  assert.equal(history.doc.objects.length, 4)
  assert.equal(history.recordDocument(history.doc), history.doc)
  assert.equal(history.stats().undoSteps, 1)
  assert.equal(diffDocuments(makeDoc(), makeDoc()).changes.length, 0)
  history.undo()
  assert.deepEqual(history.doc, makeDoc())
})

test('selection: undo selects what it restored, or what the step says', () => {
  const history = createHistory({ doc: makeDoc() })
  history.record({ changes: [{ id: 'o2', before: byId(history.doc, 'o2'), after: null }], selection: { before: ['o2'], after: [] } })
  assert.deepEqual(history.undo().selection, ['o2'])
  assert.deepEqual(history.redo().selection, [])
  history.undo()
  history.record(moveOp(history, 'o1', 3))
  assert.deepEqual(history.undo().selection, ['o1'])
})

// ---- remote and agent merges

test('merge: undo never removes or reverts an agent append', () => {
  const history = createHistory({ doc: makeDoc() })
  history.record(moveOp(history, 'o1', 40))
  const agent = sticky(9, { id: 'agent1', content: 'from the agent' })
  history.mergeRemote({ ...history.doc, objects: [...history.doc.objects, agent] })
  history.undo()
  assert.equal(byId(history.doc, 'o1').geometry.x, 10)
  assert.deepEqual(byId(history.doc, 'agent1'), agent)
  history.redo()
  assert.deepEqual(byId(history.doc, 'agent1'), agent)
})

test('merge: undoing a move keeps an agent rewrite of the same object', () => {
  const history = createHistory({ doc: makeDoc() })
  history.record(moveOp(history, 'o1', 40))
  const moved = byId(history.doc, 'o1')
  history.mergeRemote({ ...history.doc, objects: history.doc.objects.map((o) => (o.id === 'o1' ? { ...moved, content: 'agent text' } : o)) })
  const result = history.undo()
  const o1 = byId(history.doc, 'o1')
  assert.equal(o1.content, 'agent text')
  assert.equal(o1.geometry.x, 10)
  assert.equal(result.skipped, 0)
})

test('merge: undoing an edit does not revert a field the agent changed after it', () => {
  const history = createHistory({ doc: makeDoc() })
  const before = byId(history.doc, 'o1')
  history.record({ changes: [{ id: 'o1', before, after: { ...before, content: 'user text' } }] })
  history.mergeRemote({ ...history.doc, objects: history.doc.objects.map((o) => (o.id === 'o1' ? { ...o, content: 'agent text' } : o)) })
  assert.equal(history.undo(), null, 'nothing of the step is left to revert, and the stack moves on')
  assert.equal(byId(history.doc, 'o1').content, 'agent text')
  assert.equal(history.canUndo, false)
})

test('merge: a void step is skipped and undo continues to the earlier step', () => {
  const history = createHistory({ doc: makeDoc() })
  history.record(moveOp(history, 'o2', 7))
  const before = byId(history.doc, 'o1')
  history.record({ changes: [{ id: 'o1', before, after: { ...before, content: 'user text' } }] })
  history.mergeRemote({ ...history.doc, objects: history.doc.objects.map((o) => (o.id === 'o1' ? { ...o, content: 'agent text' } : o)) })
  assert.ok(history.undo())
  assert.equal(byId(history.doc, 'o2').geometry.x, 20)
  assert.equal(byId(history.doc, 'o1').content, 'agent text')
})

test('merge: an object the agent deleted is not resurrected by undoing the user move', () => {
  const history = createHistory({ doc: makeDoc() })
  history.record(moveOp(history, 'o1', 40))
  history.mergeRemote({ ...history.doc, objects: history.doc.objects.filter((o) => o.id !== 'o1') })
  assert.equal(history.undo(), null)
  assert.equal(byId(history.doc, 'o1'), undefined)
})

test('merge: undoing a user delete does not duplicate an object the agent put back', () => {
  const history = createHistory({ doc: makeDoc() })
  const gone = byId(history.doc, 'o1')
  history.record({ changes: [{ id: 'o1', before: gone, after: null }] })
  history.mergeRemote({ ...history.doc, objects: [...history.doc.objects, { ...gone, content: 'agent version' }] })
  assert.equal(history.undo(), null)
  assert.equal(history.doc.objects.filter((o) => o.id === 'o1').length, 1)
  assert.equal(byId(history.doc, 'o1').content, 'agent version')
})

test('merge: redo after a merge applies on the new base and leaves agent objects alone', () => {
  const history = createHistory({ doc: makeDoc() })
  history.record({ changes: [{ id: 'o3', before: byId(history.doc, 'o3'), after: null }] })
  history.undo()
  const agent = sticky(8, { id: 'agent2' })
  history.mergeRemote({ ...history.doc, objects: [...history.doc.objects, agent] })
  history.redo()
  assert.equal(byId(history.doc, 'o3'), undefined)
  assert.deepEqual(byId(history.doc, 'agent2'), agent)
})

test('merge: untouched objects keep their identity, and the stacks survive', () => {
  const history = createHistory({ doc: makeDoc(30) })
  history.record(moveOp(history, 'o1', 4))
  const before = history.doc
  history.mergeRemote(structuredClone(before))
  assert.ok(history.doc.objects.every((object, index) => object === before.objects[index]))
  assert.equal(history.stats().undoSteps, 1)
})

test('reset empties the history for another note', () => {
  const history = createHistory({ doc: makeDoc() })
  history.record(moveOp(history, 'o1', 4))
  history.reset(makeDoc(2))
  assert.equal(history.canUndo, false)
  assert.equal(history.doc.objects.length, 2)
})

// ---- the 600-object note

test('undo on a 600-object note stays under 16 ms and a step is small', () => {
  const history = createHistory({ doc: makeDoc(600), maxSteps: 400 })
  for (let n = 0; n < 100; n++) history.record(moveOp(history, `o${(n * 7) % 600}`, 3))
  const perStep = history.stats().bytes / history.stats().undoSteps
  assert.ok(perStep < 4096, `${perStep} bytes per step`)
  const times = []
  for (let n = 0; n < 100; n++) { const t0 = performance.now(); history.undo(); times.push(performance.now() - t0) }
  times.sort((a, b) => a - b)
  assert.ok(times[50] < 16, `median undo ${times[50].toFixed(2)} ms`)
})
