import assert from 'node:assert/strict'
import test from 'node:test'
import { frozen } from '../../core/document/oracle.js'
import { boundingRect, contentBounds } from './bounds.js'

// Fabric (frozen in tests/fixtures/fabric-oracle.json) is the oracle: the page rules (growth, fold-back, connector ends) are measured on getBoundingRect(), which counts the stroke
// and turns the box about its centre, so the model-side rect must give the same numbers.
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1e-7, `${label}: ${actual} vs ${expected}`)
test('the bounding rect of a model object is the one Fabric measured (stroke, scale, skew, flip and turn)', () => {
  assert.equal(frozen.boundingRects.length, 300)
  for (const { geometry, strokeWidth, strokeUniform, rect } of frozen.boundingRects) {
    const mine = boundingRect({ type: 'shape', kind: 'rect', geometry, stroke: '#000', strokeWidth, strokeUniform })
    near(mine.left, rect.left, 'left'); near(mine.top, rect.top, 'top'); near(mine.width, rect.width, 'width'); near(mine.height, rect.height, 'height')
  }
})

test('a text block without a stored size is measured by the host', () => {
  const text = { type: 'text', geometry: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 } }
  const rect = boundingRect(text, { width: 100, height: 40 })
  assert.equal(rect.width, 101) // Fabric counts its default 1 px stroke width
  assert.equal(rect.left, 9.5)
})

test('the content bounds leave out connectors, and are null for an empty note', () => {
  const geometry = { x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
  assert.equal(contentBounds([]), null)
  const box = (x, y, extras) => ({ type: 'image', geometry: { ...geometry, x, y }, ...extras })
  const bounds = contentBounds([box(0, 0), box(100, 50), { type: 'connector', geometry: { ...geometry, x: -999, y: -999 } }, { type: 'unknown', raw: {} }])
  assert.deepEqual(bounds, { left: 0, top: 0, right: 110, bottom: 60 })
  assert.deepEqual(contentBounds([box(0, 0), { type: 'unknown', raw: { left: 900, top: 20, width: 50, height: 30 } }]), { left: 0, top: 0, right: 950, bottom: 50 }, 'an unknown object counts by its raw left, top and size')
})
