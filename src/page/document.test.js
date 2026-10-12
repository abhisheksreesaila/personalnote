import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyPageDocument, normalizePageDocument } from './document.js'

test('an empty page is empty Markdown with no ink', () => {
  assert.deepEqual(emptyPageDocument(), { version: 1, markdown: '', ink: { marks: [], drawings: [] } })
})

test('a saved page comes back as it was, unknown ink fields included', () => {
  const saved = { version: 1, markdown: '# Hi', ink: { marks: [{ id: 'm1' }], drawings: [{ id: 'd1' }], folded: ['d1'] } }
  assert.deepEqual(normalizePageDocument(saved), saved)
})

test('broken input never throws: missing or wrong parts fall back to empty', () => {
  assert.deepEqual(normalizePageDocument(null), emptyPageDocument())
  assert.deepEqual(normalizePageDocument({ markdown: 7, ink: { marks: 'x', drawings: [3, { id: 'd' }] } }), { version: 1, markdown: '', ink: { marks: [], drawings: [{ id: 'd' }] } })
})
