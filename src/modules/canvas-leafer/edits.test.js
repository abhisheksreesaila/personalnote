import assert from 'node:assert/strict'
import test from 'node:test'
import { createLeaferEdits } from './edits.js'

const box = { x: 0, y: 0, width: 100, height: 60, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const doc = () => ({
  schemaVersion: 1,
  page: { columns: 1, rows: 1 },
  objects: [
    { id: 'a', type: 'sticky', z: 0, content: 'A', color: '#fff2a8', geometry: box },
    { id: 'b', type: 'sticky', z: 1, content: 'B', color: '#fff2a8', geometry: { ...box, x: 300 } },
    { id: 'c', type: 'connector', z: 2, fromId: 'a', toId: 'b' },
    { id: 'd', type: 'sticky', z: 3, content: 'D', color: '#fff2a8', geometry: { ...box, y: 300 } },
  ],
  extras: {},
})

test('delete takes the connectors with it, and undo and redo restore exactly', () => {
  const events = []
  const edits = createLeaferEdits({ onChange: (next, info) => events.push({ ids: next.objects.map((o) => o.id), ...info }) })
  const start = doc()
  edits.open(7, structuredClone(start))
  edits.deleteObjects(['a'])
  assert.deepEqual(edits.doc.objects.map((o) => o.id), ['b', 'd'])
  assert.deepEqual(edits.undo().selection, ['a'])
  assert.deepEqual(edits.doc, start)
  edits.redo()
  assert.deepEqual(edits.doc.objects.map((o) => o.id), ['b', 'd'])
  assert.deepEqual(events.map((e) => e.kind), ['edit', 'undo', 'redo'])
})

test('deleting nothing is not a step; undo with no history is a no-op', () => {
  const edits = createLeaferEdits()
  assert.equal(edits.undo(), null)
  edits.open(1, doc())
  assert.equal(edits.deleteObjects(['nope']), null)
  assert.equal(edits.canUndo, false)
})

test('a remote merge of the same note keeps the history; another note starts a new one', () => {
  const edits = createLeaferEdits()
  edits.open(1, doc())
  edits.deleteObjects(['d'])
  const agent = { id: 'agent', type: 'sticky', z: 9, content: 'agent', color: '#fff2a8', geometry: box }
  edits.remote(1, { ...edits.doc, objects: [...edits.doc.objects, agent] })
  assert.equal(edits.canUndo, true)
  edits.undo()
  assert.deepEqual(edits.doc.objects.map((o) => o.id), ['a', 'b', 'c', 'd', 'agent'])
  edits.remote(2, doc())
  assert.equal(edits.canUndo, false)
  assert.equal(edits.noteId, 2)
})

test('delete leaves a locked object alone and removes the others', () => {
  const edits = createLeaferEdits()
  const start = doc()
  start.objects[0].locked = true
  edits.open(7, start)
  assert.equal(edits.deleteObjects(['a']), null)
  assert.deepEqual(edits.doc.objects.map((o) => o.id), ['a', 'b', 'c', 'd'])
  edits.deleteObjects(['a', 'd'])
  assert.deepEqual(edits.doc.objects.map((o) => o.id), ['a', 'b', 'c'])
})
