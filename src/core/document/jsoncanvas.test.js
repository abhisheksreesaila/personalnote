import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { COLUMNS, ROWS, generateNote } from '../../../scripts/benchmark-note.mjs'
import { placedPoints } from './placement.js'
import { fromFabric, fromJsonCanvas, isJsonCanvas, plainText, toJsonCanvas, validateJsonCanvas } from './index.js'

const FIXTURE_DIR = fileURLToPath(new URL('../../../tests/fixtures/documents/', import.meta.url))
const fixtures = [
  ...fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(fs.readFileSync(`${FIXTURE_DIR}${name}`, 'utf8'))),
  { name: 'benchmark-600', content: generateNote(), pageState: { columns: COLUMNS, rows: ROWS } },
]

// A store like the server's: content-addressed files, kept in memory.
function memoryStore() {
  const files = new Map()
  const put = (bytes, ext) => { const name = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`; files.set(name, bytes); return `media/${name}` }
  return {
    files,
    putText: (text, ext) => put(text, ext),
    putDataUrl: (url) => {
      const match = /^data:image\/(png|jpeg|webp|gif);base64,(.*)$/s.exec(url)
      return match ? put(Buffer.from(match[2], 'base64'), match[1] === 'jpeg' ? 'jpg' : match[1]) : url
    },
  }
}
const viaJson = (value) => JSON.parse(JSON.stringify(value))

function assertSameDocument(before, after, label) {
  assert.deepStrictEqual(after, before, label)
  const a = placedPoints(before.objects)
  const b = placedPoints(after.objects)
  assert.equal(b.length, a.length)
  for (let i = 0; i < a.length; i += 1) assert.ok(Math.abs(a[i] - b[i]) <= 1e-9, `${label}: point ${i}`)
}

for (const entry of fixtures) {
  test(`${entry.name}: doc -> JSON Canvas -> doc is the same document, and the canvas is valid JSON Canvas 1.0`, () => {
    const doc = fromFabric(entry.content, entry.pageState)
    const canvas = viaJson(toJsonCanvas(doc))
    const { ok, errors } = validateJsonCanvas(canvas)
    assert.ok(ok, JSON.stringify(errors.slice(0, 3)))
    assert.ok(isJsonCanvas(canvas))
    assertSameDocument(doc, fromJsonCanvas(canvas), entry.name)
  })

  test(`${entry.name}: with a media store pictures and SVGs become files and the round trip still holds`, () => {
    const doc = fromFabric(entry.content, entry.pageState)
    const store = memoryStore()
    const canvas = viaJson(toJsonCanvas(doc, { media: store }))
    assert.ok(validateJsonCanvas(canvas).ok)
    for (const node of canvas.nodes.filter((n) => n.type === 'file')) assert.match(node.file, /^media\/[0-9a-f]{64}\.(png|jpg|webp|gif|svg)$/, node.file)
    const back = fromJsonCanvas(canvas)
    // pictures now point at the library; everything else is identical
    const strip = (d) => ({ ...d, objects: d.objects.map((o) => (o.type === 'image' ? { ...o, mediaRef: null } : o)) })
    assertSameDocument(strip(doc), strip(back), entry.name)
    assert.equal(back.objects.length, doc.objects.length)
  })

  test(`${entry.name}: node order is the stacking order and JSON Canvas boxes are the nearest integers`, () => {
    const doc = fromFabric(entry.content, entry.pageState)
    const canvas = toJsonCanvas(doc)
    const placed = doc.objects.filter((o) => o.type !== 'connector' && o.type !== 'unknown')
    const nodes = canvas.nodes.filter((n) => n.pn.type !== 'unknown')
    assert.equal(nodes.length, placed.length)
    nodes.forEach((node, i) => {
      if (node.pn.origId === undefined && !node.pn.noId) assert.equal(node.id, placed[i].id)
      const g = placed[i].geometry
      assert.equal(node.x, Math.round(g.x))
      assert.equal(node.y, Math.round(g.y))
      if (g.width !== undefined) assert.equal(node.width, Math.max(1, Math.round(g.width)))
    })
  })
}

test('text and sticky text is the node text (Markdown), a sticky colour is the node colour, connectors are edges with sides and an arrow', () => {
  const doc = fromFabric(fixtures.find((f) => f.name === 'app-all-tools').content, { columns: 1, rows: 1 })
  const canvas = toJsonCanvas(doc)
  const text = canvas.nodes.find((n) => n.text === 'Meeting notes: ship the export')
  assert.equal(text.type, 'text')
  const sticky = canvas.nodes.find((n) => n.text === 'Buy paper')
  assert.match(sticky.color, /^#[0-9a-f]{6}$/)
  assert.ok(canvas.edges.length >= 2)
  for (const edge of canvas.edges) {
    assert.ok(['left', 'right', 'top', 'bottom'].includes(edge.fromSide) && ['left', 'right', 'top', 'bottom'].includes(edge.toSide))
    assert.equal(edge.toEnd, undefined, 'the default arrow at the end is not written')
  }
  assert.ok(canvas.nodes.some((n) => n.type === 'file' && n.file.startsWith('data:image/svg+xml')), 'ink and shapes get an SVG picture')
})

test('an edit made by another app wins: moved or retyped nodes, a recoloured sticky and a reversed arrow', () => {
  const doc = fromFabric(fixtures.find((f) => f.name === 'app-all-tools').content, { columns: 1, rows: 1 })
  const canvas = viaJson(toJsonCanvas(doc))
  const text = canvas.nodes.find((n) => n.type === 'text' && !n.color)
  const sticky = canvas.nodes.find((n) => n.color)
  text.text = 'Edited in Obsidian'
  text.x += 40
  sticky.color = '4'
  canvas.edges[0].toEnd = 'none'
  canvas.edges[0].fromEnd = 'arrow'
  const back = fromJsonCanvas(canvas)
  const o = back.objects.find((object) => object.id === text.id)
  assert.equal(o.content, 'Edited in Obsidian')
  assert.equal(o.geometry.x, text.x)
  assert.equal(o.geometry.rotation, 0)
  assert.equal(back.objects.find((object) => object.id === sticky.id).color, '#44cf6e')
  assert.deepStrictEqual(back.objects.find((object) => object.id === canvas.edges[0].id).arrowheads, { start: true, end: false })
  // the untouched nodes are exactly as they were
  const untouched = back.objects.find((object) => object.id === canvas.nodes.find((n) => n.type === 'file' && n.pn.type === 'ink').id)
  assert.deepStrictEqual(untouched, doc.objects.find((object) => object.id === untouched.id))
})

test('a canvas made by another app (no pn, negative coordinates, colours, files, links, groups) opens as a page-based note', () => {
  const canvas = {
    nodes: [
      { id: 'a', type: 'text', text: '# Heading\n- one', x: -300, y: -200, width: 250, height: 120 },
      { id: 'b', type: 'text', text: 'red card', x: 100, y: -200, width: 250, height: 120, color: '1' },
      { id: 'c', type: 'file', file: 'attachments/pic.png', x: 100, y: 100, width: 300, height: 200 },
      { id: 'd', type: 'file', file: 'docs/spec.pdf', x: 0, y: 400, width: 300, height: 100 },
      { id: 'e', type: 'link', url: 'https://example.com', x: 400, y: 400, width: 300, height: 100 },
      { id: 'f', type: 'group', label: 'Area', x: -400, y: -300, width: 900, height: 700 },
    ],
    edges: [{ id: 'g', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left' }],
  }
  assert.ok(validateJsonCanvas(canvas).ok)
  const doc = fromJsonCanvas(canvas)
  assert.ok(doc.objects.every((object) => object.type === 'connector' || object.geometry.x >= 0))
  assert.ok(doc.page.columns >= 1 && doc.page.rows >= 1)
  const byId = Object.fromEntries(doc.objects.map((o) => [o.id, o]))
  assert.equal(byId.a.type, 'text')
  assert.equal(byId.a.content, '# Heading\n- one')
  assert.equal(byId.b.type, 'sticky')
  assert.equal(byId.c.type, 'image')
  assert.deepStrictEqual(byId.c.mediaRef, { kind: 'media', id: 'attachments/pic.png' })
  assert.match(byId.d.content, /spec\.pdf/)
  assert.match(byId.e.content, /example\.com/)
  assert.equal(byId.f.type, 'shape')
  assert.equal(byId.g.type, 'connector')
  assert.ok(doc.objects.length >= 7)
  assert.ok(validateJsonCanvas(toJsonCanvas(doc)).ok)
})

test('a connector whose end is not in the note is kept, not written as an invalid edge', () => {
  const doc = fromFabric({ objects: [
    { type: 'Textbox', text: 'a', left: 10, top: 10, width: 100, height: 30, semanticId: 'res_a' },
    { type: 'Connector', fromId: 'res_a', toId: 'res_gone', semanticId: 'res_c', left: 0, top: 0, width: 5, height: 5 },
  ] }, { columns: 1, rows: 1 })
  const canvas = viaJson(toJsonCanvas(doc))
  assert.ok(validateJsonCanvas(canvas).ok)
  assert.equal(canvas.edges.length, 0)
  assertSameDocument(doc, fromJsonCanvas(canvas), 'detached')
})

test('a group keeps its children in pn and unknown objects survive', () => {
  const doc = fromFabric({ objects: [
    { type: 'Group', left: 300, top: 300, width: 200, height: 100, semanticId: 'res_g', objects: [{ type: 'Textbox', text: 'inside', left: -50, top: 0, width: 80, height: 20 }] },
    { type: 'Weird', left: 5, top: 6, foo: 'bar', text: 'kept' },
  ] }, { columns: 2, rows: 2 })
  const canvas = viaJson(toJsonCanvas(doc))
  assert.ok(validateJsonCanvas(canvas).ok)
  assert.equal(canvas.nodes[0].type, 'group')
  assertSameDocument(doc, fromJsonCanvas(canvas), 'group')
})

test('the Markdown projection reads text blocks by top edge and agrees with the document', () => {
  const doc = fromFabric({ objects: [
    { type: 'Textbox', text: 'second', left: 10, top: 200, width: 100, height: 30, originX: 'left', originY: 'top' },
    { type: 'Textbox', text: 'first', left: 400, top: 20, width: 100, height: 30, originX: 'left', originY: 'top' },
  ] }, { columns: 1, rows: 1 })
  assert.equal(plainText(doc), 'first\n\nsecond')
  assert.equal(plainText(fromJsonCanvas(toJsonCanvas(doc))), 'first\n\nsecond')
})

test('validateJsonCanvas rejects what the spec does not allow', () => {
  const bad = { nodes: [{ id: 'a', type: 'text', x: 1.5, y: 0, width: 10, height: 10 }, { id: 'a', type: 'file', x: 0, y: 0, width: 1, height: 1, file: '', color: 'red' }], edges: [{ id: 'e', fromNode: 'a', toNode: 'zz', fromSide: 'middle', toEnd: 'big' }] }
  const messages = validateJsonCanvas(bad).errors.map((e) => `${e.path}: ${e.message}`)
  for (const part of ['nodes[0].x: must be an integer', 'nodes[0].text', 'nodes[1].id: duplicate', 'nodes[1].file', 'nodes[1].color', 'edges[0].toNode: refers to unknown', 'edges[0].fromSide', 'edges[0].toEnd']) {
    assert.ok(messages.some((m) => m.includes(part)), `${part} in ${messages.join(' | ')}`)
  }
})
