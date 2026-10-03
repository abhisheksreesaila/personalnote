import assert from 'node:assert/strict'
import test from 'node:test'
import { PERF_DEFAULTS, RENDER_MODES, SETTINGS_RENDER_MODES, pixelRatioFor, quietFor, readPerf } from './perf.js'

test('the defaults are what ships, and a benchmark can switch any of them off', () => {
  assert.deepEqual(readPerf(undefined), PERF_DEFAULTS)
  assert.equal(PERF_DEFAULTS.bakedShadow, true)
  assert.equal(PERF_DEFAULTS.dprCap, 2)
  assert.equal(PERF_DEFAULTS.hybrid, true) // the default is the hybrid mode: page bitmaps at every zoom while navigating, live vectors for editing
  assert.equal(PERF_DEFAULTS.gestureTransform, false)
  assert.equal(PERF_DEFAULTS.pageBitmaps, 'always')
  assert.ok(PERF_DEFAULTS.lodZoom > 1)
  assert.equal(PERF_DEFAULTS.dragCrowd, 3)
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

test('asking for the page bitmaps by name puts the gesture transform aside, unless it is asked for too', () => {
  assert.equal(readPerf({ pageBitmaps: 'always' }).gestureTransform, false)
  assert.equal(readPerf({ pageBitmaps: 'always', gestureTransform: true }).gestureTransform, true)
  assert.equal(readPerf({ pageBitmaps: 'off' }).gestureTransform, false)
  assert.equal(readPerf({ ...RENDER_MODES.gestureTransform }).gestureTransform, true)
  assert.equal(readPerf({ ...RENDER_MODES.gestureTransform }).pageBitmaps, 'off')
  assert.equal(readPerf({ ...RENDER_MODES.classic }).gestureTransform, false)
  assert.equal(readPerf({ ...RENDER_MODES.classic }).pageBitmaps, 'adaptive')
  assert.equal(readPerf({ ...RENDER_MODES.bitmaps }).gestureTransform, false)
})

test('the vectors wait longer than the steps of a slow pan are apart, so the bitmaps do not flicker in and out', () => {
  assert.equal(quietFor(170, 0), 170) // nothing measured yet
  assert.equal(quietFor(170, 16), 170) // a smooth machine: the base wait
  assert.equal(quietFor(170, 84), 210) // 84 ms steps (a slow machine): more than two steps
  assert.ok(quietFor(170, 84) > 84 * 2)
  assert.equal(quietFor(170, 5000), 900) // never longer than a second
})

test('each comparison mode switches the hybrid parts off, except the hybrid default', () => {
  assert.equal(readPerf({ ...RENDER_MODES.default }).hybrid, true)
  for (const name of ['gestureTransform', 'classic', 'bitmaps', 'dpr1']) {
    const perf = readPerf({ ...RENDER_MODES[name] })
    assert.equal(perf.hybrid, false, name)
    assert.equal(perf.dragCrowd, 0, name)
  }
  assert.equal(readPerf({ ...RENDER_MODES.dpr1 }).dprCap, 1)
  assert.deepEqual(SETTINGS_RENDER_MODES, ['default', 'classic', 'bitmaps', 'gestureTransform', 'dpr1'])
})
