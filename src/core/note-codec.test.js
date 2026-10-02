import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { fabricPoints } from './document/oracle.js'
import { fromFabric, toJsonCanvas, validateJsonCanvas } from './document/index.js'
import { decodeNote, encodeNote, forgetMedia } from './note-codec.js'

const fixture = (name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../../tests/fixtures/documents/${name}.json`, import.meta.url)), 'utf8'))
const PNG = 'data:image/png;base64,iVBORw0KGgo='

function assertSamePlacement(before, after) {
  const a = fabricPoints(before.objects)
  const b = fabricPoints(after.objects)
  assert.equal(b.length, a.length)
  for (let i = 0; i < a.length; i += 1) assert.ok(Math.abs(a[i] - b[i]) <= 1e-6, `point ${i}`)
}

test('what the editor saves loads back as the same note (Fabric -> JSON Canvas -> Fabric)', async () => {
  forgetMedia()
  for (const name of ['app-text', 'app-all-tools', 'app-objects', 'ink-dots', 'edge-transforms', 'cli-appended']) {
    const { content, pageState } = fixture(name)
    const saved = JSON.parse(JSON.stringify(encodeNote(content, pageState)))
    // the transport form is valid except for the empty `file` of derived SVG pictures, which the server fills in
    assert.ok(validateJsonCanvas(saved).errors.every((error) => error.path.endsWith('.file')), name)
    const loaded = await decodeNote({ content: saved, contentFormat: 'json-canvas', pageState: saved.pn.page })
    assert.deepStrictEqual(loaded.pageState, pageState, name)
    assert.equal(loaded.content.objects.length, content.objects.length, name)
    assertSamePlacement(content, loaded.content)
    assert.deepStrictEqual(loaded.content.objects.map((o) => o.semanticId), content.objects.map((o) => o.semanticId), name)
  }
})

test('the save omits the SVG pictures the server derives, and sends no picture twice', async () => {
  forgetMedia()
  const { content, pageState } = fixture('app-all-tools')
  const saved = encodeNote(content, pageState)
  const svgNodes = saved.nodes.filter((n) => n.type === 'file' && n.pn.type !== 'image')
  assert.ok(svgNodes.length > 5)
  assert.ok(svgNodes.every((n) => n.file === ''))

  // a note whose picture lives in the media library: fetched once, then saved back as the same path
  const name = `${'a'.repeat(64)}.png`
  const canvas = toJsonCanvas(fromFabric({ objects: [{ type: 'Image', src: PNG, left: 50, top: 50, width: 10, height: 10, semanticId: 'res_p' }] }, { columns: 1, rows: 1 }), { media: { putDataUrl: () => `media/${name}` } })
  let fetches = 0
  const fetchMedia = async () => { fetches += 1; return PNG }
  const loaded = await decodeNote({ content: canvas }, { fetchMedia })
  assert.equal(loaded.content.objects[0].src, PNG)
  await decodeNote({ content: canvas }, { fetchMedia })
  assert.equal(fetches, 1)
  const again = encodeNote(loaded.content, loaded.pageState)
  assert.equal(again.nodes[0].file, `media/${name}`)
})

test('a picture that cannot be fetched still opens the note, and a note not yet converted loads as it is', async () => {
  forgetMedia()
  const canvas = toJsonCanvas(fromFabric({ objects: [{ type: 'Image', src: PNG, left: 50, top: 50, width: 10, height: 10, semanticId: 'res_p' }] }, { columns: 1, rows: 1 }), { media: { putDataUrl: () => `media/${'b'.repeat(64)}.png` } })
  const originalError = console.error
  console.error = () => {}
  try {
    const loaded = await decodeNote({ content: canvas }, { fetchMedia: async () => { throw new Error('gone') } })
    assert.match(loaded.content.objects[0].src, /^data:image\//)
  } finally {
    console.error = originalError
  }
  const old = fixture('app-text')
  const kept = await decodeNote({ content: old.content, contentFormat: 'fabric', pageState: old.pageState })
  assert.strictEqual(kept.content, old.content)
  assert.deepStrictEqual(kept.pageState, old.pageState)
})

test('an empty note loads; a canvas the server never canonicalized is refused instead of losing nodes', async () => {
  const empty = await decodeNote({ content: { nodes: [], edges: [], pn: { schemaVersion: 1, page: { columns: 1, rows: 1 } } } })
  assert.deepStrictEqual(empty.content.objects, [])
  await assert.rejects(decodeNote({ content: { nodes: [{ id: 'a', type: 'text', text: 'Hi', x: 0, y: 0, width: 100, height: 40 }], edges: [] } }), /not written by Personal Note/)
})
