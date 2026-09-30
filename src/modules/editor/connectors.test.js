import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ConnectorIndex,
  arrowHeadPoints,
  connectorBox,
  connectorEndpoints,
  connectorsLeftDangling,
  distanceToSegment,
  endpointsFromBox,
} from './connectors.js'

const rect = (left, top, width, height) => ({ left, top, width, height })
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`)

test('anchors sit on facing edges with a gap, horizontally aligned cards', () => {
  const ends = connectorEndpoints(rect(0, 0, 100, 50), rect(300, 0, 100, 50), 6)
  assert.equal(ends.visible, true)
  close(ends.start.x, 106, 'start x')
  close(ends.start.y, 25, 'start y')
  close(ends.end.x, 294, 'end x')
  close(ends.end.y, 25, 'end y')
})

test('anchors follow the line between centres for diagonal cards', () => {
  const ends = connectorEndpoints(rect(0, 0, 100, 100), rect(300, 300, 100, 100), 0)
  close(ends.start.x, 100, 'start x')
  close(ends.start.y, 100, 'start y')
  close(ends.end.x, 300, 'end x')
  close(ends.end.y, 300, 'end y')
})

test('vertical stacks anchor on top and bottom edges', () => {
  const ends = connectorEndpoints(rect(0, 200, 100, 40), rect(0, 0, 100, 40), 4)
  close(ends.start.y, 196, 'start y')
  close(ends.end.y, 44, 'end y')
})

test('overlapping or touching objects produce a hidden connector', () => {
  assert.equal(connectorEndpoints(rect(0, 0, 100, 100), rect(50, 50, 100, 100), 6).visible, false)
  assert.equal(connectorEndpoints(rect(0, 0, 100, 100), rect(104, 0, 100, 100), 6).visible, false)
})

test('identical centres do not throw', () => {
  assert.equal(connectorEndpoints(rect(0, 0, 10, 10), rect(0, 0, 10, 10), 6).visible, false)
})

test('box round-trips endpoints in every direction', () => {
  const cases = [
    [{ x: 10, y: 20 }, { x: 110, y: 70 }],
    [{ x: 110, y: 70 }, { x: 10, y: 20 }],
    [{ x: 10, y: 70 }, { x: 110, y: 20 }],
    [{ x: 110, y: 20 }, { x: 10, y: 70 }],
  ]
  for (const [start, end] of cases) {
    const back = endpointsFromBox(connectorBox(start, end))
    close(back.start.x, start.x, 'start x'); close(back.start.y, start.y, 'start y')
    close(back.end.x, end.x, 'end x'); close(back.end.y, end.y, 'end y')
  }
})

test('box keeps a minimum size so flat arrows stay drawable', () => {
  const box = connectorBox({ x: 0, y: 5 }, { x: 100, y: 5 })
  assert.ok(box.height >= 1)
  assert.equal(box.width, 100)
})

test('arrowhead tip is the end point and wings trail behind it', () => {
  const [tip, left, right] = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 10)
  assert.deepEqual(tip, { x: 100, y: 0 })
  assert.ok(left.x < 100 && right.x < 100)
  close(left.y, -right.y, 'symmetric wings')
})

test('distance to a segment', () => {
  close(distanceToSegment({ x: 50, y: 10 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 10, 'perpendicular')
  close(distanceToSegment({ x: -30, y: 40 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 50, 'past the start')
  close(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5, 'degenerate')
})

test('index finds connectors by either endpoint, and only those', () => {
  const index = new ConnectorIndex()
  index.add({ id: 'c1', fromId: 'a', toId: 'b' })
  index.add({ id: 'c2', fromId: 'b', toId: 'c' })
  assert.deepEqual(index.forObjects(['a']).map((c) => c.id), ['c1'])
  assert.deepEqual(index.forObjects(['b']).map((c) => c.id).sort(), ['c1', 'c2'])
  assert.deepEqual(index.forObjects(['a', 'b']).map((c) => c.id).sort(), ['c1', 'c2'])
  assert.deepEqual(index.forObjects(['zzz']), [])
})

test('index removal and duplicate detection', () => {
  const index = new ConnectorIndex()
  index.add({ id: 'c1', fromId: 'a', toId: 'b' })
  assert.equal(index.has('a', 'b'), true)
  assert.equal(index.has('b', 'a'), false)
  index.remove('c1')
  assert.equal(index.has('a', 'b'), false)
  assert.deepEqual(index.forObjects(['a']), [])
})

test('index rebuild replaces earlier contents', () => {
  const index = new ConnectorIndex()
  index.add({ id: 'old', fromId: 'a', toId: 'b' })
  index.rebuild([{ id: 'n', fromId: 'c', toId: 'd' }])
  assert.deepEqual(index.forObjects(['a']), [])
  assert.deepEqual(index.forObjects(['d']).map((c) => c.id), ['n'])
})

test('dangling connectors are those missing an endpoint', () => {
  const objectIds = new Set(['a', 'b'])
  const dangling = connectorsLeftDangling([
    { id: 'ok', fromId: 'a', toId: 'b' },
    { id: 'gone', fromId: 'a', toId: 'x' },
    { id: 'gone2', fromId: 'y', toId: 'b' },
    { id: 'self', fromId: 'a', toId: 'a' },
  ], objectIds)
  assert.deepEqual(dangling.map((c) => c.id), ['gone', 'gone2', 'self'])
})
