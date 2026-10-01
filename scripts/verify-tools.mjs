// Drives the real app (Vite dev server on a random port, headless, mocked /api) through the F-017 checks: Paper default,
// hold-Space hand, V/H keys, middle-mouse pan, selection kept while panning, Space during a drag.  node scripts/verify-tools.mjs
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const shots = process.argv[2] || path.join(os.tmpdir(), 'shots-f017')
fs.mkdirSync(shots, { recursive: true })
let stored = { version: '7.4.0', objects: [] }
let pageState = { columns: 1, rows: 1 }
let revision = 1
let saves = 0
let deleteCalls = 0
let deletedFirst = false
let slowSecond = false
const now = new Date().toISOString()
const second = { id: 2, resourceId: 'res_second', revision: 1, noteType: 'canvas', title: 'Second', notebookId: 1, createdAt: now, updatedAt: now }
const summary = () => ({ id: 1, resourceId: 'res_note', revision, noteType: 'canvas', title: 'Objects', notebookId: 1, createdAt: now, updatedAt: now })
const notebooks = [{ id: 1, resourceId: 'res_nb', revision: 1, name: 'Bench', color: '#76669a', noteCount: 1 }]

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const baseUrl = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`) }

async function open(width = 1440, height = 900, skin = null) {
  stored = { version: '7.4.0', objects: [] }; pageState = { columns: 1, rows: 1 }; deleteCalls = 0; deletedFirst = false; slowSecond = false
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('page error:', error.message))
  page.on('console', (m) => { if (m.type() === 'error') console.error('console error:', m.text()) })
  if (skin) await page.addInitScript((s) => localStorage.setItem('personal-note:skin', s), skin)
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const route_ = url.pathname.replace(/^\/api/, '')
    const method = route.request().method()
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (route_ === '/notebooks') return json(notebooks)
    if (route_ === '/notes') return json(deletedFirst ? [second] : [summary(), second])
    if (route_ === '/notes/2' && method === 'GET') { if (slowSecond) await new Promise((r) => setTimeout(r, 1500)); return json({ ...second, content: { version: '7.4.0', objects: [] }, pageState: { columns: 1, rows: 1 } }) }
    if (route_ === '/notes/1' && method === 'DELETE') { deleteCalls += 1; deletedFirst = true; return route.fulfill({ status: 204 }) }
    if (route_ === '/notes/1' && method === 'GET') return json({ ...summary(), content: stored, pageState })
    if (route_ === '/notes/1' && method === 'PUT') {
      const body = JSON.parse(route.request().postData())
      stored = body.content; pageState = body.pageState; revision += 1; saves += 1
      return json({ ...summary() })
    }
    return json([])
  })
  await page.goto(new URL('notes', baseUrl).href)
  await page.waitForFunction(() => window.__personalNote?.canvas && document.querySelector('.note-list-item.active'), null, { timeout: 30000 })
  await page.waitForTimeout(900)
  return { context, page }
}


const tool = (page) => page.evaluate(() => window.__personalNote.state.tool)
const vpt = (page) => page.evaluate(() => window.__personalNote.canvas.viewportTransform.slice(4, 6).map(Math.round))
const cursor = (page) => page.evaluate(() => window.__personalNote.canvas.upperCanvasEl.style.cursor || window.__personalNote.canvas.defaultCursor)
const count = (page) => page.evaluate(() => window.__personalNote.canvas.getObjects().length)

{
  const { context, page } = await open()
  check('first launch uses Paper', await page.evaluate(() => document.documentElement.dataset.skin) === 'paper')
  await context.close()
}
{
  const { context, page } = await open(1440, 900, 'night')
  check('a stored skin is kept', await page.evaluate(() => document.documentElement.dataset.skin) === 'night')
  await context.close()
}
{
  const { context, page } = await open(1440, 900, 'crayon')
  const box = await page.evaluate(() => { const r = window.__personalNote.canvas.upperCanvasEl.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  const mx = box.x + box.w / 2, my = box.y + box.h / 2
  await page.click('[data-tool="select"]')
  for (let i = 0; i < 3; i += 1) await page.click('#zoom-in')
  await page.waitForTimeout(200)
  await page.mouse.move(mx, my)

  check('tooltips show V and H', (await page.getAttribute('[data-tool="select"]', 'title')).includes('(V)') && (await page.getAttribute('[data-tool="hand"]', 'title')).includes('(H)'))

  await page.keyboard.press('h')
  check('H selects the hand and it stays', await tool(page) === 'hand')
  await page.keyboard.press('v')
  check('V selects the arrow', await tool(page) === 'select')

  // hold Space: hand while held, grab cursor, drag pans, release restores the previous tool
  await page.keyboard.press('p')
  check('P selects the pen', await tool(page) === 'pen')
  await page.keyboard.down('Space')
  await page.keyboard.down('Space')
  check('holding Space switches to the hand', await tool(page) === 'hand')
  check('Space shows the grab cursor', await cursor(page) === 'grab')
  const before = await vpt(page)
  await page.mouse.down(); await page.mouse.move(mx + 60, my + 50, { steps: 5 }); await page.mouse.up()
  const after = await vpt(page)
  check('dragging with Space held pans', after[0] !== before[0] || after[1] !== before[1], JSON.stringify({ before, after }))
  check('panning with the hand draws nothing', await count(page) === 0)
  await page.keyboard.up('Space')
  check('releasing Space returns to the pen', await tool(page) === 'pen')

  // panning keeps the current selection
  await page.keyboard.press('v')
  await page.evaluate(() => { const n = window.__personalNote; const o = n.canvas.getObjects()[0] || null; window.__keep = o; if (o) n.canvas.setActiveObject(o) })
  if (await page.evaluate(() => !window.__keep)) {
    await page.keyboard.press('t'); await page.mouse.click(mx, my + 120); await page.waitForTimeout(100); await page.keyboard.type('x'); await page.keyboard.press('Escape')
    await page.keyboard.press('v')
    await page.evaluate(() => { const n = window.__personalNote; window.__keep = n.canvas.getObjects()[0]; n.canvas.setActiveObject(window.__keep) })
  }
  await page.mouse.move(mx, my)
  await page.keyboard.down('Space')
  await page.mouse.down(); await page.mouse.move(mx + 30, my + 20, { steps: 4 }); await page.mouse.up()
  await page.keyboard.up('Space')
  check('Space pan keeps the selection', await page.evaluate(() => window.__personalNote.canvas.getActiveObject() === window.__keep))
  await page.mouse.down({ button: 'middle' }); await page.mouse.move(mx - 30, my - 20, { steps: 4 }); await page.mouse.up({ button: 'middle' })
  check('middle-mouse pan keeps the selection', await page.evaluate(() => window.__personalNote.canvas.getActiveObject() === window.__keep))
  await page.keyboard.press('h')
  check('an explicit tool switch still deselects', await page.evaluate(() => window.__personalNote.canvas.getActiveObject() == null))
  await page.keyboard.press('v')
  await page.evaluate(() => { window.__personalNote.canvas.discardActiveObject(); window.__personalNote.canvas.getObjects().forEach((o) => window.__personalNote.canvas.remove(o)) })

  // Space pressed while the pointer is down must not switch tools until it is released
  await page.keyboard.press('p')
  await page.mouse.move(mx - 200, my - 100); await page.mouse.down(); await page.mouse.move(mx - 150, my - 80, { steps: 5 })
  await page.keyboard.down('Space')
  check('Space mid-stroke keeps the pen', await tool(page) === 'pen')
  await page.mouse.move(mx - 100, my - 60, { steps: 5 }); await page.mouse.up()
  await page.waitForTimeout(100)
  check('the stroke is kept whole (one path, no extra ink)', await page.evaluate(() => window.__personalNote.canvas.getObjects().length) === 1)
  check('the hand takes over once the pointer is released', await tool(page) === 'hand')
  await page.keyboard.up('Space')
  check('and releasing Space returns to the pen', await tool(page) === 'pen')
  await page.mouse.move(mx + 100, my + 100); await page.mouse.down(); await page.mouse.move(mx + 150, my + 120, { steps: 5 }); await page.mouse.up()
  await page.waitForTimeout(150)
  check('the next stroke is a normal stroke', await page.evaluate(() => window.__personalNote.canvas.getObjects().length) === 2)
  await page.evaluate(() => { const c = window.__personalNote.canvas; c.getObjects().forEach((o) => c.remove(o)) })
  // Space released mid-drag with the hand: pen comes back only after the drag
  await page.keyboard.down('Space')
  await page.mouse.move(mx, my); await page.mouse.down(); await page.mouse.move(mx + 20, my + 10, { steps: 3 })
  await page.keyboard.up('Space')
  check('releasing Space mid-pan keeps the hand until the drag ends', await tool(page) === 'hand')
  await page.mouse.up()
  await page.waitForTimeout(50)
  check('then the pen returns', await tool(page) === 'pen')
  check('no ink was drawn by those pans', await count(page) === 0)

  // a multi-selection survives Space, hand and middle-mouse pans, without history or saves
  await page.keyboard.press('v')
  await page.evaluate(async () => {
    const N = window.__personalNote, c = N.canvas
    const { Rect, ActiveSelection } = N.fabric
    const a = new Rect({ left: 100, top: 100, width: 60, height: 40 }), b = new Rect({ left: 300, top: 100, width: 60, height: 40 })
    c.add(a, b)
    c.setActiveObject(new ActiveSelection([a, b], { canvas: c }))
    window.__multi = [a, b]
  })
  await page.waitForTimeout(1500)
  const hist0 = await page.evaluate(() => window.__personalNote.state.historyIndex)
  const sameSelection = () => page.evaluate(() => { const cur = window.__personalNote.canvas.getActiveObjects(); return cur.length === 2 && window.__multi.every((o) => cur.includes(o)) })
  await page.mouse.move(mx, my)
  await page.keyboard.down('Space'); await page.mouse.down(); await page.mouse.move(mx + 30, my + 20, { steps: 4 }); await page.mouse.up(); await page.keyboard.up('Space')
  check('Space pan keeps a multi-selection', await sameSelection())
  await page.mouse.down({ button: 'middle' }); await page.mouse.move(mx - 30, my - 20, { steps: 4 }); await page.mouse.up({ button: 'middle' })
  check('middle-mouse pan keeps a multi-selection', await sameSelection())
  await page.keyboard.press('h'); await page.keyboard.press('v')
  await page.waitForTimeout(1500)
  check('panning added no history entry', await page.evaluate(() => window.__personalNote.state.historyIndex) === hist0)
  await page.evaluate(() => { const c = window.__personalNote.canvas; c.discardActiveObject(); c.getObjects().forEach((o) => c.remove(o)) })

  // a pointerdown whose pointerup never arrives (a context menu eats it) must not disable Space
  await page.keyboard.press('v')
  await page.evaluate(() => window.__personalNote.canvas.upperCanvasEl.dispatchEvent(new PointerEvent('pointerdown', { button: 2, buttons: 2, bubbles: true, pointerType: 'mouse' })))
  await page.mouse.click(mx, my - 150)
  await page.keyboard.down('Space')
  check('a pointerdown without its pointerup does not disable Space', await tool(page) === 'hand')
  await page.keyboard.up('Space')
  check('and Space still returns to the previous tool', await tool(page) === 'select')

  // Space no longer pages the canvas
  await page.keyboard.press('v')
  const idle = await vpt(page)
  await page.keyboard.press('Space')
  await page.keyboard.press('Shift+Space')
  check('Space does not page the canvas', JSON.stringify(await vpt(page)) === JSON.stringify(idle))
  await page.keyboard.press('ArrowDown')
  check('arrow keys still pan', JSON.stringify(await vpt(page)) !== JSON.stringify(idle))

  // middle mouse pans from any tool without drawing
  await page.keyboard.press('p')
  const m0 = await vpt(page)
  await page.mouse.move(mx, my)
  await page.mouse.down({ button: 'middle' }); await page.mouse.move(mx - 70, my - 40, { steps: 5 }); await page.mouse.up({ button: 'middle' })
  const m1 = await vpt(page)
  check('middle-mouse drag pans while the pen is active', m1[0] !== m0[0] || m1[1] !== m0[1], JSON.stringify({ m0, m1 }))
  check('the pen is still active and nothing was drawn', await tool(page) === 'pen' && await count(page) === 0)

  // never while typing
  await page.keyboard.press('t')
  await page.mouse.click(mx, my)
  await page.waitForTimeout(100)
  await page.keyboard.type('h v')
  check('typing h, v and Space in text does not switch tools', await tool(page) === 'text')
  const typed = await page.evaluate(() => window.__personalNote.canvas.getObjects().map((o) => o.text).join('|'))
  check('the typed text is intact', typed.includes('h v'), typed)
  await page.keyboard.press('Escape')

  // never in the search dialog
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(200)
  const searchTool = await tool(page)
  await page.keyboard.type('h v ')
  check('keys in search do not switch tools', await tool(page) === searchTool)
  await page.keyboard.press('Escape')

  // pen drawing still works
  await page.keyboard.press('Escape')
  await page.keyboard.press('p')
  await page.mouse.move(mx - 200, my - 100)
  await page.mouse.down(); await page.mouse.move(mx - 120, my - 60, { steps: 6 }); await page.mouse.up()
  await page.waitForTimeout(200)
  check('pen still draws', await count(page) >= 1)
  await context.close()
}
{
  const { context, page } = await open(390, 844)
  check('phone: the Draw button is still there and starts the pen', await page.locator('#mobile-draw').isVisible() && (await page.click('#mobile-draw'), await tool(page)) === 'pen')
  await page.screenshot({ path: path.join(shots, 'phone.png') })
  await context.close()
}

await browser.close()
await server.close()
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `${failed.length} FAILED` : `${results.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
