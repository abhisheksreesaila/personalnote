import assert from 'node:assert/strict'
import test from 'node:test'
import { FabricObject } from 'fabric'
import { boundingRect, contentBounds } from './bounds.js'

// Real Fabric is the oracle: the page rules (growth, fold-back, connector ends) are measured on getBoundingRect(), which counts the stroke
// and turns the box about its centre, so the model-side rect must give the same numbers.
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1e-7, `${label}: ${actual} vs ${expected}`)
let seed = 5
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const between = (low, high) => low + random() * (high - low)

test('the bounding rect of a model object is the one Fabric measures (stroke, scale, skew, flip and turn)', () => {
  for (let i = 0; i < 300; i += 1) {
    const geometry = {
      x: between(-200, 900), y: between(-200, 900), width: between(1, 400), height: between(1, 300),
      rotation: i % 5 === 0 ? 90 : i % 7 === 0 ? 0 : between(-180, 180), scaleX: between(0.3, 3), scaleY: between(0.3, 3),
      flipX: i % 2 === 0, flipY: i % 3 === 0, skewX: i % 3 === 0 ? between(-30, 30) : 0, skewY: i % 4 === 0 ? between(-30, 30) : 0,
    }
    const strokeWidth = i % 2 ? between(0.5, 8) : 2
    const object = { type: 'shape', kind: 'rect', geometry, stroke: '#000', strokeWidth, strokeUniform: i % 6 === 0 }
    const real = new FabricObject({
      left: geometry.x + geometry.width / 2, top: geometry.y + geometry.height / 2, originX: 'center', originY: 'center', width: geometry.width, height: geometry.height,
      angle: geometry.rotation, scaleX: geometry.scaleX, scaleY: geometry.scaleY, flipX: geometry.flipX, flipY: geometry.flipY, skewX: geometry.skewX, skewY: geometry.skewY,
      strokeWidth, strokeUniform: i % 6 === 0,
    })
    const rect = real.getBoundingRect()
    const mine = boundingRect(object)
    near(mine.left, rect.left, 'left'); near(mine.top, rect.top, 'top'); near(mine.width, rect.width, 'width'); near(mine.height, rect.height, 'height')
  }
})

test('a text block without a stored size is measured by the host', () => {
  const text = { type: 'text', geometry: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 } }
  const rect = boundingRect(text, { width: 100, height: 40 })
  assert.equal(rect.width, 101) // Fabric counts its default 1 px stroke width
  assert.equal(rect.left, 9.5)
})

test('the content bounds leave out connectors and unknown objects, and are null for an empty note', () => {
  const geometry = { x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
  assert.equal(contentBounds([]), null)
  const box = (x, y, extras) => ({ type: 'image', geometry: { ...geometry, x, y }, ...extras })
  const bounds = contentBounds([box(0, 0), box(100, 50), { type: 'connector', geometry: { ...geometry, x: -999, y: -999 } }, { type: 'unknown', raw: {} }])
  assert.deepEqual(bounds, { left: 0, top: 0, right: 110, bottom: 60 })
})
