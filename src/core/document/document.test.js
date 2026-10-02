import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DocumentError,
  OBJECT_TYPES,
  SCHEMA_VERSION,
  emptyDocument,
  fromFabric,
  pageStateOf,
  paletteKeyFor,
  toFabric,
  validateDocument,
} from './index.js'

const FIXTURE_DIR = fileURLToPath(new URL('../../../tests/fixtures/documents/', import.meta.url))
const fixtures = fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort()
  .map((name) => JSON.parse(fs.readFileSync(`${FIXTURE_DIR}${name}`, 'utf8')))
const fixture = (name) => fixtures.find((entry) => entry.name === name)
const modelOf = (name) => { const { content, pageState } = fixture(name); return fromFabric(content, pageState) }
const byType = (doc, type) => doc.objects.filter((object) => object.type === type)

test('the fixture set covers every kind of note the app and its agents produce', () => {
  const names = fixtures.map((entry) => entry.name)
  for (const expected of ['app-text', 'app-objects', 'app-all-tools', 'ink-dots', 'edge-ids', 'edge-unknown', 'benchmark-600', 'cli-created', 'cli-appended']) {
    assert.ok(names.includes(expected), `missing fixture ${expected}`)
  }
})

for (const entry of fixtures) {
  test(`${entry.name}: toFabric(fromFabric(x)) deep-equals x, and the page state comes back`, () => {
    const doc = fromFabric(entry.content, entry.pageState)
    assert.deepStrictEqual(toFabric(doc), entry.content)
    assert.deepStrictEqual(pageStateOf(doc), entry.pageState)
  })

  test(`${entry.name}: the round trip survives being written to JSON and read back`, () => {
    const doc = JSON.parse(JSON.stringify(fromFabric(entry.content, entry.pageState)))
    assert.deepStrictEqual(toFabric(doc), entry.content)
  })
}

test('between them the fixtures use every document object type', () => {
  const seen = new Set()
  const visit = (objects) => objects.forEach((object) => { seen.add(object.type); if (object.children) visit(object.children) })
  fixtures.forEach((entry) => visit(fromFabric(entry.content, entry.pageState).objects))
  for (const type of OBJECT_TYPES) assert.ok(seen.has(type), `no fixture contains a ${type}`)
})

// Not every fixture has ids everywhere: the benchmark note was written by hand before ids were enforced, and edge-ids and edge-unknown are damaged on purpose.
const WITHOUT_IDS = new Set(['edge-ids', 'edge-unknown', 'benchmark-600'])

test('every note the app or the CLI saved is a valid document', () => {
  for (const entry of fixtures) {
    if (WITHOUT_IDS.has(entry.name)) continue
    const result = validateDocument(fromFabric(entry.content, entry.pageState))
    assert.deepEqual(result.errors, [], entry.name)
    assert.equal(result.ok, true)
  }
})

test('the notes without ids are valid apart from the ids', () => {
  for (const name of WITHOUT_IDS) {
    const doc = modelOf(name)
    assert.equal(validateDocument(doc).ok, false, name)
    assert.deepEqual(validateDocument(doc, { requireIds: false }).errors, [], name)
  }
})

test('a document carries its schema version and page state', () => {
  const doc = modelOf('benchmark-600')
  assert.equal(doc.schemaVersion, SCHEMA_VERSION)
  assert.deepEqual(doc.page, { columns: 3, rows: 4 })
  assert.equal(emptyDocument().schemaVersion, SCHEMA_VERSION)
  assert.deepEqual(emptyDocument().page, { columns: 1, rows: 1 })
  assert.deepEqual(emptyDocument().objects, [])
})

test('page state keys the app does not know are kept', () => {
  const doc = fromFabric({ version: '7.4.0', objects: [] }, { columns: 2, rows: 3, zoomHint: 1.5 })
  assert.equal(doc.page.columns, 2)
  assert.deepEqual(pageStateOf(doc), { columns: 2, rows: 3, zoomHint: 1.5 })
})

test('text, stickies and shapes carry their content, geometry and palette colours', () => {
  const doc = modelOf('app-objects')
  const [first] = byType(doc, 'text')
  assert.equal(first.mode, 'point')
  assert.equal(first.content, 'Meeting notes: ship the export')
  assert.equal(typeof first.id, 'string')
  assert.equal(first.geometry.x, fixture('app-objects').content.objects[0].left)

  const stickies = byType(doc, 'sticky')
  assert.equal(stickies.length, 2)
  assert.deepEqual(stickies.map((sticky) => [sticky.content, sticky.color, sticky.colorKey]), [['Buy paper', '#ffd60a', 'c1'], ['Purple note', '#bf5af2', 'c4']])
  assert.equal(stickies[0].style.fontFamily, 'Caveat')

  const [shape] = byType(doc, 'shape')
  assert.equal(shape.kind, 'rect')
  assert.equal(shape.cornerRadius, 28)
  assert.equal(shape.fill, '#ffd60a')
  assert.equal(shape.fillKey, 'c1')
})

