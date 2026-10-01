import assert from 'node:assert/strict'
import test from 'node:test'
import { detectEngine, detectHost, createFrameStats, createSpeedMeter, isSpeedMeterShortcut } from './speedMeter.js'

test('engine from userAgentData brands', () => {
  assert.equal(detectEngine({ userAgentData: { brands: [{ brand: 'Not A;Brand' }, { brand: 'Chromium' }, { brand: 'Google Chrome' }] }, userAgent: '' }), 'Chromium')
})

test('engine from userAgent strings', () => {
  const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  const safari = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
  const gtk = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
  const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
  assert.equal(detectEngine({ userAgent: chrome }), 'Chromium')
  assert.equal(detectEngine({ userAgent: 'x Edg/120 Chrome/120' }), 'Chromium')
  assert.equal(detectEngine({ userAgent: safari }), 'WebKit')
  assert.equal(detectEngine({ userAgent: gtk }), 'WebKit')
  assert.equal(detectEngine({ userAgent: firefox }), 'Firefox')
  assert.equal(detectEngine({ userAgent: 'curl' }), 'Unknown')
  assert.equal(detectEngine({}), 'Unknown')
})

test('host: desktop app, app window, or browser', () => {
  assert.equal(detectHost({ pywebview: {} }), 'Desktop app')
  assert.equal(detectHost({ hostFlag: 'desktop' }), 'Desktop app')
  assert.equal(detectHost({ standalone: true }), 'App window')
  assert.equal(detectHost({ menubarVisible: false }), 'App window')
  assert.equal(detectHost({ menubarVisible: true }), 'Browser')
  assert.equal(detectHost({}), 'Browser')
})

test('frame stats: fps and slowest frame over a 2 s window', () => {
  const stats = createFrameStats(2000)
  assert.deepEqual(stats.snapshot(), { fps: 0, slowestMs: 0 })
  let t = 0
  for (let i = 0; i < 60; i += 1) { stats.record(t); t += 1000 / 60 }
  const s = stats.snapshot()
  assert.ok(Math.abs(s.fps - 60) < 1.5, `fps ${s.fps}`)
  assert.ok(Math.abs(s.slowestMs - 16.7) < 0.5)
  stats.record(t - 1000 / 60 + 120) // a 120 ms frame after the last 60 fps frame
  assert.equal(Math.round(stats.snapshot().slowestMs), 120)
})

test('old frames fall out of the window', () => {
  const stats = createFrameStats(2000)
  stats.record(0)
  stats.record(500)
  stats.record(3000)
  stats.record(3016)
  assert.ok(stats.snapshot().slowestMs < 20)
  stats.reset()
  assert.deepEqual(stats.snapshot(), { fps: 0, slowestMs: 0 })
})

test('shortcut is Ctrl/Cmd+Shift+F, never while typing', () => {
  const key = { code: 'KeyF', ctrlKey: true, shiftKey: true }
  assert.equal(isSpeedMeterShortcut(key), true)
  assert.equal(isSpeedMeterShortcut({ code: 'KeyF', metaKey: true, shiftKey: true }), true)
  assert.equal(isSpeedMeterShortcut(key, { blocked: true }), false)
  assert.equal(isSpeedMeterShortcut({ code: 'KeyF', ctrlKey: true }), false)
  assert.equal(isSpeedMeterShortcut({ code: 'KeyF', shiftKey: true }), false)
  assert.equal(isSpeedMeterShortcut({ ...key, altKey: true }), false)
})

test('the meter schedules no frames until started and none after stop', () => {
  let queued = null
  let scheduled = 0
  const updates = []
  const meter = createSpeedMeter({
    onUpdate: (s) => updates.push(s),
    raf: (fn) => { scheduled += 1; queued = fn; return scheduled },
    caf: () => { queued = null },
  })
  assert.equal(scheduled, 0)
  meter.start()
  meter.start()
  assert.equal(scheduled, 1)
  for (let t = 0; t < 1200; t += 16) queued(t)
  assert.ok(updates.length >= 2)
  meter.stop()
  assert.equal(queued, null)
  assert.equal(meter.running, false)
})

test('hiding the page pauses the loop and showing it restarts with fresh stats', () => {
  const listeners = []
  const doc = { hidden: false, addEventListener: (type, fn) => listeners.push(fn) }
  let queued = null
  const updates = []
  const meter = createSpeedMeter({
    doc, intervalMs: 0,
    onUpdate: (s) => updates.push(s),
    raf: (fn) => { queued = fn; return 1 },
    caf: () => { queued = null },
  })
  meter.start()
  queued(0); queued(16)
  doc.hidden = true
  listeners.forEach((fn) => fn())
  assert.equal(queued, null)
  doc.hidden = false
  listeners.forEach((fn) => fn())
  queued(30000); queued(30016)
  assert.ok(updates.at(-1).slowestMs < 20, `slowest ${updates.at(-1).slowestMs}`)
  meter.stop()
  doc.hidden = true
  listeners.forEach((fn) => fn())
  doc.hidden = false
  listeners.forEach((fn) => fn())
  assert.equal(meter.running, false)
})
