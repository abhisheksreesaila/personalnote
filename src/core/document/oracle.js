// Test support, not imported by the app. The old canvas engine (Fabric.js 7.4.0) was the oracle for where things end up on the page:
// every conversion rule was checked against what the real library did. The library is gone, so what it did is frozen in
// tests/fixtures/fabric-oracle.json, measured with it just before it was removed (F-036):
//   points          the page position of every box corner and ink point of each fixture note, in stacking order
//   pathBounds      width, height and pathOffset Fabric gave a Path, for the paths in geometry.test.js
//   objectCenters   the centre Fabric computed for an object, for every origin, angle, scale, skew and stroke setting
//   boundingRects   getBoundingRect() of a stroked, turned, scaled, flipped, skewed box
//   connectorPairs  getBoundingRect() of two objects, to place the arrow between them
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const frozen = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../tests/fixtures/fabric-oracle.json', import.meta.url)), 'utf8'))

// Asserts that every number in `actual` is within `tolerance` of the frozen one.
export function assertSamePoints(assert, actual, expected, label, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length, `${label}: number of placed points`)
  for (let i = 0; i < expected.length; i += 1) assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${label}: point ${i}: ${actual[i]} vs ${expected[i]}`)
}
