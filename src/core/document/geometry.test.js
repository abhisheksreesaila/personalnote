import assert from 'node:assert/strict'
import test from 'node:test'
import { FabricObject, Path } from 'fabric'
import { centerFromOrigin, isSimplePath, originFromCenter, pathBounds, rotatePoint, shiftPath, transformedDimensions } from './geometry.js'

// Real Fabric is the oracle: these helpers must agree with it, not with our reading of its source.
const near = (actual, expected, label, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`)

let seed = 11
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const between = (low, high) => low + random() * (high - low)

test('path bounds equal the width, height and pathOffset Fabric gives a Path, quirks included', () => {
  const paths = [
    [['M', 10, 10], ['Q', 20, 30, 40, 10]],
    [['M', 0, 0], ['L', 50, 20], ['L', 10, 70], ['Z']],
    [['M', 5, 5], ['C', 30, -20, 60, 80, 90, 10], ['L', 100, 100]],
    [['M', 1, 1], ['L', 3, 3], ['M', 100, 100], ['L', 120, 90], ['Q', 140, 140, 160, 100]],
    [],
  ]
  for (let i = 0; i < 40; i += 1) {
    const path = [['M', between(-50, 500), between(-50, 500)]]
    for (let n = 0; n < 12; n += 1) path.push(['Q', between(-50, 500), between(-50, 500), between(-50, 500), between(-50, 500)])
    paths.push(path)
  }
  for (const path of paths) {
    const bounds = pathBounds(path)
    const real = new Path(path)
    near(bounds.width, real.width, 'width')
    near(bounds.height, real.height, 'height')
    near(bounds.left + bounds.width / 2, real.pathOffset.x, 'pathOffset.x')
    near(bounds.top + bounds.height / 2, real.pathOffset.y, 'pathOffset.y')
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
  const origins = ['left', 'center', 'right']
  const verticals = ['top', 'center', 'bottom']
  for (let i = 0; i < 400; i += 1) {
    const props = {
      left: between(-300, 900), top: between(-300, 900), width: between(0, 400), height: between(0, 300),
      angle: i % 5 === 0 ? 90 : i % 7 === 0 ? 0 : between(-180, 180),
      scaleX: between(0.3, 3), scaleY: between(0.3, 3),
      skewX: i % 3 === 0 ? between(-30, 30) : 0, skewY: i % 4 === 0 ? between(-30, 30) : 0,
      strokeWidth: i % 2 ? between(0, 8) : 0, strokeUniform: i % 6 === 0,
      originX: origins[i % 3], originY: verticals[(i >> 1) % 3],
    }
    const real = new FabricObject(props)
    const center = real.getRelativeCenterPoint()
    const mine = centerFromOrigin({ ...props, dimensions: transformedDimensions(props) })
    near(mine.x, center.x, 'centre x')
    near(mine.y, center.y, 'centre y')
    const back = originFromCenter({ ...mine, originX: props.originX, originY: props.originY, angle: props.angle, dimensions: transformedDimensions(props) })
    near(back.x, props.left, 'origin x', 1e-7)
    near(back.y, props.top, 'origin y', 1e-7)
  }
})
