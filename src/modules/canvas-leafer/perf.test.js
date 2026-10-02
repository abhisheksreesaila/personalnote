import assert from 'node:assert/strict'
import test from 'node:test'
import { PERF_DEFAULTS, pixelRatioFor, readPerf } from './perf.js'

test('the defaults are what ships, and a benchmark can switch any of them off', () => {
  assert.deepEqual(readPerf(undefined), PERF_DEFAULTS)
  assert.equal(PERF_DEFAULTS.bakedShadow, true)
  assert.equal(PERF_DEFAULTS.dprCap, 2)
  assert.deepEqual(readPerf({ pageBitmaps: 'off', lodZoom: 0.5 }), { ...PERF_DEFAULTS, pageBitmaps: 'off', lodZoom: 0.5 })
  assert.deepEqual(readPerf('nonsense'), PERF_DEFAULTS)
})

test('the canvas draws at most dprCap device pixels per CSS pixel (0 means no cap)', () => {
  assert.equal(pixelRatioFor(1, PERF_DEFAULTS), 1)
  assert.equal(pixelRatioFor(2, PERF_DEFAULTS), 2)
  assert.equal(pixelRatioFor(3, PERF_DEFAULTS), 2)
  assert.equal(pixelRatioFor(undefined, PERF_DEFAULTS), 1)
  assert.equal(pixelRatioFor(3, { ...PERF_DEFAULTS, dprCap: 0 }), 3)
})
