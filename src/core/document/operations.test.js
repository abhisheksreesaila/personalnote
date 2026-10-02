import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOperation, lockedIds, nudgeDistance } from './operations.js'

const geometry = (x, y, extra = {}) => ({ x, y, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0, ...extra })
const make = () => ({
  schemaVersion: 1, page: { columns: 1, rows: 1 }, extras: {},
  objects: [
    { id: 'a', type: 'shape', kind: 'rect', z: 0, geometry: geometry(10, 10) },
    { id: 'b', type: 'sticky', z: 1, content: 'hi', color: '#ffd60a', geometry: geometry(200, 10) },
    { id: 'c', type: 'text', mode: 'box', z: 2, content: 'text', geometry: geometry(10, 200) },
    { id: 'k1', type: 'connector', z: 3, fromId: 'a', toId: 'b', geometry: geometry(0, 0) },
    { id: 'k2', type: 'connector', z: 4, fromId: 'b', toId: 'c', geometry: geometry(0, 0) },
  ],
})
const order = (doc) => [...doc.objects].sort((p, q) => p.z - q.z).map((o) => o.id)
const solid = (doc) => order(doc).filter((id) => !id.startsWith('k'))

test('move shifts the box of each id and reports before and after', () => {
  const doc = make()
  const record = applyOperation(doc, { type: 'move', ids: ['a', 'c'], dx: 5, dy: -3 })
  assert.deepEqual([doc.objects[0].geometry.x, doc.objects[0].geometry.y], [15, 7])
  assert.deepEqual([doc.objects[2].geometry.x, doc.objects[2].geometry.y], [15, 197])
  assert.equal(doc.objects[1].geometry.x, 200)
  assert.equal(record.changes.length, 2)
  assert.equal(record.changes[0].before.x, 10)
  assert.equal(record.changes[0].after.x, 15)
})

test('setGeometry replaces the geometry fields it is given and leaves the rest', () => {
  const doc = make()
  applyOperation(doc, { type: 'setGeometry', id: 'b', geometry: { x: 1, y: 2, width: 300, rotation: 45 } })
  const g = doc.objects[1].geometry
  assert.deepEqual([g.x, g.y, g.width, g.height, g.rotation, g.scaleX], [1, 2, 300, 50, 45, 1])
})

test('remove drops the objects and every connector that touches them, then renumbers z with no gaps', () => {
  const doc = make()
  const record = applyOperation(doc, { type: 'remove', ids: ['b'] })
  assert.deepEqual(order(doc), ['a', 'c'])
  assert.deepEqual([...doc.objects].map((o) => o.z).sort(), [0, 1])
  assert.deepEqual(record.removed.map((r) => r.object.id).sort(), ['b', 'k1', 'k2'])
})

test('reorder: forward and backward pass the next solid object, front and back go to the ends', () => {
  const doc = make()
  applyOperation(doc, { type: 'reorder', ids: ['a'], to: 'forward' })
  assert.deepEqual(solid(doc), ['b', 'a', 'c'])
  applyOperation(doc, { type: 'reorder', ids: ['a'], to: 'front' })
  assert.deepEqual(solid(doc), ['b', 'c', 'a'])
  applyOperation(doc, { type: 'reorder', ids: ['a'], to: 'backward' })
  assert.deepEqual(solid(doc), ['b', 'a', 'c'])
  applyOperation(doc, { type: 'reorder', ids: ['c', 'a'], to: 'back' })
  assert.deepEqual(solid(doc), ['a', 'c', 'b'])
  assert.deepEqual([...doc.objects].map((o) => o.z).sort((p, q) => p - q), [0, 1, 2, 3, 4])
})

test('reorder at the end of the stack does nothing and reports no change', () => {
  const doc = make()
  assert.equal(applyOperation(doc, { type: 'reorder', ids: ['c'], to: 'front' }).changes.length, 0)
})

test('lock and unlock set and clear `locked`; an unlocked object carries no locked field', () => {
  const doc = make()
  applyOperation(doc, { type: 'lock', ids: ['a', 'b'], locked: true })
  assert.deepEqual([...lockedIds(doc)].sort(), ['a', 'b'])
  applyOperation(doc, { type: 'lock', ids: ['a'], locked: false })
  assert.deepEqual([...lockedIds(doc)], ['b'])
  assert.equal(Object.hasOwn(doc.objects[0], 'locked'), false)
})

test('locked objects refuse move, setGeometry and remove, and the call says which ids it skipped', () => {
  const doc = make()
  applyOperation(doc, { type: 'lock', ids: ['a'], locked: true })
  const moved = applyOperation(doc, { type: 'move', ids: ['a', 'c'], dx: 10, dy: 0 })
  assert.deepEqual(moved.skipped, ['a'])
  assert.equal(doc.objects[0].geometry.x, 10)
  assert.equal(doc.objects[2].geometry.x, 20)
  assert.deepEqual(applyOperation(doc, { type: 'setGeometry', id: 'a', geometry: { x: 99 } }).skipped, ['a'])
  assert.equal(doc.objects[0].geometry.x, 10)
  const removed = applyOperation(doc, { type: 'remove', ids: ['a', 'c'] })
  assert.deepEqual(removed.skipped, ['a'])
  assert.deepEqual(solid(doc), ['a', 'b'])
})

test('a locked object can still be reordered and unlocked', () => {
  const doc = make()
  applyOperation(doc, { type: 'lock', ids: ['a'], locked: true })
  assert.equal(applyOperation(doc, { type: 'reorder', ids: ['a'], to: 'front' }).changes.length > 0, true)
  assert.equal(applyOperation(doc, { type: 'lock', ids: ['a'], locked: false }).changes.length, 1)
})

test('nudgeDistance: 1 px, 10 px with shift', () => {
  assert.equal(nudgeDistance({ shiftKey: false }), 1)
  assert.equal(nudgeDistance({ shiftKey: true }), 10)
})

test('an unknown operation is an error, not a silent no-op', () => {
  assert.throws(() => applyOperation(make(), { type: 'explode' }), /unknown operation/)
})
