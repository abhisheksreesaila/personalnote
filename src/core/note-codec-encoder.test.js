// F-028 performance: saving an edited note must cost what changed, not the whole note. The cached encoder writes exactly the bytes the
// plain writer writes, and re-encodes only the objects (and the connectors that touch them) that are new values.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { COLUMNS, ROWS, generateNote } from '../../scripts/benchmark-note.mjs'
import { fromFabric } from './document/fabric.js'
import { applyChanges, compactStacking, planOperation } from './document/operations.js'
import { createDocumentEncoder, encodeDocument, forgetMedia } from './note-codec.js'

const fixtures = ['app-all-tools', 'app-objects', 'edge-transforms', 'ink-dots', 'cli-appended'].map((name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../../tests/fixtures/documents/${name}.json`, import.meta.url)), 'utf8')))
const idsAdded = (doc) => ({ ...doc, objects: doc.objects.map((o, i) => (o.id || o.type === 'unknown' ? o : { ...o, id: `gen_${i}` })) })
const plain = (doc) => JSON.stringify(encodeDocument(compactStacking(doc)))

test('the cached encoder writes the same bytes as the plain writer, before and after edits', () => {
  forgetMedia()
  for (const entry of [...fixtures, { content: generateNote(), pageState: { columns: COLUMNS, rows: ROWS } }]) {
    let doc = idsAdded(fromFabric(entry.content, entry.pageState))
    const encoder = createDocumentEncoder()
    assert.equal(encoder.encode(doc), plain(doc))
    const movable = doc.objects.filter((o) => o.type !== 'connector' && o.type !== 'unknown')
    for (const operation of [
      { type: 'move', ids: [movable[0]?.id], dx: 5, dy: 3 },
      { type: 'reorder', ids: [movable[1]?.id ?? movable[0].id], to: 'front' },
      { type: 'lock', ids: [movable[2]?.id ?? movable[0].id], locked: true },
      { type: 'remove', ids: [movable[3]?.id ?? movable.at(-1).id] },
    ]) {
      doc = applyChanges(doc, planOperation(doc, operation).op)
      assert.equal(encoder.encode(doc), plain(doc), JSON.stringify(operation))
    }
  }
})

test('after one move only that object is written again', () => {
  forgetMedia()
  let doc = idsAdded(fromFabric(generateNote(), { columns: COLUMNS, rows: ROWS }))
  const encoder = createDocumentEncoder()
  encoder.encode(doc)
  const first = encoder.stats().written
  assert.ok(first >= doc.objects.length)
  const target = doc.objects.find((o) => o.type !== 'connector' && o.type !== 'unknown')
  doc = applyChanges(doc, planOperation(doc, { type: 'move', ids: [target.id], dx: 4, dy: 4 }).op)
  encoder.encode(doc)
  const second = encoder.stats().written - first
  const touching = doc.objects.filter((o) => o.type === 'connector' && (o.fromId === target.id || o.toId === target.id)).length
  assert.ok(second <= 1 + touching, `${second} written for one move (${touching} connectors touch it)`)
})

test('a document the cache cannot vouch for (an object without an id) falls back to the plain writer', () => {
  forgetMedia()
  const doc = fromFabric(fixtures[0].content, fixtures[0].pageState)
  doc.objects[0] = { ...doc.objects[0], id: undefined }
  assert.equal(createDocumentEncoder().encode(doc), plain(doc))
})
