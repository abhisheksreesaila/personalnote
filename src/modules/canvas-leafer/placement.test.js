import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { COLUMNS, ROWS, generateNote } from '../../../scripts/benchmark-note.mjs'
import { fromFabric } from '../../core/document/index.js'
import { placedPoints } from '../../core/document/placement.js'
import { applyMatrix, multiplyMatrices, placementMatrix } from './placement.js'

const FIXTURE_DIR = fileURLToPath(new URL('../../../tests/fixtures/documents/', import.meta.url))
const fixtures = [
  ...fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(fs.readFileSync(`${FIXTURE_DIR}${name}`, 'utf8'))),
  { name: 'benchmark-600', content: generateNote(), pageState: { columns: COLUMNS, rows: ROWS } },
]

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

// The matrices, applied to the box corners and ink points, must land where the documented formula (the test oracle) puts them.
function placed(objects, parent = IDENTITY, out = []) {
  for (const object of objects) {
    if (object.type === 'unknown') continue
    const g = object.geometry
    const matrix = multiplyMatrices(parent, placementMatrix(g))
    const { width = 0, height = 0 } = g
    for (const [x, y] of [[0, 0], [width, 0], [width, height], [0, height]]) { const p = applyMatrix(matrix, { x, y }); out.push(p.x, p.y) }
    if (object.type === 'ink' && object.kind === 'stroke') {
      const commandPoints = object.path.flatMap((command) => { const list = []; for (let i = 1; i + 1 < command.length; i += 2) list.push({ x: command[i], y: command[i + 1] }); return list })
      for (const point of [...commandPoints, ...(object.points ?? [])]) { const p = applyMatrix(matrix, point); out.push(p.x, p.y) }
    }
    if (object.type === 'group') {
      const children = [...object.children].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
      placed(children, matrix, out)
    }
  }
  return out
}

for (const entry of fixtures) {
  test(`${entry.name}: matrices from the model rules land every corner and ink point where the oracle puts it`, () => {
    const doc = fromFabric(entry.content, entry.pageState)
    const expected = placedPoints(doc.objects)
    const actual = placed(doc.objects)
    assert.equal(actual.length, expected.length)
    for (let i = 0; i < expected.length; i += 1) assert.ok(Math.abs(actual[i] - expected[i]) <= 1e-6, `point ${i}: ${actual[i]} vs ${expected[i]}`)
  })
}

test('a text block without a height is placed from the measured height, so a turn is about the real centre', () => {
  const geometry = { x: 100, y: 200, width: 300, rotation: 90, scaleX: 1, scaleY: 1 }
  const corner = applyMatrix(placementMatrix(geometry, { height: 40 }), { x: 0, y: 0 })
  // Box centre (250, 220); the top-left corner (100, 200) turns a quarter about it to (270, 70).
  assert.ok(Math.abs(corner.x - 270) < 1e-9 && Math.abs(corner.y - 70) < 1e-9, JSON.stringify(corner))
  // Without the measurement the height counts as 0 and the turn is about the top edge: somewhere else.
  assert.ok(Math.abs(applyMatrix(placementMatrix(geometry), { x: 0, y: 0 }).y - 70) > 1)
})

test('flip, scale, skew and turn follow the documented order', () => {
  const g = { x: 0, y: 0, width: 100, height: 50, rotation: 30, scaleX: 2, scaleY: 0.5, flipX: true, flipY: false, skewX: 20, skewY: 10 }
  const expected = placedPoints([{ type: 'shape', geometry: g }])
  const m = placementMatrix(g)
  const corners = [[0, 0], [100, 0], [100, 50], [0, 50]].flatMap(([x, y]) => { const p = applyMatrix(m, { x, y }); return [p.x, p.y] })
  corners.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `corner value ${i}`))
})
