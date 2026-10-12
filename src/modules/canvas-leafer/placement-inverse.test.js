// F-028: the inverse of placement. A matrix the editor produced goes back into model geometry and places the box where the matrix did.
import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMatrix, geometryFromMatrix, placementMatrix } from './placement.js'

const BOX = { width: 160, height: 90 }
const corners = (matrix, { width, height }) => [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => applyMatrix(matrix, { x, y }))
const samePoints = (a, b, tolerance = 1e-6) => a.every((p, i) => Math.abs(p.x - b[i].x) <= tolerance && Math.abs(p.y - b[i].y) <= tolerance)

for (const [name, g] of [
  ['plain', { x: 40, y: 70, rotation: 0, scaleX: 1, scaleY: 1 }],
  ['turned', { x: 40, y: 70, rotation: 37, scaleX: 1, scaleY: 1 }],
  ['scaled and turned', { x: -20, y: 5, rotation: -130, scaleX: 1.5, scaleY: 0.75 }],
  ['flipped', { x: 10, y: 10, rotation: 20, scaleX: 1, scaleY: 1, flipX: true }],
  ['skewed', { x: 10, y: 10, rotation: 15, scaleX: 2, scaleY: 1, skewX: 25 }],
]) {
  test(`geometryFromMatrix: ${name} geometry survives matrix -> geometry -> matrix`, () => {
    const geometry = { ...BOX, ...g }
    const matrix = placementMatrix(geometry)
    const back = geometryFromMatrix(matrix, BOX)
    assert.ok(samePoints(corners(placementMatrix(back), BOX), corners(matrix, BOX)), JSON.stringify(back))
  })
}

test('geometryFromMatrix: a pure move keeps rotation, scale and skew exactly', () => {
  const geometry = { ...BOX, x: 10, y: 20, rotation: 33, scaleX: 1.25, scaleY: 0.8, skewX: 12 }
  const base = placementMatrix(geometry)
  const back = geometryFromMatrix({ ...base, e: base.e + 50, f: base.f - 7 }, BOX, geometry)
  assert.equal(back.rotation, 33)
  assert.equal(back.scaleX, 1.25)
  assert.equal(back.scaleY, 0.8)
  assert.equal(back.skewX, 12)
  assert.ok(Math.abs(back.x - 60) < 1e-9 && Math.abs(back.y - 13) < 1e-9, JSON.stringify(back))
})

test('geometryFromMatrix: a resized box lands where the matrix puts it', () => {
  const old = { ...BOX, x: 100, y: 100, rotation: 90, scaleX: 1, scaleY: 1 }
  const size = { width: 200, height: 90 }
  const matrix = { ...placementMatrix(old), e: 300, f: 80 }
  const back = geometryFromMatrix(matrix, size, old)
  assert.equal(back.width, 200)
  assert.ok(samePoints(corners(placementMatrix(back), size), corners(matrix, size)))
})

test('geometryFromMatrix: scale in the matrix is baked into the size when asked, so text never stretches', () => {
  const old = { ...BOX, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }
  const m = { a: 2, b: 0, c: 0, d: 1.5, e: 10, f: 20 }
  const back = geometryFromMatrix(m, BOX, old, { bake: true })
  assert.deepEqual([back.width, back.height, back.scaleX, back.scaleY], [320, 135, 1, 1])
  assert.deepEqual([back.x, back.y], [10, 20])
})

test('geometryFromMatrix: an object with skewY keeps its place after the editor scales and turns it', () => {
  const old = { ...BOX, x: 30, y: 40, rotation: 20, scaleX: 1.5, scaleY: 1, skewY: 15 }
  const was = placementMatrix(old)
  // the editor scales the box by (1.3, 0.8) about the world origin and turns it 25 degrees more
  const k = (25 * Math.PI) / 180
  const edit = { a: Math.cos(k) * 1.3, b: Math.sin(k) * 1.3, c: -Math.sin(k) * 0.8, d: Math.cos(k) * 0.8 }
  const matrix = { a: edit.a * was.a + edit.c * was.b, b: edit.b * was.a + edit.d * was.b, c: edit.a * was.c + edit.c * was.d, d: edit.b * was.c + edit.d * was.d, e: edit.a * was.e + edit.c * was.f + 7, f: edit.b * was.e + edit.d * was.f - 9 }
  const back = geometryFromMatrix(matrix, BOX, old)
  assert.ok(samePoints(corners(placementMatrix(back), BOX), corners(matrix, BOX), 1e-6), JSON.stringify(back))
})