test('palette keys exist only for colours that are in a skin palette', () => {
  assert.equal(paletteKeyFor('#30d158'), 'c2')
  assert.equal(paletteKeyFor('#9fe0c0'), 'c2')
  assert.equal(paletteKeyFor('#ff8fb1'), 'c5')
  assert.equal(paletteKeyFor('#123456'), null)
  assert.equal(paletteKeyFor(undefined), null)
})

test('the palette table matches the colours in skins.css', () => {
  const css = fs.readFileSync(fileURLToPath(new URL('../../skins.css', import.meta.url)), 'utf8')
  const hexes = [...css.matchAll(/--sk-c([1-5]):\s*(#[0-9a-f]{6})/g)].map((match) => [match[2], `c${match[1]}`])
  assert.equal(hexes.length, 15)
  for (const [hex, key] of hexes) assert.equal(paletteKeyFor(hex), key)
})

test('connectors keep their endpoints, direction flags and colour; arrowheads are the app default', () => {
  const doc = modelOf('app-objects')
  const [forward, backward] = byType(doc, 'connector')
  const ids = new Set(doc.objects.map((object) => object.id))
  for (const connector of [forward, backward]) {
    assert.ok(ids.has(connector.fromId) && ids.has(connector.toId))
    assert.equal(connector.color, '#20201e')
    assert.deepEqual(connector.arrowheads, { start: false, end: true })
  }
  assert.equal(forward.reverseX, false)
  assert.equal(backward.reverseX, true)
  assert.equal(backward.reverseY, true)
})

test('images reference their picture through an inline media reference', () => {
  const [image] = byType(modelOf('app-objects'), 'image')
  assert.equal(image.mediaRef.kind, 'inline')
  assert.match(image.mediaRef.dataUrl, /^data:image\/png;base64,/)
  assert.equal('src' in image, false)
})

test('a media-library reference needs a resolver to become a Fabric image, and then round-trips', () => {
  const doc = modelOf('app-objects')
  const dataUrl = byType(doc, 'image')[0].mediaRef.dataUrl
  const stored = structuredClone(doc)
  byType(stored, 'image')[0].mediaRef = { kind: 'media', id: 'med_123' }
  assert.equal(validateDocument(stored).ok, true)
  assert.throws(() => toFabric(stored), (error) => error instanceof DocumentError && /med_123/.test(error.message))
  const resolved = toFabric(stored, { resolveMedia: (ref) => (ref.id === 'med_123' ? dataUrl : null) })
  assert.deepStrictEqual(resolved, fixture('app-objects').content)
})

test('pen strokes keep their points, path, width and colour; highlighters split colour from alpha', () => {
  const doc = modelOf('app-all-tools')
  const strokes = byType(doc, 'ink').filter((ink) => ink.kind === 'stroke')
  const pen = strokes.filter((ink) => ink.tool === 'pen')
  const highlighter = strokes.filter((ink) => ink.tool === 'highlight')
  assert.ok(pen.length >= 2 && highlighter.length >= 1)
  assert.equal(pen[0].color, '#20201e')
  assert.equal(pen[0].alpha, undefined)
  assert.equal(pen[0].width, 3)
  assert.ok(Array.isArray(pen[0].points) && pen[0].points.length > 1)
  assert.deepEqual(Object.keys(pen[0].points[0]).sort(), ['x', 'y'])
  assert.ok(Array.isArray(pen[0].path))
  assert.equal(highlighter[0].color, '#20201e')
  assert.ok(Math.abs(highlighter[0].alpha - 0x55 / 255) < 1e-9)
  assert.equal(highlighter[0].width, 20)
  assert.ok(highlighter.every((ink) => ink.alpha !== undefined))
})

test('erased strokes stay as separate fragments, each with its own inkPoints', () => {
  const fragments = byType(modelOf('app-all-tools'), 'ink').filter((ink) => ink.kind === 'stroke' && ink.tool === 'pen')
  assert.ok(fragments.length >= 4, `expected the eraser to split two strokes, got ${fragments.length}`)
  for (const fragment of fragments) assert.ok(fragment.points.length >= 2)
})

test('ink dots are Circles with isInk and keep tool, radius, colour and alpha', () => {
  const dots = byType(modelOf('ink-dots'), 'ink')
  assert.deepEqual(dots.map((dot) => dot.kind), ['dot', 'dot', 'dot'])
  assert.deepEqual(dots.map((dot) => dot.tool), ['pen', 'highlight', 'pen'])
  assert.deepEqual(dots.map((dot) => dot.radius), [1.5, 10, 3])
  assert.equal(dots[1].color, '#20201e')
  assert.ok(Math.abs(dots[1].alpha - 0x55 / 255) < 1e-9)
  assert.equal(dots[2].color, '#d0021b')
})

test('a colour that is not hex-with-alpha is kept as it is, so nothing is rewritten', () => {
  for (const stroke of ['#20201E55', 'rgba(1,2,3,0.5)', 'red', '#223', '#2020aa']) {
    const content = { objects: [{ type: 'Path', isInk: true, path: [['M', 0, 0]], stroke, strokeWidth: 2, semanticId: 'a' }] }
    const doc = fromFabric(content)
    assert.deepStrictEqual(toFabric(doc), content, stroke)
  }
})

test('text written by the agent CLI is a Textbox and keeps its sparse shape', () => {
  const doc = modelOf('cli-created')
  const texts = byType(doc, 'text')
  assert.equal(texts.length, 3)
  assert.ok(texts.every((text) => text.mode === 'box'))
  assert.equal(texts[0].content, 'Keep a searchable local idea')
  assert.equal(texts[0].style.fontFamily, 'Source Serif 4')
  assert.equal(texts[0].style.padding, 8)
  assert.equal('fabricKeys' in texts[0], false)
  // The CLI never wrote strokeWidth, scale or origin; the model must not invent them.
  assert.equal(texts[0].geometry.scaleX, undefined)
  assert.equal(texts[0].geometry.originX, 'left')
})

test('the benchmark note keeps every object, in the same stacking order', () => {
  const doc = modelOf('benchmark-600')
  assert.equal(doc.objects.length, fixture('benchmark-600').content.objects.length)
  assert.deepEqual(doc.objects.map((object) => object.z), doc.objects.map((_, index) => index))
  assert.equal(byType(doc, 'ink').length, 240)
  assert.equal(byType(doc, 'text').length, 300)
  assert.equal(byType(doc, 'shape').length, 60)
  assert.equal(byType(doc, 'connector').length, fixture('benchmark-600').content.objects.filter((object) => object.type === 'Connector').length)
})

test('stacking order follows z, not array position', () => {
  const doc = modelOf('app-text')
  const [a, b] = doc.objects
  const swapped = { ...doc, objects: [{ ...a, z: 1 }, { ...b, z: 0 }] }
  const out = toFabric(swapped)
  assert.equal(out.objects[0].semanticId, b.id)
  assert.equal(out.objects[1].semanticId, a.id)
})

test('duplicate, missing and empty ids survive the round trip and are reported by validation', () => {
  const doc = modelOf('edge-ids')
  assert.deepStrictEqual(toFabric(doc), fixture('edge-ids').content)
  const { ok, errors } = validateDocument(doc)
  assert.equal(ok, false)
  const text = errors.map((error) => `${error.path}: ${error.message}`).join('\n')
  assert.match(text, /objects\[1\]\.id: duplicate id/)
  assert.match(text, /objects\[2\]\.id: missing id/)
  assert.match(text, /objects\[3\]\.id: empty id/)
  assert.equal(validateDocument(doc, { requireIds: false }).ok, true)
})

test('object types the model does not know are kept verbatim, never dropped', () => {
  const doc = modelOf('edge-unknown')
  const unknown = byType(doc, 'unknown')
  const original = fixture('edge-unknown').content.objects
  // Triangle, Ellipse, Line, the Path that is not ink, and four junk entries ('junk', null, 42, an untyped object).
  assert.deepEqual(unknown.map((entry) => (typeof entry.raw === 'object' && entry.raw ? entry.raw.type ?? 'untyped' : String(entry.raw))), ['Triangle', 'Ellipse', 'Line', 'Path', 'junk', 'null', '42', 'untyped'])
  for (const entry of unknown) assert.deepStrictEqual(entry.raw, original[entry.z])
  assert.equal(unknown[0].id, 'res_triangle_1')
  assert.equal(unknown[4].id, undefined)
})

test('an unknown field on a known object is preserved next to the typed fields', () => {
  const rect = byType(modelOf('edge-unknown'), 'shape').find((shape) => shape.id === 'res_custom_1')
  assert.deepStrictEqual(rect.extras.futureField, { kept: true, nested: [1, 2, 3] })
})

test('a Fabric group becomes a group of model objects', () => {
  const [group] = byType(modelOf('edge-unknown'), 'group')
  assert.equal(group.id, 'res_group_1')
  assert.deepEqual(group.children.map((child) => child.type), ['shape', 'text'])
  assert.equal(group.children[1].content, 'inside a group')
})

test('a plain Circle is a shape, not ink', () => {
  const circle = byType(modelOf('edge-unknown'), 'shape').find((shape) => shape.id === 'res_circle_1')
  assert.equal(circle.kind, 'circle')
  assert.equal(circle.radius, 30)
})

test('the model shares nothing with the Fabric JSON it came from', () => {
  const { content, pageState } = fixture('app-all-tools')
  const before = structuredClone(content)
  const doc = fromFabric(content, pageState)
  byType(doc, 'ink')[0].points[0].x = -999
  byType(doc, 'text')[0].extras.stroke = 'mutated'
  assert.deepStrictEqual(content, before)
  const out = toFabric(fromFabric(content, pageState))
  out.objects[0].left = -1
  assert.deepStrictEqual(content, before)
})

test('top-level Fabric keys other than objects are kept', () => {
  const content = { version: '7.4.0', objects: [], background: '#fff', clipPath: { type: 'Rect', width: 3 } }
  assert.deepStrictEqual(toFabric(fromFabric(content)), content)
  assert.deepStrictEqual(toFabric(fromFabric({ objects: [] })), { objects: [] })
})

test('content that is not an object, or has no objects array, becomes an empty document', () => {
  for (const content of [null, undefined, 'x', [], { objects: 'no' }]) {
    const doc = fromFabric(content)
    assert.deepEqual(doc.objects, [])
    assert.equal(validateDocument(doc).ok, true)
  }
})

test('validation names the path and the problem', () => {
  const doc = emptyDocument()
  doc.objects.push(
    { id: 'a', type: 'text', z: 0, geometry: { x: 'left' }, content: 5 },
    { id: 'b', type: 'sticky', z: 0, geometry: {}, content: 'x' },
    { id: 'c', type: 'shape', z: 2, geometry: {}, kind: 'blob' },
    { id: 'd', type: 'ink', z: 3, geometry: {}, kind: 'stroke', points: [{ x: 1 }] },
    { id: 'e', type: 'image', z: 4, geometry: {}, mediaRef: { kind: 'url' } },
    { id: 'f', type: 'connector', z: 5, geometry: {}, fromId: 'a' },
    { id: 'g', type: 'group', z: 6, geometry: {}, children: 'no' },
    { id: 'h', type: 'sparkle', z: 7 },
    { id: 'i', type: 'unknown', z: 8 },
  )
  doc.page.columns = 0
  const messages = validateDocument(doc).errors.map((error) => `${error.path}: ${error.message}`)
  const expected = [
    'page.columns: must be a whole number of at least 1',
    'objects[0].geometry.x: must be a finite number',
    'objects[0].content: must be a string',
    'objects[1].z: duplicate z (also used by objects[0])',
    'objects[1].color: sticky needs a colour',
    'objects[2].kind: must be one of rect, circle',
    'objects[3].points[0].y: must be a finite number',
    'objects[4].mediaRef.kind: must be inline or media',
    'objects[5].toId: connector needs a toId',
    'objects[6].children: must be an array',
    'objects[7].type: unknown object type "sparkle"',
    'objects[8].raw: unknown objects must keep their raw value',
  ]
  for (const line of expected) assert.ok(messages.includes(line), `missing: ${line}\n${messages.join('\n')}`)
})

test('validation rejects a document with the wrong schema version, and a non-document', () => {
  assert.match(validateDocument({ schemaVersion: 99, page: { columns: 1, rows: 1 }, objects: [] }).errors[0].message, /schemaVersion/)
  assert.equal(validateDocument(null).ok, false)
  assert.equal(validateDocument({ schemaVersion: 1, page: { columns: 1, rows: 1 }, objects: 'no' }).ok, false)
})

test('toFabric refuses an invalid document with a clear error', () => {
  assert.throws(() => toFabric({ schemaVersion: 1, page: { columns: 1, rows: 1 }, objects: [{ type: 'sparkle', z: 0 }] }), DocumentError)
})
