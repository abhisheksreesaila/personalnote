import assert from 'node:assert/strict'
import test from 'node:test'
import { comparisonRows, formatComparison, formatReport, summarize, verdict } from './report.js'
import { generateStressDocument } from './stress-note.js'

test('summarize gives p50, p95 and max, ignores junk and counts the slow frames', () => {
  const values = [...Array.from({ length: 94 }, () => 16.7), 40, 50, 60, 70, 80, 90, Number.NaN]
  const summary = summarize(values)
  assert.deepEqual(summary, { p50: 16.7, p95: 50, max: 90, n: 100, slow: 6 })
  assert.deepEqual(summarize([]), { p50: 0, p95: 0, max: 0, n: 0, slow: 0 })
})

test('verdict reads a p95 frame time the way the eye does', () => {
  assert.equal(verdict(16.8), 'smooth')
  assert.equal(verdict(33.4), 'a few dropped frames')
  assert.equal(verdict(120), 'choppy')
})

test('the report is plain text with every scenario and its numbers', () => {
  const text = formatReport({
    when: '2026-10-02T10:00:00.000Z', engine: 'Chromium', platform: 'Linux', host: 'Desktop app', dpr: 2, screen: '2880x1800', cores: 8,
    note: { objects: 5296, pages: '4x4' },
    results: [{ name: 'Pan', p50: 16.7, p95: 16.8, max: 33.4, n: 360, slow: 1 }, { name: 'Open the note (ms)', unit: 'ms', p50: 1400, p95: null, max: null, n: 1 }],
    failed: ['Typing: no text to edit'],
  })
  assert.match(text, /5296 objects on 4x4 pages/)
  assert.match(text, /Pan\s+16\.7\s+16\.8\s+33\.4\s+360\s+smooth/)
  assert.match(text, /Open the note \(ms\)\s+1400\.0\s+-\s+-\s+1/)
  assert.match(text, /Could not measure: Typing: no text to edit/)
})

test('the stress note is the same every time, has the mix of a busy desk and more than 5,000 objects', () => {
  const a = generateStressDocument(5400)
  const b = generateStressDocument(5400)
  assert.deepEqual(a, b)
  assert.ok(a.objects.length >= 5000)
  const types = Object.groupBy(a.objects, (object) => object.type)
  for (const type of ['text', 'sticky', 'shape', 'ink', 'connector']) assert.ok(types[type]?.length > 100, type)
  assert.equal(new Set(a.objects.map((object) => object.id)).size, a.objects.length)
  const ids = new Set(a.objects.map((object) => object.id))
  for (const connector of types.connector) assert.ok(ids.has(connector.fromId) && ids.has(connector.toId))
})

test('the comparison has a table per note with a column per render mode', () => {
  const modes = [{ id: 'default', label: 'Default' }, { id: 'dpr1', label: 'DPR 1' }]
  const row = (p95) => ({ p50: 16.7, p95, max: p95 + 5 })
  const comparison = { modes, notes: [{ label: 'the stress note', objects: 5400, results: { default: { rows: { 'Pan (100%)': row(30), Zoom: row(40) }, failed: [] }, dpr1: { rows: { 'Pan (100%)': row(20) }, failed: ['Typing: no editor'] } } }] }
  const rows = comparisonRows(comparison.notes[0], modes)
  assert.deepEqual(rows.map((r) => [r.name, ...r.cells]), [['Pan (100%)', '16.7/30/35', '16.7/20/25'], ['Zoom', '16.7/40/45', '-']])
  const text = formatComparison(comparison)
  assert.match(text, /Render modes on the stress note \(5400 objects\)/)
  assert.match(text, /Default\s+DPR 1/)
  assert.match(text, /DPR 1: could not measure Typing/)
})
