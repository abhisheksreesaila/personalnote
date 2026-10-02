import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { COLUMNS, ROWS, generateNote } from '../../../scripts/benchmark-note.mjs'
import { fabricPoints, modelPoints, withoutPlacement } from './oracle.js'
import { placedPoints } from './placement.js'
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
// The seeded F-002 benchmark note is built here, not stored: it is 2.4 MB of generated numbers.
const fixtures = [
  ...fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(fs.readFileSync(`${FIXTURE_DIR}${name}`, 'utf8'))),
  { name: 'benchmark-600', content: generateNote(), pageState: { columns: COLUMNS, rows: ROWS } },
]
const fixture = (name) => fixtures.find((entry) => entry.name === name)
const modelOf = (name) => { const { content, pageState } = fixture(name); return fromFabric(content, pageState) }
const byType = (doc, type) => doc.objects.filter((object) => object.type === type)

test('the fixture set covers every kind of note the app and its agents produce', () => {
  const names = fixtures.map((entry) => entry.name)
  for (const expected of ['app-text', 'app-objects', 'app-all-tools', 'ink-dots', 'edge-ids', 'edge-unknown', 'edge-transforms', 'benchmark-600', 'cli-created', 'cli-appended']) {
    assert.ok(names.includes(expected), `missing fixture ${expected}`)
  }
})

// Exact equality is kept for everything that is not placement; placement is checked by where the points land, with Fabric's own matrices.
function assertRenderEquivalent(before, after, label) {
  assert.deepStrictEqual(withoutPlacement(after), withoutPlacement(before), `${label}: non-placement properties`)
  const a = fabricPoints(before.objects)
  const b = fabricPoints(after.objects)
  assert.equal(b.length, a.length, `${label}: number of placed points`)
  for (let i = 0; i < a.length; i += 1) assert.ok(Math.abs(a[i] - b[i]) <= 1e-6, `${label}: point ${i}: ${a[i]} vs ${b[i]}`)
}

for (const entry of fixtures) {
  test(`${entry.name}: toFabric(fromFabric(x)) is render-equivalent to x, and the page state comes back`, () => {
    const doc = fromFabric(entry.content, entry.pageState)
    assertRenderEquivalent(entry.content, toFabric(doc), entry.name)
    assert.deepStrictEqual(pageStateOf(doc), entry.pageState)
  })

  test(`${entry.name}: the model alone puts every box corner and ink point where Fabric does`, () => {
    const doc = fromFabric(entry.content, entry.pageState)
    const expected = fabricPoints(entry.content.objects)
    const actual = modelPoints(doc.objects)
    assert.equal(actual.length, expected.length)
    for (let i = 0; i < expected.length; i += 1) assert.ok(Math.abs(actual[i] - expected[i]) <= 1e-6, `point ${i}: ${actual[i]} vs ${expected[i]}`)
  })

  test(`${entry.name}: the round trip survives being written to JSON and read back`, () => {
    const doc = JSON.parse(JSON.stringify(fromFabric(entry.content, entry.pageState)))
    assertRenderEquivalent(entry.content, toFabric(doc), entry.name)
  })

  test(`${entry.name}: converting twice changes nothing more (the Fabric form is a fixed point)`, () => {
    const once = toFabric(fromFabric(entry.content, entry.pageState))
    const twice = toFabric(fromFabric(once, entry.pageState))
    assertRenderEquivalent(once, twice, entry.name)
  })
}

