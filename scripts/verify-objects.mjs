// Drives the real app (Vite dev server, in-memory mocked /api) through the F-012 acceptance checks for
// the desk view and the Sticky note, Shape and Image tools.  node scripts/verify-objects.mjs <shotsDir>
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const shots = process.argv[2] || path.join(os.tmpdir(), 'shots-f012-objects')
fs.mkdirSync(shots, { recursive: true })
let stored = { version: '7.4.0', objects: [] }
let pageState = { columns: 1, rows: 1 }
let revision = 1
let saves = 0
const now = new Date().toISOString()
const summary = () => ({ id: 1, resourceId: 'res_note', revision, noteType: 'canvas', title: 'Objects', notebookId: 1, createdAt: now, updatedAt: now })
const notebooks = [{ id: 1, resourceId: 'res_nb', revision: 1, name: 'Bench', color: '#76669a', noteCount: 1 }]

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const baseUrl = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`) }

async function open(width = 1440, height = 900, skin = 'crayon') {
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('page error:', error.message))
  page.on('console', (m) => { if (m.type() === 'error') console.error('console error:', m.text()) })
  await page.addInitScript((s) => localStorage.setItem('personal-note:skin', s), skin)
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const route_ = url.pathname.replace(/^\/api/, '')
    const method = route.request().method()
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (route_ === '/notebooks') return json(notebooks)
    if (route_ === '/notes') return json([summary()])
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

const objects = (page) => page.evaluate(() => window.__personalNote.canvas.getObjects().map((o) => ({ type: o.type[0].toUpperCase() + o.type.slice(1), text: o.text, id: o.semanticId, stickyColor: o.stickyColor, fill: o.fill, rx: o.rx, w: o.width, h: o.height })))
const toClient = (page, x, y) => page.evaluate(([px, py]) => {
  const { canvas } = window.__personalNote
  const v = canvas.viewportTransform
  const r = canvas.upperCanvasEl.getBoundingClientRect()
  return { x: r.left + px * v[0] + v[4], y: r.top + py * v[3] + v[5] }
}, [x, y])
const click = async (page, x, y) => { const c = await toClient(page, x, y); await page.mouse.click(c.x, c.y); await page.waitForTimeout(300) }
const flush = async (page) => { await page.waitForTimeout(700) }

{
  const { context, page } = await open()
  const zoom = await page.evaluate(() => window.__personalNote.getCanvasScale())
  check('a one-page note opens zoomed out to show the whole page', zoom > 0.5 && zoom < 0.62, `scale ${zoom.toFixed(3)}`)
  const view = await page.evaluate(() => { const { canvas } = window.__personalNote; const v = canvas.viewportTransform; return { top: v[5], bottom: v[5] + 1080 * v[3], w: canvas.getHeight() } })
  check('the whole page is on screen', view.top >= 60 && view.bottom <= view.w, JSON.stringify(view))

  await page.click('[data-tool="sticky"]')
  await click(page, 200, 160)
  let list = await objects(page)
  check('the sticky tool places a coloured sticky and starts editing it', list.length === 1 && list[0].type === 'Sticky' && list[0].stickyColor === '#ffd60a', JSON.stringify(list[0]))
  await page.keyboard.type('Buy paper')
  await page.waitForTimeout(250)
  await page.keyboard.press('Escape')
  list = await objects(page)
  check('sticky text is editable in place', list[0].text === 'Buy paper', list[0].text)
  check('after placing, the tool returns to select', await page.evaluate(() => window.__personalNote.state.tool === 'select'))

  await page.click('[data-tool="shape"]')
  await click(page, 560, 460)
  list = await objects(page)
  check('the shape tool places a rounded rectangle', list.length === 2 && list[1].type === 'Rect' && list[1].rx > 0 && list[1].fill === '#ffd60a', JSON.stringify(list[1]))

  // colour choice from the tool popover
  await page.click('[data-tool="sticky"]')
  await page.click('[data-tool="sticky"]')
  await page.click('[data-object-color="3"]')
  await click(page, 540, 160)
  list = await objects(page)
  check('the popover picks the next sticky colour from the skin palette', list[2].type === 'Sticky' && list[2].stickyColor === '#bf5af2', list[2]?.stickyColor)
  await page.keyboard.type('Purple note')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: `${shots}/1-tools-placed.png` })

  // connect sticky -> shape
  await page.click('[data-tool="connect"]')
  const a = await toClient(page, 200, 160)
  const b = await toClient(page, 560, 460)
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up()
  await page.waitForTimeout(400)
  list = await objects(page)
  check('stickies and shapes work as connector endpoints', list.some((o) => o.type === 'Connector'), list.map((o) => o.type).join(','))

  // undo / redo
  const before = (await objects(page)).length
  await page.click('#undo'); await page.waitForTimeout(500)
  const afterUndo = (await objects(page)).length
  await page.click('#redo'); await page.waitForTimeout(500)
  const afterRedo = (await objects(page)).length
  check('undo and redo step through sticky, shape and connector changes', afterUndo === before - 1 && afterRedo === before, `${before} ${afterUndo} ${afterRedo}`)

  // image by file picker
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 300
    const x = c.getContext('2d'); x.fillStyle = '#e91e63'; x.fillRect(0, 0, 600, 300); x.fillStyle = '#fff'; x.fillRect(40, 40, 200, 100)
    return c.toDataURL('image/png').split(',')[1]
  })
  const pngPath = path.join(os.tmpdir(), 'f012-test.png')
  fs.writeFileSync(pngPath, Buffer.from(png, 'base64'))
  await page.setInputFiles('#image-file', pngPath)
  await page.waitForFunction(() => window.__personalNote.canvas.getObjects().some((o) => o.type === 'image'), null, { timeout: 5000 })
  check('the image tool adds a picture from the file picker', (await objects(page)).some((o) => o.type === 'Image'))

  // image by drag and drop
  const dropAt = await toClient(page, 600, 800)
  await page.evaluate(async ([x, y, b64]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const file = new File([bytes], 'dropped.png', { type: 'image/png' })
    const dt = new DataTransfer(); dt.items.add(file)
    const target = document.querySelector('#workspace')
    for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }))
  }, [dropAt.x, dropAt.y, png])
  await page.waitForFunction(() => window.__personalNote.canvas.getObjects().filter((o) => o.type === 'image').length === 2, null, { timeout: 5000 })
  const dropped = await page.evaluate(() => { const i = window.__personalNote.canvas.getObjects().filter((o) => o.type === 'image')[1]; const c = i.getCenterPoint(); return { x: c.x, y: c.y } })
  check('dropping a picture places it where it was dropped', Math.abs(dropped.x - 600) < 4 && Math.abs(dropped.y - 800) < 4, JSON.stringify(dropped))
  await page.screenshot({ path: `${shots}/2-with-image.png` })

  // save and reload
  await flush(page)
  await page.waitForFunction(() => document.querySelector('#save-state').textContent.includes('Saved'), null, { timeout: 8000 })
  check('the note saved with sticky, shape and image', saves > 0 && stored.objects.some((o) => o.type === 'Sticky') && stored.objects.some((o) => o.type === 'Image'), `${saves} saves`)
  await context.close()
}

{
  const { context, page } = await open()
  const list = await objects(page)
  const sticky = list.filter((o) => o.type === 'Sticky')
  check('stickies and shapes come back after a reload, text and colour intact', sticky.length === 2 && sticky[0].text === 'Buy paper' && sticky[1].stickyColor === '#bf5af2' && list.some((o) => o.type === 'Rect'), list.map((o) => o.type).join(','))
  check('connectors survive the reload', list.some((o) => o.type === 'Connector'))
  check('pictures survive the reload', list.filter((o) => o.type === 'Image').length === 2)
  await page.screenshot({ path: `${shots}/3-reloaded.png` })

  // print preview renders every object
  await page.evaluate(() => document.querySelector('#share-print').click())
  await page.waitForSelector('.print-sheet-list img', { timeout: 15000 })
  const bright = await page.evaluate(async () => {
    const image = document.querySelector('.print-sheet-list img')
    await image.decode()
    const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight
    const x = c.getContext('2d'); x.drawImage(image, 0, 0)
    const at = (px, py) => Array.from(x.getImageData(Math.round(px * 2), Math.round(py * 2), 1, 1).data)
    return { sticky: at(190, 170), paper: at(10, 10) }
  })
  check('print output is white paper with the sticky drawn on it', bright.paper[0] === 255 && bright.paper[1] === 255 && bright.paper[2] === 255 && bright.sticky[0] === 255 && bright.sticky[2] < 100, JSON.stringify(bright))
  await page.screenshot({ path: `${shots}/4-print.png` })
  await context.close()
}

{
  // Paper keeps its ivory, Night keeps its current paper, Crayon is white.
  const colors = {}
  for (const skin of ['crayon', 'paper', 'night']) {
    const { context, page } = await open(1440, 900, skin)
    colors[skin] = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--paper').trim())
    await page.screenshot({ path: `${shots}/5-${skin}.png` })
    await context.close()
  }
  check('paper colour: Crayon white, Paper and Night unchanged', colors.crayon === '#ffffff' && colors.paper === '#fbfaf5' && colors.night === '#fbfaf5', JSON.stringify(colors))
}

{
  // Phones keep the capture layout: full-width first page, no dock.
  const { context, page } = await open(390, 844)
  const scale = await page.evaluate(() => window.__personalNote.getCanvasScale())
  const dock = await page.evaluate(() => getComputedStyle(document.querySelector('.tool-dock')).display)
  check('phone layout is unchanged: page fills the width and the dock stays hidden', scale > 0.4 && dock === 'none', `scale ${scale.toFixed(2)} dock ${dock}`)
  await context.close()
}

await browser.close()
await server.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
