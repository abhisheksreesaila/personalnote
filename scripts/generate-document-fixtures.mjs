// Builds tests/fixtures/documents/*.json for the document model (F-025).
//
// App fixtures come from the real app: a headless Chromium drives it with real gestures (Vite on a random port, in-memory
// mocked /api, nothing touches a real database) and the note is read back with the app's own canvas.toJSON(), exactly what
// autosave would send. Deliberately awkward notes (duplicate or missing ids, shapes the app never creates, every kind of
// transform, nested groups) are built with Fabric's classes in Node. The CLI-appended notes come from scripts/generate_cli_fixture.py.
// The seeded F-002 benchmark note is not stored: tests build it from scripts/benchmark-note.mjs. Output is reproducible.
//
//   node scripts/generate-document-fixtures.mjs
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = fileURLToPath(new URL('../tests/fixtures/documents/', import.meta.url))
fs.mkdirSync(outDir, { recursive: true })
const write = (name, description, content, pageState, source) => {
  fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify({ name, description, source, pageState, content }, null, content.objects.length > 100 ? undefined : 1)}\n`)
  console.log(`wrote ${name} (${content.objects.length} objects)`)
}

const now = new Date().toISOString()
const summary = { id: 1, resourceId: 'res_note', revision: 1, noteType: 'canvas', title: 'Fixture', notebookId: 1, createdAt: now, updatedAt: now }
const notebooks = [{ id: 1, resourceId: 'res_nb', revision: 1, name: 'Fixtures', color: '#76669a', noteCount: 1 }]

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const baseUrl = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })

async function open(width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('page error:', error.message))
  // Ids are random in the app; a counter makes the fixtures reproducible.
  await page.addInitScript(() => {
    localStorage.setItem('personal-note:skin', 'crayon')
    let counter = 0
    crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
  })
  await page.route('**/api/**', async (route) => {
    const route_ = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (route_ === '/notebooks') return json(notebooks)
    if (route_ === '/notes') return json([summary])
    if (route_ === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, content: { version: '7.4.0', objects: [] }, pageState: { columns: 1, rows: 1 } })
    return json({ ...summary })
  })
  await page.goto(new URL('notes', baseUrl).href)
  await page.waitForFunction(() => window.__personalNote?.canvas && document.querySelector('.note-list-item.active'), null, { timeout: 30000 })
  await page.waitForTimeout(900)
  return { context, page }
}

const toClient = (page, x, y) => page.evaluate(([px, py]) => {
  const { canvas } = window.__personalNote
  const v = canvas.viewportTransform
  const r = canvas.upperCanvasEl.getBoundingClientRect()
  return { x: r.left + px * v[0] + v[4], y: r.top + py * v[3] + v[5] }
}, [x, y])
const click = async (page, x, y) => { const c = await toClient(page, x, y); await page.mouse.click(c.x, c.y); await page.waitForTimeout(300) }
const tool = (page, name) => page.evaluate((t) => window.__personalNote.setTool(t), name)
// snapshot() is what autosave sends: it gives every object its semanticId first, then canvas.toJSON().
const capture = (page) => page.evaluate(() => { const { content, pages } = JSON.parse(window.__personalNote.snapshot()); return { content, pageState: pages } })
async function stroke(page, points) {
  const first = await toClient(page, points[0][0], points[0][1])
  await page.mouse.move(first.x, first.y)
  await page.mouse.down()
  for (const [x, y] of points.slice(1)) { const c = await toClient(page, x, y); await page.mouse.move(c.x, c.y, { steps: 3 }) }
  await page.mouse.up()
  await page.waitForTimeout(250)
}
const wave = (x, y, count = 14, dx = 18) => Array.from({ length: count }, (_, i) => [x + i * dx, y + Math.sin(i / 2) * 26])

{
  const { context, page } = await open()
  // Stage 1: the text tool.
  await tool(page, 'text')
  await click(page, 200, 160)
  await page.keyboard.type('Meeting notes: ship the export')
  await page.keyboard.press('Escape')
  await tool(page, 'text')
  await click(page, 200, 300)
  await page.keyboard.type('Second block')
  await page.keyboard.press('Enter')
  await page.keyboard.type('with a second line')
  await page.keyboard.press('Escape')
  const text = await capture(page)
  write('app-text', 'Two text blocks made with the text tool, one with a line break.', text.content, text.pageState, 'real app, headless')

  // Stage 2: stickies, shape, connector, image.
  await page.click('[data-tool="sticky"]')
  await click(page, 200, 480)
  await page.keyboard.type('Buy paper')
  await page.keyboard.press('Escape')
  await page.click('[data-tool="shape"]')
  await click(page, 560, 520)
  await page.click('[data-tool="sticky"]')
  await page.click('[data-tool="sticky"]')
  await page.click('[data-object-color="3"]')
  await click(page, 540, 160)
  await page.keyboard.type('Purple note')
  await page.keyboard.press('Escape')
  await page.click('[data-tool="connect"]')
  const a = await toClient(page, 200, 480)
  const b = await toClient(page, 560, 520)
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up()
  await page.waitForTimeout(400)
  // A second arrow in the other diagonal direction (reverseX / reverseY).
  const c = await toClient(page, 540, 160)
  await page.mouse.move(b.x, b.y); await page.mouse.down(); await page.mouse.move(c.x, c.y, { steps: 6 }); await page.mouse.up()
  await page.waitForTimeout(400)
  const png = await page.evaluate(() => {
    const el = document.createElement('canvas'); el.width = 120; el.height = 60
    const x = el.getContext('2d'); x.fillStyle = '#e91e63'; x.fillRect(0, 0, 120, 60); x.fillStyle = '#fff'; x.fillRect(8, 8, 40, 20)
    return el.toDataURL('image/png').split(',')[1]
  })
  await page.setInputFiles('#image-file', { name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await page.waitForFunction(() => window.__personalNote.canvas.getObjects().some((o) => o.type === 'image'), null, { timeout: 5000 })
  const objects = await capture(page)
  write('app-objects', 'Text, two stickies (two palette colours), a rounded shape, two connectors (both diagonals) and a data-URL picture.', objects.content, objects.pageState, 'real app, headless')

  // Stage 3: pen, highlighter, dots, and the eraser splitting a stroke.
  await tool(page, 'pen')
  await stroke(page, wave(120, 700))
  await stroke(page, wave(120, 780, 10, 22))
  await tool(page, 'highlight')
  await stroke(page, wave(140, 860, 12, 24))
  await tool(page, 'pen')
  await click(page, 640, 700) // pen tap: ink dot
  await tool(page, 'highlight')
  await click(page, 700, 700) // highlighter tap: translucent dot
  await tool(page, 'eraser')
  const e1 = await toClient(page, 255, 700)
  await page.mouse.move(e1.x - 6, e1.y - 30); await page.mouse.down(); await page.mouse.move(e1.x + 6, e1.y + 40, { steps: 8 }); await page.mouse.up()
  await page.waitForTimeout(300)
  await tool(page, 'select')
  const all = await capture(page)
  write('app-all-tools', 'Everything the toolbar can make in one note: text, stickies, shape, connectors, image, pen, highlighter, ink dots and an erased (split) stroke.', all.content, all.pageState, 'real app, headless')

  // Derived: duplicate, missing and odd semanticIds on real objects.
  const damaged = JSON.parse(JSON.stringify(all.content))
  const [o0, o1, o2, o3] = damaged.objects
  o1.semanticId = o0.semanticId
  delete o2.semanticId
  o3.semanticId = ''
  const connector = damaged.objects.find((o) => o.type === 'Connector')
  if (connector) connector.fromId = o0.semanticId
  write('edge-ids', 'The all-tools note with a duplicated semanticId, a missing one, an empty one, and a connector pointing at the duplicate.', damaged, all.pageState, 'derived from app-all-tools')

  await context.close()
}

// Everything below is built with Fabric's own classes in Node (no browser): objects the app never makes, ink dots made the way
// main.js createInkDot makes them, and objects with every kind of transform.
const fabric = await import('fabric')
const withId = (object, id) => { object.semanticId = id; return object }
const json = (object) => object.toObject(['inkTool', 'isInk', 'semanticId'])

const dot = (tool, x, y, width, fill, id) => {
  const circle = new fabric.Circle({ left: x - width / 2, top: y - width / 2, radius: width / 2, fill, selectable: false, evented: false })
  circle.isInk = true
  circle.inkTool = tool
  return json(withId(circle, id))
}
write('ink-dots', 'Pen and highlighter dots (Circle with isInk), the way createInkDot saves them.', { version: '7.4.0', objects: [dot('pen', 120, 140, 3, '#20201e', 'res_dot_pen'), dot('highlight', 220, 140, 20, '#20201e55', 'res_dot_highlight'), dot('pen', 320, 140, 6, '#d0021b', 'res_dot_red')] }, { columns: 1, rows: 1 }, 'main.js createInkDot constructor arguments, Fabric toObject')

const group = withId(new fabric.Group([new fabric.Rect({ left: 40, top: 40, width: 80, height: 50, fill: '#abcdef', rx: 4, ry: 4, angle: 15 }), new fabric.Triangle({ left: 100, top: 20, width: 30, height: 30 })], { left: 700, top: 120 }), 'res_group_1')
const groupJson = json(group)
// Fabric's Textbox needs a DOM to measure; its saved shape is copied from a real note instead.
const appText = JSON.parse(fs.readFileSync(path.join(outDir, 'app-text.json'), 'utf8')).content.objects[0]
delete appText.semanticId
groupJson.objects.push({ ...appText, text: 'inside a group', left: 0, top: 30 })
const custom = json(withId(new fabric.Rect({ left: 5, top: 5, width: 10, height: 10 }), 'res_custom_1'))
custom.futureField = { kept: true, nested: [1, 2, 3] }
const legacyPath = { type: 'Path', version: '7.4.0', semanticId: 'res_legacy_path', left: 80, top: 80, originX: 'left', originY: 'top', fill: null, stroke: '#223', strokeWidth: 2.5, path: [['M', 80, 80], ['L', 140, 120]] }
write('edge-unknown', 'Shapes the app never creates (group, triangle, ellipse, plain circle, line), a Path that is not ink, an object with an unknown field, and non-object junk.', {
  version: '7.4.0',
  objects: [
    groupJson,
    json(withId(new fabric.Triangle({ left: 300, top: 900, width: 90, height: 80, fill: '#ffcc00' }), 'res_triangle_1')),
    json(withId(new fabric.Ellipse({ left: 400, top: 900, rx: 60, ry: 30, fill: '#00ccaa' }), 'res_ellipse_1')),
    json(withId(new fabric.Circle({ left: 520, top: 900, radius: 30, fill: '#33336655', stroke: '#222222', strokeWidth: 3 }), 'res_circle_1')),
    json(withId(new fabric.Line([10, 10, 200, 90], { stroke: '#cc0000' }), 'res_line_1')),
    custom, legacyPath, 'junk', null, 42, { text: 'object without a type', left: 1, top: 2 },
  ],
}, { columns: 1, rows: 1 }, 'Fabric classes in Node, plus hand-added junk')

// Transforms: every origin, rotation, scale, flip, skew and stroke setting Fabric offers, alone and inside nested groups.
const transform = (object, props, id) => withId(object.set(props), id)
const pathOf = (x, y) => [['M', x, y], ['Q', x + 30, y + 80, x + 70, y + 10], ['Q', x + 100, y - 50, x + 130, y + 40]]
const moved = [
  transform(new fabric.Rect({ left: 100, top: 100, width: 120, height: 70, fill: '#ffd60a', strokeWidth: 0, rx: 12, ry: 12 }), { angle: 30 }, 'res_rot'),
  transform(new fabric.Rect({ left: 300, top: 100, width: 120, height: 70, fill: '#30d158', stroke: '#111111', strokeWidth: 6 }), { scaleX: 1.8, scaleY: 0.6, originX: 'left', originY: 'top' }, 'res_scale_left_top'),
  transform(new fabric.Rect({ left: 600, top: 100, width: 120, height: 70, fill: '#64b5ff', stroke: '#111111', strokeWidth: 6, strokeUniform: true }), { scaleX: 2.2, angle: -20, originX: 'right', originY: 'bottom' }, 'res_uniform'),
  transform(new fabric.Rect({ left: 100, top: 400, width: 120, height: 70, fill: '#bf5af2', strokeWidth: 0 }), { flipX: true, flipY: true, angle: 200 }, 'res_flip'),
  transform(new fabric.Rect({ left: 300, top: 400, width: 120, height: 70, fill: '#ff6b3d', strokeWidth: 0 }), { skewX: 25, skewY: -10, angle: 40 }, 'res_skew'),
  transform(new fabric.Circle({ left: 600, top: 400, radius: 30, fill: '#33336655' }), { angle: 90, scaleX: 2, opacity: 0.5, visible: true }, 'res_circle_scaled'),
  transform(new fabric.Rect({ left: 100, top: 700, width: 90, height: 60, fill: '#ffffff', strokeWidth: 0, shadow: new fabric.Shadow({ color: 'rgba(0,0,0,0.3)', blur: 12, offsetX: 3, offsetY: 6 }) }), { opacity: 0.8 }, 'res_shadow'),
]
const ink = (x, y, props, id) => {
  const stroke = new fabric.Path(pathOf(x, y), { fill: null, stroke: '#20201e', strokeWidth: 3, strokeLineCap: 'round', strokeLineJoin: 'round' })
  stroke.isInk = true
  stroke.inkTool = 'pen'
  stroke.inkPoints = [{ x, y }, { x: x + 70, y: y + 10 }, { x: x + 130, y: y + 40 }]
  return withId(stroke.set(props), id)
}
const inner = withId(new fabric.Group([
  transform(new fabric.Rect({ left: -30, top: -20, width: 60, height: 40, fill: '#ffd60a', strokeWidth: 0 }), { angle: 10 }, 'res_inner_rect'),
  ink(0, 0, { scaleX: 0.8, angle: 15 }, 'res_inner_ink'),
], { left: 900, top: 700, angle: 25, scaleX: 1.2, originX: 'left', originY: 'top' }), 'res_inner')
const outer = withId(new fabric.Group([inner, new fabric.Rect({ left: 40, top: 30, width: 50, height: 50, fill: '#30d158', strokeWidth: 0 })], { left: 500, top: 800, angle: -15, skewX: 10, flipX: true }), 'res_outer')
write('edge-transforms', 'Objects with every origin, rotation, scale, flip, skew and stroke setting, ink moved off its drawn position, a shadow, and a group nested in a group.', {
  version: '7.4.0',
  objects: [...moved, ink(120, 900, { angle: 35, scaleX: 1.4, flipY: true }, 'res_ink_rot'), ink(400, 900, { originX: 'left', originY: 'top', left: 800, top: 300 }, 'res_ink_moved'), outer].map(json),
}, { columns: 2, rows: 2 }, 'Fabric classes in Node')

await browser.close()
await server.close()