// Objects with every kind of transform, in every origin, nested in groups: the cases fixtures made by the app never reach.
const placements = [
  { angle: 30 }, { angle: -90, originX: 'left', originY: 'top' }, { scaleX: 1.5, scaleY: 0.7, originX: 'right', originY: 'bottom' },
  { flipX: true, angle: 12 }, { flipY: true, scaleX: 2 }, { skewX: 20, skewY: -10, angle: 45 }, { strokeWidth: 6, strokeUniform: true, scaleX: 2.5, angle: 20 },
  { strokeWidth: 6, scaleX: 2.5, scaleY: 0.5, originX: 'center', originY: 'top' }, { angle: 180, flipX: true, flipY: true, skewX: -15 },
]
function mutationNote() {
  const base = (type, extra, index) => ({ type, left: 200 + index * 37, top: 150 + index * 23, width: 120, height: 70, semanticId: `res_${type}_${index}`, ...extra })
  const path = [['M', 400, 300], ['Q', 430, 380, 470, 310], ['Q', 500, 250, 520, 330]]
  const kinds = [
    (index, extra) => base('Rect', { rx: 8, ry: 8, fill: '#abcdef', stroke: '#112233', ...extra }, index),
    (index, extra) => base('Textbox', { text: `text ${index}`, fontSize: 20, ...extra }, index),
    (index, extra) => base('Sticky', { text: `sticky ${index}`, stickyColor: '#ffd60a', ...extra }, index),
    (index, extra) => base('Circle', { radius: 35, width: 70, height: 70, isInk: index % 2 === 0, fill: '#33336655', ...extra }, index),
    (index, extra) => base('Image', { src: 'data:image/png;base64,AAAA', ...extra }, index),
    (index, extra) => base('Connector', { fromId: 'a', toId: 'b', reverseX: index % 2 === 0, ...extra }, index),
    (index, extra) => base('Path', { path, isInk: true, stroke: '#20201e', strokeWidth: 3, inkPoints: [{ x: 400, y: 300 }, { x: 470, y: 310 }], ...extra, width: 120, height: 70 }, index),
  ]
  const objects = []
  placements.forEach((extra, i) => kinds.forEach((make, k) => objects.push(make(i * kinds.length + k, extra))))
  const inner = { type: 'Group', semanticId: 'res_inner', left: 30, top: -20, width: 200, height: 120, angle: 25, scaleX: 1.2, objects: [make(kinds[0], 0, { angle: 10, left: -50, top: -20 }), make(kinds[kinds.length - 1], 1, { scaleX: 0.8, left: 40, top: 10 })] }
  const outer = { type: 'Group', semanticId: 'res_outer', left: 700, top: 500, width: 400, height: 300, angle: -15, skewX: 10, flipX: true, originX: 'left', originY: 'top', objects: [inner, make(kinds[1], 2, { left: 100, top: 90 })] }
  objects.push(outer)
  return { version: '7.4.0', objects }
  function make(factory, index, extra) { return factory(index, extra) }
}

test('rotation, scale, flips, skew, stroke, every origin and nested groups all land in the same place after the round trip', () => {
  const content = mutationNote()
  const doc = fromFabric(content, { columns: 3, rows: 3 })
  assertRenderEquivalent(content, toFabric(doc), 'mutation set')
  const expected = fabricPoints(content.objects)
  const actual = modelPoints(doc.objects)
  assert.ok(expected.length > 300)
  assert.equal(actual.length, expected.length)
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= 1e-6, `point ${i}: ${value} vs ${expected[i]}`))
  assert.equal(doc.objects.filter((object) => object.type === 'unknown').length, 0)
})

test('geometry is origin-free, with typed rotation, scale, flip and skew', () => {
  const doc = fromFabric({ objects: [
    { type: 'Rect', left: 100, top: 50, width: 40, height: 20, originX: 'center', originY: 'center', strokeWidth: 0, angle: 30, scaleX: 2, flipX: true, skewY: 5, semanticId: 'a' },
    { type: 'Rect', left: 100, top: 50, width: 40, height: 20, originX: 'left', originY: 'top', strokeWidth: 0, semanticId: 'b' },
  ] })
  const [centered, corner] = doc.objects.map((object) => object.geometry)
  assert.deepEqual([centered.x, centered.y, centered.width, centered.height], [80, 40, 40, 20])
  assert.deepEqual([centered.rotation, centered.scaleX, centered.scaleY, centered.flipX, centered.flipY, centered.skewX, centered.skewY], [30, 2, 1, true, false, 0, 5])
  assert.deepEqual([corner.x, corner.y], [100, 50])
  assert.equal('originX' in centered, false)
})

test('opacity, visibility, strokeUniform and a simple shadow are typed fields', () => {
  const content = { objects: [{ type: 'Rect', semanticId: 'a', opacity: 0.5, visible: false, strokeUniform: true, shadow: { color: 'rgba(0,0,0,.3)', blur: 8, offsetX: 2, offsetY: 4, affectStroke: false, nonScaling: false } }] }
  const [rect] = fromFabric(content).objects
  assert.equal(rect.opacity, 0.5)
  assert.equal(rect.visible, false)
  assert.equal(rect.strokeUniform, true)
  assert.deepEqual(rect.shadow, { color: 'rgba(0,0,0,.3)', blur: 8, x: 2, y: 4, extras: { affectStroke: false, nonScaling: false } })
  const out = toFabric(fromFabric(content)).objects[0]
  assert.deepEqual(out.shadow, content.objects[0].shadow)
  assert.equal(out.visible, false)
  assert.equal(out.strokeUniform, true)
})

test('ink points and path are relative to the box top-left, whatever Fabric did to the path since', () => {
  const content = { objects: [{ type: 'Path', isInk: true, semanticId: 'a', left: 500, top: 400, originX: 'center', originY: 'center', strokeWidth: 3, stroke: '#000', path: [['M', 100, 100], ['L', 160, 130]], inkPoints: [{ x: 100, y: 100 }, { x: 160, y: 130 }] }] }
  const [ink] = fromFabric(content).objects
  assert.deepEqual(ink.path, [['M', 0, 0], ['L', 60, 30]])
  assert.deepEqual(ink.points, [{ x: 0, y: 0 }, { x: 60, y: 30 }])
  assert.deepEqual([ink.geometry.width, ink.geometry.height], [60, 30])
  assert.deepEqual([ink.geometry.x, ink.geometry.y], [470, 385])
})

