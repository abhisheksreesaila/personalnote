import assert from 'node:assert/strict'
import test from 'node:test'
import { frozen } from './oracle.js'
import { centerFromOrigin, isSimplePath, pathBounds, rotatePoint, shiftPath, transformedDimensions } from './geometry.js'

// Fabric (frozen in tests/fixtures/fabric-oracle.json, see oracle.js) is the oracle: these helpers must agree with what it did, not with our reading of its source.
const near = (actual, expected, label, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`)

test('path bounds equal the width, height and pathOffset Fabric gave a Path, quirks included', () => {
  assert.ok(frozen.pathBounds.length > 40)
  for (const { path, width, height, offsetX, offsetY } of frozen.pathBounds) {
    const bounds = pathBounds(path)
    near(bounds.width, width, 'width')
    near(bounds.height, height, 'height')
    near(bounds.left + bounds.width / 2, offsetX, 'pathOffset.x')
    near(bounds.top + bounds.height / 2, offsetY, 'pathOffset.y')
  }
})

test('only absolute M, L, Q, C and Z with numbers count as a simple path', () => {
  assert.equal(isSimplePath([['M', 1, 2], ['Q', 1, 2, 3, 4], ['Z']]), true)
  assert.equal(isSimplePath([['M', 1, 2], ['l', 1, 2]]), false)
  assert.equal(isSimplePath([['M', 1]]), false)
  assert.equal(isSimplePath([['A', 1, 1, 0, 0, 0, 5, 5]]), false)
  assert.equal(isSimplePath('M 1 2'), false)
  assert.deepEqual(shiftPath([['M', 1, 2], ['Q', 1, 2, 3, 4], ['Z']], 10, 100), [['M', 11, 102], ['Q', 11, 102, 13, 104], ['Z']])
})

test('quarter turns are exact, like Fabric', () => {
  assert.deepEqual(rotatePoint({ x: 1, y: 0 }, Math.PI / 2, { x: 0, y: 0 }), { x: 0, y: 1 })
  assert.deepEqual(rotatePoint({ x: 1, y: 0 }, Math.PI, { x: 0, y: 0 }), { x: -1, y: 0 })
})

test('centre and origin point agree with Fabric for every origin, angle, scale, skew and stroke setting', () => {
  assert.equal(frozen.objectCenters.length, 400)
  for (const { props, center } of frozen.objectCenters) {
    const mine = centerFromOrigin({ ...props, dimensions: transformedDimensions(props) })
    near(mine.x, center.x, 'centre x')
    near(mine.y, center.y, 'centre y')
  }
})
