// Drives the real app (Vite dev server, in-memory mocked /api) through the connector
// acceptance checks and saves screenshots.  node scripts/verify-connectors.mjs <shotsDir>
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'

const shots = process.argv[2] || '/tmp/shots-f005'
fs.mkdirSync(shots, { recursive: true })
const rect = (id, left, top, w, h, fill, stroke) => ({ type: 'Rect', version: '7.4.0', semanticId: id, originX: 'left', originY: 'top', left, top, width: w, height: h, fill, stroke, strokeWidth: 2, rx: 8, ry: 8 })
const text = (id, left, top, t) => ({ type: 'IText', version: '7.4.0', semanticId: id, originX: 'left', originY: 'top', left, top, text: t, fontSize: 24, fontFamily: 'Source Serif 4', fill: '#222', lineHeight: 1.45, padding: 8 })
let stored = { version: '7.4.0', objects: [
  rect('res_a', 80, 120, 200, 110, 'rgba(255,200,120,.45)', '#b07a2a'),
  rect('res_b', 520, 140, 200, 110, 'rgba(140,200,255,.45)', '#2a6fb0'),
  text('res_c', 300, 520, 'Launch checklist'),
  rect('res_d', 60, 700, 180, 90, 'rgba(180,230,160,.5)', '#3a8a3a'),
] }
let pageState = { columns: 1, rows: 1 }
let revision = 1
const now = new Date().toISOString()
const summary = () => ({ id: 1, resourceId: 'res_note', revision, noteType: 'canvas', title: 'Connector note', notebookId: 1, createdAt: now, updatedAt: now })
const notebooks = [{ id: 1, resourceId: 'res_nb', revision: 1, name: 'Bench', color: '#76669a', noteCount: 1 }]

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const baseUrl = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`) }

async function open(width, height) {
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('page error:', error.message))
  page.on('console', (m) => { if (m.type() === 'error') console.error('console error:', m.text()) })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api/, '')
    const method = route.request().method()
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/notebooks') return json(notebooks)
    if (path === '/notes') return json([summary()])
    if (path === '/notes/1' && method === 'GET') return json({ ...summary(), content: stored, pageState })
    if (path === '/notes/1' && method === 'PUT') {
      const body = JSON.parse(route.request().postData())
      stored = body.content; pageState = body.pageState; revision += 1
      return json({ ...summary() })
    }
    return json({})
  })
  await page.goto(new URL('notes', baseUrl).href)
  await page.waitForFunction(() => window.__personalNote?.canvas.getObjects().length > 0, null, { timeout: 30000 })
  await page.waitForTimeout(700)
  return { context, page }
}

const clientOf = (page, id) => page.evaluate((i) => {
  const { canvas } = window.__personalNote
  const o = canvas.getObjects().find((x) => x.semanticId === i)
  const c = o.getCenterPoint(); const v = canvas.viewportTransform
  const r = canvas.upperCanvasEl.getBoundingClientRect()
  return { x: r.left + c.x * v[0] + v[4], y: r.top + c.y * v[3] + v[5] }
}, id)
const connectors = (page) => page.evaluate(() => window.__personalNote.canvas.getObjects().filter((o) => o.type === 'Connector' || o.type === 'connector').map((c) => ({ from: c.fromId, to: c.toId, visible: c.visible, ...c.endpoints() })))
const tool = (page, t) => page.evaluate((x) => window.__personalNote.setTool(x), t)

{
  const { context, page } = await open(1440, 900)
  await tool(page, 'connect')
  const a = await clientOf(page, 'res_a'); const b = await clientOf(page, 'res_b'); const c = await clientOf(page, 'res_c')
  // hover highlight
  await page.mouse.move(a.x, a.y)
  await page.waitForTimeout(100)
  await page.screenshot({ path: `${shots}/1-hover-source.png` })
  // draw a -> b, with mid-drag screenshot
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 })
  await page.mouse.move(b.x, b.y, { steps: 5 })
  await page.waitForTimeout(100)
  await page.screenshot({ path: `${shots}/2-dragging-to-target.png` })
  await page.mouse.up()
  let list = await connectors(page)
  check('connector a->b created', list.length === 1 && list[0].from === 'res_a' && list[0].to === 'res_b', JSON.stringify(list))
  // empty space cancels
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(800, 600, { steps: 4 }); await page.mouse.up()
  check('release on empty space cancels', (await connectors(page)).length === 1)
  // Esc cancels
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(c.x, c.y, { steps: 4 })
  await page.keyboard.press('Escape'); await page.mouse.up()
  check('Esc cancels and stays on connect tool', (await connectors(page)).length === 1 && await page.evaluate(() => window.__personalNote.state.tool) === 'connect')
  // second connector c -> b
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up()
  check('second connector', (await connectors(page)).length === 2)
  await page.screenshot({ path: `${shots}/3-two-connectors.png` })

  // drag b live; connectors must follow each frame
  await tool(page, 'select')
  const before = await connectors(page)
  await page.mouse.move(b.x, b.y); await page.mouse.down()
  for (let i = 1; i <= 10; i += 1) await page.mouse.move(b.x + i * 10, b.y + i * 14)
  const during = await connectors(page)
  check('connector end follows during drag', Math.abs(during[0].end.x - before[0].end.x) > 20, `${before[0].end.x.toFixed(0)} -> ${during[0].end.x.toFixed(0)}`)
  const untouched = await page.evaluate(() => 0)
  void untouched
  await page.screenshot({ path: `${shots}/4-drag-live.png` })
  await page.mouse.up()
  await page.waitForTimeout(400)

  // scale and rotate b through the API, firing events like Fabric does
  const scaled = await page.evaluate(() => {
    const { canvas } = window.__personalNote
    const o = canvas.getObjects().find((x) => x.semanticId === 'res_b')
    const c = canvas.getObjects().find((x) => x.type === 'Connector' || x.type === 'connector')
    const before = JSON.stringify(c.endpoints())
    o.set({ scaleX: 2, scaleY: 2, angle: 30 }); o.setCoords(); canvas.fire('object:scaling', { target: o })
    return before !== JSON.stringify(c.endpoints())
  })
  check('connector follows scale and rotate', scaled)

  // page growth: drag b past the page bottom and left edge
  await page.evaluate(() => { const { canvas } = window.__personalNote; const o = canvas.getObjects().find((x) => x.semanticId === 'res_b'); o.set({ scaleX: 1, scaleY: 1, angle: 0 }); o.setCoords(); canvas.fire('object:modified', { target: o }) })
  await page.waitForTimeout(500)
  const pos = await clientOf(page, 'res_b')
  const cols0 = await page.evaluate(() => window.__personalNote.state.pages.columns)
  await page.mouse.move(pos.x, pos.y); await page.mouse.down()
  for (let i = 1; i <= 40; i += 1) { await page.mouse.move(pos.x - i * 25, pos.y + i * 2); await page.waitForTimeout(16) }
  await page.screenshot({ path: `${shots}/5-prepend-mid-drag.png` })
  await page.mouse.up()
  await page.waitForTimeout(900)
  const grown = await page.evaluate(() => window.__personalNote.state.pages.columns)
  const consistent = await page.evaluate(() => {
    const { canvas } = window.__personalNote
    const by = Object.fromEntries(canvas.getObjects().filter((o) => o.semanticId && o.type !== 'Connector' && o.type !== 'connector').map((o) => [o.semanticId, o.getBoundingRect()]))
    return canvas.getObjects().filter((o) => o.type === 'Connector' || o.type === 'connector').map((c) => {
      const a = by[c.fromId]; const b = by[c.toId]; const e = c.endpoints()
      // endpoint must be within gap+1px of the target box edge
      const near = (p, r) => Math.max(r.left - p.x, p.x - (r.left + r.width), r.top - p.y, p.y - (r.top + r.height))
      return [near(e.start, a), near(e.end, b)]
    })
  })
  check('pages grew while dragging', grown > cols0, `${cols0} -> ${grown}`)
  check('connector ends stay a gap off their objects after growth', consistent.every((pair) => pair.every((d) => d > 0 && d < 12)), JSON.stringify(consistent))
  await page.screenshot({ path: `${shots}/6-after-prepend.png` })

  // select connector alone and delete; undo restores
  await tool(page, 'select')
  const countBefore = (await connectors(page)).length
  const mid = await page.evaluate(() => {
    const { canvas } = window.__personalNote
    const c = canvas.getObjects().find((x) => x.type === 'Connector' || x.type === 'connector')
    const { start, end } = c.endpoints(); const v = canvas.viewportTransform; const r = canvas.upperCanvasEl.getBoundingClientRect()
    return { x: r.left + ((start.x + end.x) / 2) * v[0] + v[4], y: r.top + ((start.y + end.y) / 2) * v[3] + v[5] }
  })
  await page.mouse.click(mid.x, mid.y)
  const selected = await page.evaluate(() => { const a = window.__personalNote.canvas.getActiveObject(); return a?.type })
  check('connector can be selected on its own', /connector/i.test(selected || ''), String(selected))
  await page.screenshot({ path: `${shots}/7-connector-selected.png` })
  await page.keyboard.press('Delete')
  await page.waitForTimeout(400)
  check('connector deleted on its own', (await connectors(page)).length === countBefore - 1)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(500)
  check('undo restores deleted connector', (await connectors(page)).length === countBefore)
  // delete endpoint object -> connectors go; undo restores both
  await tool(page, 'select')
  const aPos = await clientOf(page, 'res_a')
  await page.mouse.click(aPos.x, aPos.y)
  await page.keyboard.press('Delete')
  await page.waitForTimeout(400)
  const afterDelete = await connectors(page)
  check('deleting an endpoint deletes its connectors', afterDelete.every((k) => k.from !== 'res_a' && k.to !== 'res_a') && afterDelete.length === countBefore - 1, `left ${afterDelete.length}`)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(500)
  check('undo restores the object and its connector', (await connectors(page)).length === countBefore)
  await page.waitForTimeout(800)
  await context.close()
}

{
  // reload from the saved note
  const { context, page } = await open(1440, 900)
  const list = await connectors(page)
  check('connectors reload with the note', list.length === 2 && list.every((k) => k.visible), JSON.stringify(list.map((k) => [k.from, k.to])))
  await page.screenshot({ path: `${shots}/8-reloaded.png` })
  // Group selection: a + b (+ shift-click on a connector) dragged together
  await tool(page, 'select')
  const pa = await clientOf(page, 'res_a'); const pb = await clientOf(page, 'res_b')
  await page.mouse.click(pa.x, pa.y)
  await page.keyboard.down('Shift'); await page.mouse.click(pb.x, pb.y)
  const mid = await page.evaluate(() => {
    const { canvas } = window.__personalNote
    const c = canvas.getObjects().find((x) => x.fromId === 'res_a')
    const { start, end } = c.endpoints(); const v = canvas.viewportTransform; const r = canvas.upperCanvasEl.getBoundingClientRect()
    return { x: r.left + ((start.x + end.x) / 2) * v[0] + v[4], y: r.top + ((start.y + end.y) / 2) * v[3] + v[5] }
  })
  await page.mouse.click(mid.x, mid.y)
  await page.keyboard.up('Shift')
  const group = await page.evaluate(() => { const a = window.__personalNote.canvas.getActiveObject(); return { type: a?.type, kinds: a?.getObjects?.().map((o) => o.type) } })
  check('a connector never joins a group selection', group.type === 'activeselection' && !group.kinds.some((k) => /connector/i.test(k)), JSON.stringify(group))
  const beforeDrag = await connectors(page)
  await page.mouse.move(pa.x, pa.y); await page.mouse.down()
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(pa.x + i * 6, pa.y + i * 9)
  await page.screenshot({ path: `${shots}/8b-group-drag.png` })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const afterDrag = await page.evaluate(() => {
    const { canvas } = window.__personalNote
    const box = Object.fromEntries(canvas.getObjects().filter((o) => o.semanticId && !/connector/i.test(o.type)).map((o) => [o.semanticId, o.getBoundingRect()]))
    const near = (p, r) => Math.max(r.left - p.x, p.x - (r.left + r.width), r.top - p.y, p.y - (r.top + r.height))
    return canvas.getObjects().filter((o) => /connector/i.test(o.type)).map((c) => { const e = c.endpoints(); return [near(e.start, box[c.fromId]), near(e.end, box[c.toId])] })
  })
  check('connectors stay attached after a group drag', afterDrag.every((p) => p.every((d) => d > 0 && d < 12)) && Math.abs((await connectors(page))[0].start.x - beforeDrag[0].start.x) > 20, JSON.stringify(afterDrag))
  // print path
  const printed = await page.evaluate(async () => {
    const { canvas } = window.__personalNote
    const { StaticCanvas } = await import('/node_modules/.vite/deps/fabric.js').catch(() => ({}))
    return typeof StaticCanvas
  })
  void printed
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.print-sheet-card img', { timeout: 20000 })
  await page.waitForTimeout(500)
  await page.locator('.print-sheet-card img').first().screenshot({ path: `${shots}/9-print-sheet.png` })
  await page.screenshot({ path: `${shots}/9b-print-preview.png` })
  await context.close()
}

{
  const { context, page } = await open(390, 844)
  await tool(page, 'connect')
  await page.screenshot({ path: `${shots}/10-phone.png` })
  const a = await clientOf(page, 'res_a'); const b = await clientOf(page, 'res_b')
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.screenshot({ path: `${shots}/11-phone-drag.png` })
  await page.mouse.up()
  await context.close()
}

await browser.close()
await server.close()
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `${failed.length} FAILED` : 'all passed')
process.exitCode = failed.length ? 1 : 0
