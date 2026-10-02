// F-028: frame times while editing on the 600-object, 12-page benchmark note (the same note and measuring as benchmark-leafer.mjs):
// drag one object, resize one object, drag a selection of 40, nudge with a held arrow key. Frame time = the gap between
// requestAnimationFrame callbacks (about 16.7 ms is 60 fps), the real mouse driven one move per frame.
//
//   node scripts/benchmark-leafer-edit.mjs [--dpr=1]      # default: dpr 1 and dpr 2
//
// The dev server uses port 4745; /api is mocked, and the proxy to the real server is pointed at a dead port.
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { COLUMNS, ROWS, generateNote } from './benchmark-note.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, value = 'true'] = arg.replace(/^--/, '').split('='); return [key, value] }))
const dprs = args.dpr ? [Number(args.dpr)] : [1, 2]
const PORT = 4745

const now = new Date().toISOString()
const summary = { id: 1, resourceId: 'res_bench', revision: 1, noteType: 'canvas', title: 'Benchmark note', notebookId: 1, createdAt: now, updatedAt: now }

async function mockApi(page, content) {
  await page.route('**/api/**', async (route) => {
    const apiPath = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (apiPath === '/notebooks') return json([{ id: 1, resourceId: 'res_nb', revision: 1, name: 'Bench', color: '#76669a', noteCount: 1 }])
    if (apiPath === '/notes') return json([summary])
    if (apiPath === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, content, pageState: { columns: COLUMNS, rows: ROWS } })
    return json({ revision: 2, resourceId: 'res_bench' })
  })
}

const stat = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  return { median: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +(sorted.at(-1) ?? 0).toFixed(1), frames: sorted.length }
}

async function measure(page, name, run) {
  await page.evaluate(() => {
    window.__frames = []
    let last = performance.now()
    const tick = (time) => { window.__frames.push(time - last); last = time; window.__loop = requestAnimationFrame(tick) }
    window.__loop = requestAnimationFrame(tick)
  })
  await run()
  const frames = await page.evaluate(() => { cancelAnimationFrame(window.__loop); return window.__frames.slice(2) })
  return { scenario: name, ...stat(frames), slowFrames: frames.filter((f) => f > 20).length }
}

const nextFrame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))

async function dragPath(page, from, to, steps = 90) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    const wobble = Math.sin(t * Math.PI * 2) * 40
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t + wobble)
    await nextFrame(page)
  }
  await page.mouse.up()
  await nextFrame(page)
}

// An object on screen, fully inside the viewport, and where to press on it.
async function visibleObjects(page, types) {
  return await page.evaluate((wanted) => {
    const { leaferCanvas, leaferEdits } = window.__personalNote
    const scene = leaferCanvas()
    const host = document.querySelector('#leafer-host').getBoundingClientRect()
    const out = []
    for (const object of leaferEdits.doc.objects) {
      if (!wanted.includes(object.type)) continue
      const box = scene.screenBox(object.id)
      if (!box) continue
      const x = host.left + box.x
      const y = host.top + box.y
      if (x > 260 && y > 120 && x + box.width < host.right - 80 && y + box.height < host.bottom - 140 && box.width > 12 && box.height > 12) out.push({ id: object.id, x: x + box.width / 2, y: y + box.height / 2, left: x, top: y, right: x + box.width, bottom: y + box.height })
    }
    return out
  }, types)
}

async function scenarios(page, label) {
  const rows = []
  const shapes = await visibleObjects(page, ['shape', 'sticky'])
  const target = shapes[Math.floor(shapes.length / 2)]
  if (!target) return [{ scenario: `${label}: nothing to drag in view` }]
  await page.mouse.click(target.x, target.y)
  rows.push(await measure(page, `${label}: drag one object`, () => dragPath(page, { x: target.x, y: target.y }, { x: target.x + 160, y: target.y + 90 })))
  const again = (await visibleObjects(page, ['shape', 'sticky'])).find((entry) => entry.id === target.id) ?? target
  await page.mouse.click(again.x, again.y)
  rows.push(await measure(page, `${label}: resize one object`, () => dragPath(page, { x: again.right, y: again.bottom }, { x: again.right + 40, y: again.bottom + 30 }, 60)))
  const crowd = (await visibleObjects(page, ['shape', 'sticky', 'text', 'image'])).slice(0, 40)
  await page.evaluate((ids) => window.__personalNote.leaferCanvas().select(ids), crowd.map((entry) => entry.id))
  await nextFrame(page)
  const lead = (await visibleObjects(page, ['shape', 'sticky', 'text', 'image'])).find((entry) => entry.id === crowd[0].id) ?? crowd[0]
  rows.push(await measure(page, `${label}: drag ${crowd.length} selected objects`, () => dragPath(page, { x: lead.x, y: lead.y }, { x: lead.x + 120, y: lead.y + 70 }, 60)))
  // A save 650 ms after an edit lands in the middle of the next drag: this is the frame that must not stall.
  const second = (await visibleObjects(page, ['shape', 'sticky'])).find((entry) => entry.id !== target.id) ?? target
  await page.mouse.click(second.x, second.y)
  rows.push(await measure(page, `${label}: drag while the save of the last edit runs`, async () => {
    await dragPath(page, { x: second.x, y: second.y }, { x: second.x + 20, y: second.y + 10 }, 6) // the edit that is saved
    const now = (await visibleObjects(page, ['shape', 'sticky'])).find((entry) => entry.id === second.id) ?? second
    await dragPath(page, { x: now.x, y: now.y }, { x: now.x + 150, y: now.y + 80 }, 90) // 1.5 s of dragging: the save fires in the middle
  }))
  rows.push(await measure(page, `${label}: nudge (held arrow key)`, async () => {
    for (let i = 0; i < 60; i += 1) { await page.keyboard.press('ArrowRight'); await nextFrame(page) }
  }))
  await page.evaluate(() => window.__personalNote.leaferCanvas().clearSelection())
  return rows
}

async function runDpr(browser, dpr, content) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('page error:', error.message))
  await mockApi(page, content)
  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(800)
  const setup = await page.evaluate(() => ({ openingZoom: +window.__personalNote.getCanvasScale().toFixed(2), ...window.__personalNote.leaferCanvas().stats() }))
  const rows = []
  rows.push(...await scenarios(page, 'opening view'))
  await page.evaluate(() => {
    const { canvas, state, getCanvasScale, setCanvasViewportOffset } = window.__personalNote
    state.canvasZoom = 1
    setCanvasViewportOffset(canvas.getWidth() / 2 - 430 * getCanvasScale(), 104)
  })
  await page.waitForTimeout(400)
  rows.push(...await scenarios(page, '100%'))
  await context.close()
  return { dpr, setup, rows }
}

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4749' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
const content = generateNote()
try {
  for (const dpr of dprs) {
    const result = await runDpr(browser, dpr, content)
    console.log(`\n== Leafer editing, devicePixelRatio ${dpr}: ${result.setup.drawn} objects drawn, opens at ${result.setup.openingZoom}x ==`)
    console.table(result.rows)
  }
} finally {
  await browser.close()
  await server.close()
}
