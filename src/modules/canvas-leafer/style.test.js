import assert from 'node:assert/strict'
import test from 'node:test'
import { fabricLineMetrics, withAlpha } from './style.js'

test("line pitch is Fabric's: font size * 1.13 * line-height multiplier", () => {
  assert.ok(Math.abs(fabricLineMetrics(24, 1.45).pitch - 24 * 1.13 * 1.45) < 1e-9)
})

test('the first baseline lands where Fabric puts it, whatever the line height', () => {
  for (const [size, multiplier] of [[24, 1.45], [34, 1.05], [20, 1.16]]) {
    const { pitch, firstBaselineShift } = fabricLineMetrics(size, multiplier)
    const leaferBaseline = firstBaselineShift + (pitch + 0.7 * size) / 2
    assert.ok(Math.abs(leaferBaseline - size * 1.13 * (1 - 0.222)) < 1e-9)
  }
})

test('the highlighter alpha joins the colour; a colour without alpha or in another spelling is left alone', () => {
  assert.equal(withAlpha('#20201e', 0.3333), 'rgba(32, 32, 30, 0.333)')
  assert.equal(withAlpha('#20201e', undefined), '#20201e')
  assert.equal(withAlpha('rgb(1,2,3)', 0.5), 'rgb(1,2,3)')
})
