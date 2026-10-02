import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeDocuments } from './merge.js'

const g = { x: 0, y: 0, width: 100, height: 40, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const text = (id, content, extra = {}) => ({ id, type: 'text', mode: 'box', z: 0, content, style: { fontSize: 24 }, geometry: { ...g }, ...extra })
const doc = (objects, page = { columns: 1, rows: 1 }) => ({ schemaVersion: 1, page, extras: {}, objects: objects.map((o, i) => ({ ...o, z: i })) })
const ids = (d) => d.objects.map((o) => o.id)
const byId = (d, id) => d.objects.find((o) => o.id === id)

const base = () => doc([text('a', 'A'), text('b', 'B'), text('c', 'C')])

test('what only the agent changed is taken: a rewrite and a deletion', () => {
  const remote = doc([text('a', 'A rewritten'), text('c', 'C')])
  const { doc: merged } = mergeDocuments({ base: base(), local: base(), remote })
  assert.deepEqual(ids(merged), ['a', 'c'])
  assert.equal(byId(merged, 'a').content, 'A rewritten')
})

test('what only the user changed is kept, whatever the agent did to the others', () => {
  const local = base()
  local.objects[1] = { ...local.objects[1], content: 'B typed' }
  const remote = doc([text('a', 'A rewritten'), text('b', 'B'), text('c', 'C')])
  const { doc: merged } = mergeDocuments({ base: base(), local, remote })
  assert.equal(byId(merged, 'b').content, 'B typed')
  assert.equal(byId(merged, 'a').content, 'A rewritten')
})

test('typed words, an agent rewrite, an agent deletion and an agent append all survive together', () => {
  const local = base()
  local.objects[0] = { ...local.objects[0], content: 'A typed' }
  const remote = doc([text('a', 'A'), text('b', 'B rewritten'), text('d', 'D new')]) // c deleted, b rewritten, d appended
  const { doc: merged, added } = mergeDocuments({ base: base(), local, remote })
  assert.deepEqual(ids(merged), ['a', 'b', 'd'])
  assert.equal(byId(merged, 'a').content, 'A typed')
  assert.equal(byId(merged, 'b').content, 'B rewritten')
  assert.deepEqual(added, ['d'])
  assert.ok(byId(merged, 'd').z > byId(merged, 'b').z, 'the new object goes on top')
})

test('both changed the same object: each keeps its own fields, the user wins a field both changed', () => {
  const local = base()
  local.objects[0] = { ...local.objects[0], content: 'A typed', geometry: { ...g, x: 50 } }
  const remote = doc([text('a', 'A agent', { style: { fontSize: 40 }, geometry: { ...g, x: 70, y: 9 } }), text('b', 'B'), text('c', 'C')])
  const { doc: merged } = mergeDocuments({ base: base(), local, remote })
  const a = byId(merged, 'a')
  assert.equal(a.content, 'A typed') // both changed it: the user's
  assert.equal(a.style.fontSize, 40) // only the agent changed it
  assert.equal(a.geometry.x, 50) // both: the user's
  assert.equal(a.geometry.y, 9) // only the agent
})

test('a deletion by the user stays deleted; a change by the user beats an agent deletion', () => {
  const local = doc([text('a', 'A'), text('b', 'B local')]) // c deleted by the user, b changed
  const remote = doc([text('a', 'A'), text('c', 'C agent change')]) // b deleted by the agent, c changed
  const { doc: merged } = mergeDocuments({ base: base(), local, remote })
  assert.deepEqual(ids(merged), ['a', 'b'])
  assert.equal(byId(merged, 'b').content, 'B local')
})

test('a connector whose end the agent deleted goes too', () => {
  const connector = { id: 'k', type: 'connector', fromId: 'a', toId: 'b', geometry: g }
  const start = doc([text('a', 'A'), text('b', 'B'), connector])
  const remote = doc([text('a', 'A'), { ...connector }]) // b deleted, the connector left behind by a careless writer
  const { doc: merged } = mergeDocuments({ base: start, local: start, remote })
  assert.deepEqual(ids(merged), ['a'])
})

test('a stacking renumber alone is not a change, and untouched objects keep their identity', () => {
  const local = base()
  const remote = doc([text('a', 'A'), text('b', 'B'), text('c', 'C')])
  remote.objects.forEach((o, i) => { o.z = i * 10 })
  const { doc: merged } = mergeDocuments({ base: base(), local, remote })
  assert.equal(merged.objects[0], local.objects[0])
  assert.deepEqual(merged.objects.map((o) => o.z), [0, 1, 2])
})

test('an object named as touched counts as changed by the user: the agent cannot delete it, and its own fields win', () => {
  const remote = doc([text('a', 'A'), text('c', 'C')]) // b deleted by the agent
  const { doc: merged } = mergeDocuments({ base: base(), local: base(), remote, touched: ['b'] })
  assert.deepEqual(ids(merged), ['a', 'b', 'c'])
  const rewritten = doc([text('a', 'A'), text('b', 'B by agent'), text('c', 'C')])
  assert.equal(byId(mergeDocuments({ base: base(), local: base(), remote: rewritten, touched: ['b'] }).doc, 'b').content, 'B by agent')
})

test('a connector already detached in the stored note stays; only one whose end this merge removed goes', () => {
  const loose = { id: 'k1', type: 'connector', fromId: 'a', toId: 'gone', geometry: g } // already dangling before the merge
  const tied = { id: 'k2', type: 'connector', fromId: 'a', toId: 'b', geometry: g }
  const start = doc([text('a', 'A'), text('b', 'B'), loose, tied])
  const remote = doc([text('a', 'A'), loose, tied]) // b deleted
  const { doc: merged } = mergeDocuments({ base: start, local: start, remote })
  assert.deepEqual(ids(merged), ['a', 'k1'])
})

test('the page grid: the agent\'s when the user left it, the user\'s when changed', () => {
  const grown = doc([text('a', 'A')], { columns: 2, rows: 1 })
  assert.deepEqual(mergeDocuments({ base: base(), local: base(), remote: grown }).doc.page, { columns: 2, rows: 1 })
  const mine = doc([text('a', 'A'), text('b', 'B'), text('c', 'C')], { columns: 1, rows: 3 })
  assert.deepEqual(mergeDocuments({ base: base(), local: mine, remote: grown }).doc.page, { columns: 1, rows: 3 })
})
