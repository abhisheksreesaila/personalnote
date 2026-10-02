// Builds tests/fixtures/documents/*.json for the document model (F-025).
//
// App fixtures come from the real app: a headless Chromium drives it with real gestures (Vite on a random port, in-memory
// mocked /api, nothing touches a real database) and the note is read back with the app's own canvas.toJSON(), exactly what
// autosave would send. The seeded F-002 benchmark note and a few deliberately awkward notes (duplicate or missing ids, shapes
// the app never creates, a group) are added next to them. The CLI-appended note comes from scripts/generate_cli_fixture.py.
//
//   node scripts/generate-document-fixtures.mjs
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateNote, COLUMNS, ROWS } from './benchmark-note.mjs'

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
  await page.addInitScript(() => localStorage.setItem('personal-note:skin', 'crayon'))
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
  const pngPath = path.join(os.tmpdir(), 'f025-fixture.png')
  fs.writeFileSync(pngPath, Buffer.from(png, 'base64'))
  await page.setInputFiles('#image-file', pngPath)
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

  // Objects the app never makes, written by Fabric itself, plus a group and junk entries.
  // A throwaway module inside the project lets Vite resolve the bare `fabric` import for us.
  const lab = fileURLToPath(new URL('../src/__fabric-lab.js', import.meta.url))
  fs.writeFileSync(lab, "export * from 'fabric'\n")
  try { await page.evaluate(async () => { window.__fabricLab = await import('/src/__fabric-lab.js') }) } finally { fs.rmSync(lab, { force: true }) }
  const odd = await page.evaluate(() => {
    const f = window.__fabricLab
    const rect = new f.Rect({ left: 40, top: 40, width: 80, height: 50, fill: '#abcdef', rx: 4, ry: 4, angle: 15 })
    const label = new f.Textbox('inside a group', { left: 60, top: 100, width: 140, fontSize: 18 })
    const group = new f.Group([rect, label], { left: 700, top: 120 })
    group.semanticId = 'res_group_1'
    const triangle = new f.Triangle({ left: 300, top: 900, width: 90, height: 80, fill: '#ffcc00' })
    triangle.semanticId = 'res_triangle_1'
    const ellipse = new f.Ellipse({ left: 400, top: 900, rx: 60, ry: 30, fill: '#00ccaa' })
    ellipse.semanticId = 'res_ellipse_1'
    const dot = new f.Circle({ left: 520, top: 900, radius: 30, fill: '#33336655', stroke: '#222222', strokeWidth: 3 })
    dot.semanticId = 'res_circle_1'
    const line = new f.Line([10, 10, 200, 90], { stroke: '#cc0000' })
    line.semanticId = 'res_line_1'
    const custom = new f.Rect({ left: 5, top: 5, width: 10, height: 10 })
    custom.semanticId = 'res_custom_1'
    const json = [group, triangle, ellipse, dot, line, custom].map((o) => o.toObject(['semanticId']))
    json[5].futureField = { kept: true, nested: [1, 2, 3] }
    return json
  })
  // Ink dots (a tap with no stroke) are Circles built by main.js createInkDot; built here the same way.
  const dots = await page.evaluate(() => {
    const f = window.__fabricLab
    const make = (tool, x, y, width, fill, id) => {
      const dot = new f.Circle({ left: x - width / 2, top: y - width / 2, radius: width / 2, fill, selectable: false, evented: false })
      dot.isInk = true
      dot.inkTool = tool
      dot.semanticId = id
      return dot.toObject(['inkTool', 'isInk', 'semanticId'])
    }
    return [make('pen', 120, 140, 3, '#20201e', 'res_dot_pen'), make('highlight', 220, 140, 20, '#20201e55', 'res_dot_highlight'), make('pen', 320, 140, 6, '#d0021b', 'res_dot_red')]
  })
  write('ink-dots', 'Pen and highlighter dots (Circle with isInk), the way createInkDot saves them.', { version: '7.4.0', objects: dots }, { columns: 1, rows: 1 }, 'main.js createInkDot constructor arguments, Fabric toObject')
  const legacyPath = { type: 'Path', version: '7.4.0', semanticId: 'res_legacy_path', left: 80, top: 80, originX: 'left', originY: 'top', fill: null, stroke: '#223', strokeWidth: 2.5, path: [['M', 80, 80], ['L', 140, 120]] }
  const oddContent = { version: '7.4.0', objects: [...odd, legacyPath, 'junk', null, 42, { text: 'object without a type', left: 1, top: 2 }] }
  write('edge-unknown', 'Shapes the app never creates (group, triangle, ellipse, plain circle, line), a Path that is not ink, an object with an unknown field, and non-object junk.', oddContent, { columns: 1, rows: 1 }, 'Fabric classes in a headless browser, plus hand-added junk')
  await context.close()
}

write('benchmark-600', 'The seeded F-002 benchmark note: 300 text, 240 ink, 60 shapes, 50 connectors over 12 pages.', generateNote(), { columns: COLUMNS, rows: ROWS }, 'scripts/benchmark-note.mjs')

await browser.close()
await server.close()
