import assert from 'node:assert/strict'
import test from 'node:test'
import { applyChanges, compactStacking, lockedIds, nudgeDistance, planOperation, stacking } from './operations.js'

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
const order = (doc) => stacking(doc).map((o) => o.id)
const solid = (doc) => order(doc).filter((id) => !id.startsWith('k'))
const find = (doc, id) => doc.objects.find((o) => o.id === id)
// plan, then apply; the document the planner saw is never changed
function run(doc, operation) {
  const snapshot = structuredClone(doc)
  const plan = planOperation(doc, operation)
  assert.deepEqual(doc, snapshot, 'planning must not change the document')
  return { ...plan, doc: applyChanges(doc, plan.op) }
}

test('move plans a new box for each id, as immutable before/after values the undo history can record', () => {
  const start = make()
  const { op, doc } = run(start, { type: 'move', ids: ['a', 'c'], dx: 5, dy: -3 })
  assert.deepEqual([find(doc, 'a').geometry.x, find(doc, 'a').geometry.y], [15, 7])
  assert.deepEqual([find(doc, 'c').geometry.x, find(doc, 'c').geometry.y], [15, 197])
  assert.equal(find(doc, 'b').geometry.x, 200)
  assert.equal(op.changes.length, 2)
  assert.equal(op.changes[0].before, start.objects[0], 'before is the very object that was there')
  assert.equal(op.changes[0].before.geometry.x, 10)
})

test('setGeometry replaces the geometry fields it is given and leaves the rest', () => {
  const { doc } = run(make(), { type: 'setGeometry', id: 'b', geometry: { x: 1, y: 2, width: 300, rotation: 45, bogus: 1 } })
  const g = find(doc, 'b').geometry
  assert.deepEqual([g.x, g.y, g.width, g.height, g.rotation, g.scaleX], [1, 2, 300, 50, 45, 1])
  assert.equal(Object.hasOwn(g, 'bogus'), false)
})

test('remove drops the objects and every connector that touches them', () => {
  const { op, doc } = run(make(), { type: 'remove', ids: ['b'] })
  assert.deepEqual(order(doc), ['a', 'c'])
  assert.deepEqual(op.changes.map((c) => c.id).sort(), ['b', 'k1', 'k2'])
  assert.ok(op.changes.every((c) => c.after === null && c.before))
})

test('reorder: forward and backward pass the next solid object, front and back go to the ends', () => {
  let doc = make()
  doc = run(doc, { type: 'reorder', ids: ['a'], to: 'forward' }).doc
  assert.deepEqual(solid(doc), ['b', 'a', 'c'])
  doc = run(doc, { type: 'reorder', ids: ['a'], to: 'front' }).doc
  assert.deepEqual(solid(doc), ['b', 'c', 'a'])
  doc = run(doc, { type: 'reorder', ids: ['a'], to: 'backward' }).doc
  assert.deepEqual(solid(doc), ['b', 'a', 'c'])
  doc = run(doc, { type: 'reorder', ids: ['c', 'a'], to: 'back' }).doc
  assert.deepEqual(solid(doc), ['a', 'c', 'b'])
  assert.deepEqual(doc.objects.map((o) => o.z).sort((p, q) => p - q), [0, 1, 2, 3, 4], 'the same z values, shuffled among the objects')
})

test('reorder touches only the objects that change place', () => {
  const { op } = run(make(), { type: 'reorder', ids: ['a'], to: 'forward' })
  assert.deepEqual(op.changes.map((c) => c.id).sort(), ['a', 'b'])
})

test('reorder at the end of the stack plans no change', () => {
  assert.equal(run(make(), { type: 'reorder', ids: ['c'], to: 'front' }).op.changes.length, 0)
  assert.equal(run(make(), { type: 'reorder', ids: ['a'], to: 'back' }).op.changes.length, 0)
})

test('reorder leaves gaps in z alone', () => {
  const start = make()
  start.objects.forEach((o, i) => { o.z = i * 10 })
  const { doc } = run(start, { type: 'reorder', ids: ['a'], to: 'forward' })
  assert.deepEqual(solid(doc), ['b', 'a', 'c'])
  assert.deepEqual(doc.objects.map((o) => o.z).sort((p, q) => p - q), [0, 10, 20, 30, 40])
})

test('lock and unlock set and clear `locked`; an unlocked object carries no locked field', () => {
  let doc = run(make(), { type: 'lock', ids: ['a', 'b'], locked: true }).doc
  assert.deepEqual([...lockedIds(doc)].sort(), ['a', 'b'])
  const unlocked = run(doc, { type: 'lock', ids: ['a'], locked: false })
  doc = unlocked.doc
  assert.deepEqual([...lockedIds(doc)], ['b'])
  assert.equal(Object.hasOwn(find(doc, 'a'), 'locked'), false)
  assert.equal(unlocked.op.changes.length, 1)
})

test('locked objects refuse move, setGeometry and remove, and the plan says which ids it skipped', () => {
  let doc = run(make(), { type: 'lock', ids: ['a'], locked: true }).doc
  const moved = run(doc, { type: 'move', ids: ['a', 'c'], dx: 10, dy: 0 })
  assert.deepEqual(moved.skipped, ['a'])
  assert.equal(find(moved.doc, 'a').geometry.x, 10)
  assert.equal(find(moved.doc, 'c').geometry.x, 20)
  assert.deepEqual(run(doc, { type: 'setGeometry', id: 'a', geometry: { x: 99 } }).skipped, ['a'])
  const removed = run(doc, { type: 'remove', ids: ['a', 'c'] })
  assert.deepEqual(removed.skipped, ['a'])
  assert.deepEqual(solid(removed.doc), ['a', 'b'])
})

test('a locked object can still be reordered and unlocked', () => {
  const doc = run(make(), { type: 'lock', ids: ['a'], locked: true }).doc
  assert.ok(run(doc, { type: 'reorder', ids: ['a'], to: 'front' }).op.changes.length > 0)
  assert.equal(run(doc, { type: 'lock', ids: ['a'], locked: false }).op.changes.length, 1)
})

test('compactStacking numbers the stack 0..n-1 in order and leaves an already compact document as it is', () => {
  const doc = make()
  assert.equal(compactStacking(doc).objects[0], doc.objects[0])
  doc.objects.forEach((o, i) => { o.z = i * 7 + 3 })
  const compact = compactStacking(doc)
  assert.deepEqual(compact.objects.map((o) => o.z), [0, 1, 2, 3, 4])
  assert.deepEqual(order(compact), order(doc))
})

test('nudgeDistance: 1 px, 10 px with shift', () => {
  assert.equal(nudgeDistance({ shiftKey: false }), 1)
  assert.equal(nudgeDistance({ shiftKey: true }), 10)
})

test('an unknown operation or reorder target is an error, not a silent no-op', () => {
  assert.throws(() => planOperation(make(), { type: 'explode' }), /unknown operation/)
  assert.throws(() => planOperation(make(), { type: 'reorder', ids: ['a'], to: 'sideways' }), /unknown reorder/)
})
