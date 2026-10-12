import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { placedPoints } from './document/placement.js'
import { fromFabric, toJsonCanvas, validateJsonCanvas } from './document/index.js'
import { decodeNoteDocument, encodeDocument, forgetMedia } from './note-codec.js'

const fixture = (name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../../tests/fixtures/documents/${name}.json`, import.meta.url)), 'utf8'))
const PNG = 'data:image/png;base64,iVBORw0KGgo='
const viaJson = (value) => JSON.parse(JSON.stringify(value))
const picture = (extra = {}) => ({ type: 'Image', src: PNG, left: 50, top: 50, width: 10, height: 10, semanticId: 'res_p', ...extra })

test('what the editor saves opens as the same note (a legacy Fabric note -> model -> JSON Canvas -> model)', async () => {
  forgetMedia()
  for (const name of ['app-text', 'app-all-tools', 'app-objects', 'ink-dots', 'edge-transforms', 'cli-appended']) {
    const { content, pageState } = fixture(name)
    const doc = fromFabric(content, pageState)
    const saved = viaJson(encodeDocument(doc))
    // the transport form is valid except for the empty `file` of derived SVG pictures, which the server fills in
    assert.ok(validateJsonCanvas(saved).errors.every((error) => error.path.endsWith('.file')), name)
    const { doc: opened } = await decodeNoteDocument({ content: saved, contentFormat: 'json-canvas', pageState: saved.pn.page })
    assert.deepStrictEqual(opened.page, pageState, name)
    assert.equal(opened.objects.length, doc.objects.length, name)
    assert.deepStrictEqual(opened.objects.map((o) => o.id), doc.objects.map((o) => o.id), name)
    const before = placedPoints(doc.objects)
    const after = placedPoints(opened.objects)
    assert.equal(after.length, before.length, name)
    for (let i = 0; i < before.length; i += 1) assert.ok(Math.abs(before[i] - after[i]) <= 1, `${name}: point ${i}`) // JSON Canvas boxes are whole numbers
  }
})

test('the save omits the SVG pictures the server derives, and sends no picture twice', async () => {
  forgetMedia()
  const { content, pageState } = fixture('app-all-tools')
  const saved = encodeDocument(fromFabric(content, pageState))
  const svgNodes = saved.nodes.filter((n) => n.type === 'file' && n.pn.type !== 'image')
  assert.ok(svgNodes.length > 5)
  assert.ok(svgNodes.every((n) => n.file === ''))

  // a note whose picture lives in the media library: fetched once, then saved back as the same path
  const name = `${'a'.repeat(64)}.png`
  const canvas = toJsonCanvas(fromFabric({ objects: [picture()] }, { columns: 1, rows: 1 }), { media: { putDataUrl: () => `media/${name}` } })
  let fetches = 0
  const fetchMedia = async () => { fetches += 1; return PNG }
  const { doc, resolveMedia } = await decodeNoteDocument({ content: canvas }, { fetchMedia })
  assert.equal(resolveMedia(doc.objects[0].mediaRef), PNG)
  await decodeNoteDocument({ content: canvas }, { fetchMedia })
  assert.equal(fetches, 1)
  assert.equal(encodeDocument(doc).nodes[0].file, `media/${name}`)
})

test('a picture that cannot be fetched still opens the note, and its original reference goes back on save', async () => {
  forgetMedia()
  const canvas = toJsonCanvas(fromFabric({ objects: [picture()] }, { columns: 1, rows: 1 }), { media: { putDataUrl: () => `media/${'b'.repeat(64)}.png` } })
  const originalError = console.error
  console.error = () => {}
  try {
    const gone = async () => { throw new Error('gone') }
    const { doc, resolveMedia } = await decodeNoteDocument({ content: canvas }, { fetchMedia: gone })
    assert.match(resolveMedia(doc.objects[0].mediaRef), /^data:image\//)
    // opening can trigger a save: the original reference must go back, never the placeholder
    assert.equal(encodeDocument(doc).nodes[0].file, `media/${'b'.repeat(64)}.png`)
    // two different missing pictures keep their own references
    const two = toJsonCanvas(fromFabric({ objects: ['c', 'd'].map((c, i) => picture({ src: PNG + c, left: 10 + i * 50, top: 10, semanticId: `res_${c}` })) }, { columns: 1, rows: 1 }), { media: { putDataUrl: (url) => `media/${url.slice(-1).repeat(64)}.png` } })
    const both = await decodeNoteDocument({ content: two }, { fetchMedia: gone })
    assert.deepEqual(encodeDocument(both.doc).nodes.map((n) => n.file), [`media/${'c'.repeat(64)}.png`, `media/${'d'.repeat(64)}.png`])
  } finally {
    console.error = originalError
  }
})

test('a legacy Fabric-format note the server has not converted yet opens, and its first save converts it to JSON Canvas', async () => {
  forgetMedia()
  const old = fixture('app-all-tools')
  const { doc, resolveMedia } = await decodeNoteDocument({ content: old.content, contentFormat: 'fabric', pageState: old.pageState })
  assert.equal(resolveMedia, undefined)
  assert.equal(doc.objects.length, old.content.objects.length)
  assert.deepStrictEqual(doc.page, old.pageState)
  assert.ok(validateJsonCanvas(viaJson(encodeDocument(doc))).errors.every((error) => error.path.endsWith('.file')))
})

test('an empty note opens; a canvas the server never canonicalized is refused instead of losing nodes', async () => {
  const { doc } = await decodeNoteDocument({ content: { nodes: [], edges: [], pn: { schemaVersion: 1, page: { columns: 1, rows: 1 } } } })
  assert.deepStrictEqual(doc.objects, [])
  await assert.rejects(decodeNoteDocument({ content: { nodes: [{ id: 'a', type: 'text', text: 'Hi', x: 0, y: 0, width: 100, height: 40 }], edges: [] } }), /not written by Personal Note/)
})
