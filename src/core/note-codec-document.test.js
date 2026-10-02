// F-028: the Leafer editor reads the stored note straight into the document model (no Fabric JSON in between), so a field the
// model has and Fabric does not (`locked`) survives open, edit and save.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { fromFabric } from './document/legacy-fabric.js'
import { compactStacking, planOperation, applyChanges } from './document/operations.js'
import { decodeNoteDocument, encodeDocument, forgetMedia } from './note-codec.js'

const fixture = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../tests/fixtures/documents/app-all-tools.json', import.meta.url)), 'utf8'))
const PNG = 'data:image/png;base64,iVBORw0KGgo='
const viaJson = (value) => JSON.parse(JSON.stringify(value))

test('a locked object survives save, open and save again', async () => {
  forgetMedia()
  let doc = fromFabric(fixture.content, fixture.pageState)
  const target = doc.objects.find((object) => object.type === 'sticky')
  doc = applyChanges(doc, planOperation(doc, { type: 'lock', ids: [target.id], locked: true }).op)
  const saved = viaJson(encodeDocument(compactStacking(doc)))
  const opened = await decodeNoteDocument({ content: saved, pageState: saved.pn.page })
  assert.equal(opened.doc.objects.find((object) => object.id === target.id).locked, true)
  assert.deepEqual(opened.doc.page, doc.page)
  const again = viaJson(encodeDocument(compactStacking(opened.doc)))
  assert.equal(again.nodes.find((node) => node.id === target.id).pn.locked, true)
})

test('a library picture opens as a media reference with a way to show it, and saves back as the same path', async () => {
  forgetMedia()
  const name = `${'b'.repeat(64)}.png`
  const canvas = viaJson(encodeDocument({ schemaVersion: 1, page: { columns: 1, rows: 1 }, extras: {}, objects: [{ id: 'res_p', type: 'image', z: 0, mediaRef: { kind: 'media', id: name }, geometry: { x: 5, y: 5, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 } }] }))
  let fetches = 0
  const fetchMedia = async () => { fetches += 1; return PNG }
  const { doc, resolveMedia } = await decodeNoteDocument({ content: canvas }, { fetchMedia })
  assert.deepEqual(doc.objects[0].mediaRef, { kind: 'media', id: name })
  assert.equal(resolveMedia(doc.objects[0].mediaRef), PNG)
  assert.equal(viaJson(encodeDocument(doc)).nodes[0].file, `media/${name}`)
  await decodeNoteDocument({ content: canvas }, { fetchMedia })
  assert.equal(fetches, 1)
})

test('a picture that cannot be fetched shows a placeholder, and a note the server has not converted opens through Fabric JSON', async () => {
  forgetMedia()
  const name = `${'c'.repeat(64)}.png`
  const canvas = viaJson(encodeDocument({ schemaVersion: 1, page: { columns: 1, rows: 1 }, extras: {}, objects: [{ id: 'res_q', type: 'image', z: 0, mediaRef: { kind: 'media', id: name }, geometry: { x: 5, y: 5, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 } }] }))
  const { doc, resolveMedia } = await decodeNoteDocument({ content: canvas }, { fetchMedia: async () => { throw new Error('offline') } })
  assert.ok(resolveMedia(doc.objects[0].mediaRef).startsWith('data:image/svg+xml'))
  const legacy = await decodeNoteDocument({ content: fixture.content, pageState: fixture.pageState })
  assert.equal(legacy.doc.objects.length, fixture.content.objects.length)
  assert.deepEqual(legacy.doc.page, fixture.pageState)
})

test('a canvas the server never canonicalized is refused instead of losing nodes', async () => {
  await assert.rejects(decodeNoteDocument({ content: { nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'x' }], edges: [] } }), /not written by Personal Note/)
})
