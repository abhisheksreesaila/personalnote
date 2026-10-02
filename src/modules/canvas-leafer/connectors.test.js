import assert from 'node:assert/strict'
import test from 'node:test'
import { arrowPath, connectorAt, connectorLayout, danglingChanges, endpointsOf, followChanges, newConnector, rectOfObject } from './connectors.js'
import { connectorBox, connectorEndpoints } from '../editor/connectors.js'

const UPRIGHT = { rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const box = (id, x, y, width = 100, height = 60, extras = {}) => ({ id, type: 'image', z: 0, geometry: { x, y, width, height, ...UPRIGHT }, ...extras })
const rectOf = (object) => rectOfObject(object)

test('a connector between two objects is the box between their edges, pulled back by the gap, with direction flags', () => {
  const a = box('a', 100, 100)
  const b = box('b', 400, 300)
  const made = newConnector([a, b], { id: 'c', fromId: 'a', toId: 'b', z: 2, rectOf })
  const ends = connectorEndpoints(rectOf(a), rectOf(b))
  const box2 = connectorBox(ends.start, ends.end)
  assert.equal(made.geometry.x, box2.left)
  assert.equal(made.geometry.width, box2.width)
  assert.equal(made.reverseX, false)
  assert.equal(made.reverseY, false)
  const back = endpointsOf(made)
  assert.ok(Math.abs(back.start.x - ends.start.x) < 1e-9 && Math.abs(back.end.y - ends.end.y) < 1e-9)
  assert.equal(newConnector([a, b], { fromId: 'b', toId: 'a', rectOf }).reverseX, true)
})

test('no connector for the same object, a connector as an end, an existing pair, or objects too close for an arrow', () => {
  const a = box('a', 100, 100)
  const b = box('b', 400, 300)
  const c = newConnector([a, b], { id: 'c', fromId: 'a', toId: 'b', z: 2, rectOf })
  assert.equal(newConnector([a, b], { fromId: 'a', toId: 'a', rectOf }), null)
  assert.equal(newConnector([a, b, c], { fromId: 'a', toId: 'b', rectOf }), null)
  assert.equal(newConnector([a, b, c], { fromId: 'c', toId: 'b', rectOf }), null)
  assert.equal(newConnector([a, box('near', 202, 100)], { fromId: 'a', toId: 'near', rectOf }), null)
  assert.equal(connectorLayout(rectOf(a), rectOf(box('x', 100, 100))).visible, false)
})

test('following touches only the connectors on the objects named, and changes nothing when nothing moved', () => {
  const a = box('a', 100, 100)
  const b = box('b', 400, 100)
  const d = box('d', 100, 700)
  const e = box('e', 400, 700)
  const ab = newConnector([a, b], { id: 'ab', fromId: 'a', toId: 'b', z: 4, rectOf })
  const de = newConnector([d, e], { id: 'de', fromId: 'd', toId: 'e', z: 5, rectOf })
  const objects = [a, b, d, e, ab, de]
  assert.deepEqual(followChanges(objects, null, rectOf), [])
  const moved = objects.map((object) => (object.id === 'b' ? box('b', 400, 400) : object))
  assert.deepEqual(followChanges(moved, ['b'], rectOf).map((change) => change.id), ['ab'])
  assert.deepEqual(followChanges(moved, ['e'], rectOf), [])
  assert.deepEqual(followChanges(moved, null, rectOf).map((change) => change.id), ['ab'])
})

test('a rotated or resized end is measured by its bounding rect, as Fabric does', () => {
  const a = box('a', 100, 100, 100, 100)
  const b = box('b', 600, 100, 100, 100)
  const link = newConnector([a, b], { id: 'ab', fromId: 'a', toId: 'b', z: 2, rectOf })
  const turned = { ...a, geometry: { ...a.geometry, rotation: 45 } }
  const [change] = followChanges([turned, b, link], ['a'], rectOf)
  assert.ok(change.after.geometry.x > link.geometry.x, 'the turned box reaches further right, so the arrow starts later')
})

test('a connector with an end that is gone is dangling', () => {
  const a = box('a', 100, 100)
  const b = box('b', 400, 100)
  const ab = newConnector([a, b], { id: 'ab', fromId: 'a', toId: 'b', z: 2, rectOf })
  assert.deepEqual(danglingChanges([a, ab]).map((change) => change.id), ['ab'])
  assert.deepEqual(danglingChanges([a, b, ab]), [])
})

test('only the line of a connector is hit, within the tolerance, never its whole diagonal box', () => {
  const a = box('a', 100, 100)
  const b = box('b', 600, 500)
  const ab = newConnector([a, b], { id: 'ab', fromId: 'a', toId: 'b', z: 2, rectOf })
  const { start, end } = endpointsOf(ab)
  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  assert.equal(connectorAt([a, b, ab], middle, 9)?.id, 'ab')
  assert.equal(connectorAt([a, b, ab], { x: middle.x + 40, y: middle.y - 40 }, 9), null)
  assert.equal(connectorAt([a, b, { ...ab, visible: false }], middle, 9), null)
})

test('the arrow is drawn from its tail to a head at the end', () => {
  const a = box('a', 100, 100)
  const b = box('b', 400, 100)
  const ab = newConnector([a, b], { id: 'ab', fromId: 'a', toId: 'b', z: 2, rectOf })
  const n = '-?[\\d.]+'
  assert.match(arrowPath(ab), new RegExp(`^M ${n} ${n} L ${n} ${n} M ${n} ${n} L ${n} ${n} L ${n} ${n} Z$`))
})