test('an object whose placement is malformed is kept verbatim as unknown', () => {
  const content = { objects: [{ type: 'Textbox', text: 'x', top: '300', left: 5 }, { type: 'Rect', angle: 'turn' }, { type: 'Path', isInk: true, path: [['A', 1, 1, 0, 0, 0, 5, 5]] }] }
  const doc = fromFabric(content)
  assert.deepEqual(doc.objects.map((object) => object.type), ['unknown', 'unknown', 'unknown'])
  assert.deepStrictEqual(toFabric(doc), content)
})

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
  const original = fixture('app-objects').content.objects[0]
  assert.equal(original.originX, 'center')
  assert.equal(first.geometry.x, original.left - original.width / 2)
  assert.equal(first.geometry.y, original.top - original.height / 2)

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
    assert.deepStrictEqual(withoutPlacement(toFabric(doc)), withoutPlacement(content), stroke)
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
  // The CLI never wrote a height (the engine measures it) or an origin other than top-left; the model does not invent a height.
  assert.equal(texts[0].geometry.height, undefined)
  assert.equal(texts[0].geometry.scaleX, 1)
  assert.equal(texts[0].geometry.x, 72.5)
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
  assertRenderEquivalent(fixture('edge-ids').content, toFabric(doc), 'edge-ids')
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
  assert.deepEqual(group.children.map((child) => child.type), ['shape', 'unknown', 'text'])
  assert.equal(group.children[2].content, 'inside a group')
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

test('the placement check really notices a moved, rotated or rescaled object', () => {
  const content = fixture('app-all-tools').content
  for (const change of [(g) => { g.x += 0.01 }, (g) => { g.rotation += 1 }, (g) => { g.scaleY *= 1.001 }, (g) => { g.flipX = !g.flipX }]) {
    const doc = fromFabric(content, { columns: 1, rows: 1 })
    change(doc.objects[3].geometry)
    assert.throws(() => assertRenderEquivalent(content, toFabric(doc), 'changed'))
  }
})

// The documented formula (schema.js), written without Fabric or its matrix helpers, must put every point where Fabric puts it.
test('the documented transform order places every fixture and every mutation like Fabric does', () => {
  const notes = [...fixtures.map((entry) => [entry.name, entry.content, entry.pageState]), ['mutation set', mutationNote(), { columns: 3, rows: 3 }]]
  for (const [name, content, pageState] of notes) {
    const expected = fabricPoints(content.objects)
    const actual = placedPoints(fromFabric(content, pageState).objects)
    assert.equal(actual.length, expected.length, name)
    for (let i = 0; i < expected.length; i += 1) assert.ok(Math.abs(actual[i] - expected[i]) <= 1e-6, `${name}: point ${i}: ${actual[i]} vs ${expected[i]}`)
  }
})

test('skew order matters: SkewY acts first, so swapping the two skews would move the points', () => {
  const doc = fromFabric({ objects: [{ type: 'Rect', semanticId: 'a', left: 100, top: 100, width: 80, height: 50, strokeWidth: 0, skewX: 30, skewY: 20, angle: 10 }] })
  const expected = fabricPoints([{ type: 'Rect', left: 100, top: 100, width: 80, height: 50, strokeWidth: 0, skewX: 30, skewY: 20, angle: 10 }])
  const swapped = structuredClone(doc)
  swapped.objects[0].geometry.skewX = 20
  swapped.objects[0].geometry.skewY = 30
  assert.ok(placedPoints(doc.objects).every((value, i) => Math.abs(value - expected[i]) <= 1e-6))
  assert.ok(placedPoints(swapped.objects).some((value, i) => Math.abs(value - expected[i]) > 1))
})

test('a Group, a picture and a connector default to no stroke, everything else to 1, as Fabric does', () => {
  // The placement oracle takes these defaults from the real classes, so a wrong default would move the points in the mutation set.
  const bare = (type, extra = {}) => ({ type, semanticId: type, left: 50, top: 60, width: 100, height: 40, originX: 'left', originY: 'top', ...extra })
  const doc = fromFabric({ objects: [bare('Group', { objects: [] }), bare('Image', { src: 'data:,' }), bare('Connector'), bare('Rect'), bare('Textbox', { text: 'x' })] })
  assert.deepEqual(doc.objects.map((object) => object.geometry.x), [50, 50, 50, 50.5, 50.5])
})
