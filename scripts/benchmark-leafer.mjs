// Pan/zoom frame times on the 600-object, 12-page benchmark note: wheel events in the real app (Vite dev server, mocked /api), frame time
// = the gap between requestAnimationFrame callbacks (about 16.7 ms is 60 fps). (The old Fabric engine was measured the same way, with the
// same note and scenarios, by a script that went with it; its numbers are in docs/story/engine-race/.)
//
//   node scripts/benchmark-leafer.mjs [--dpr=1]      # default: dpr 1 and dpr 2
//
// The dev server uses port 4531 (this Vite ignores port 0 and would fall back to 5173).
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { COLUMNS, ROWS, generateNote } from './benchmark-note.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, value = 'true'] = arg.replace(/^--/, '').split('='); return [key, value] }))
const dprs = args.dpr ? [Number(args.dpr)] : [1, 2]

const now = new Date().toISOString()
const summary = { id: 1, resourceId: 'res_bench', revision: 1, noteType: 'canvas', title: 'Benchmark note', notebookId: 1, createdAt: now, updatedAt: now }
const notebooks = [{ id: 1, resourceId: 'res_nb', revision: 1, name: 'Bench', color: '#76669a', noteCount: 1 }]

async function mockApi(page, content) {
  await page.route('**/api/**', async (route) => {
    const apiPath = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (apiPath === '/notebooks') return json(notebooks)
    if (apiPath === '/notes') return json([summary])
    if (apiPath === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, content, pageState: { columns: COLUMNS, rows: ROWS } })
    return json({})
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

async function wheelPan(page) {
  await page.mouse.move(700, 450)
  for (let i = 0; i < 120; i += 1) { await page.mouse.wheel(i < 60 ? 6 : -6, i < 60 ? 24 : -24); await nextFrame(page) }
}

async function runDpr(browser, baseUrl, dpr, content) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('page error:', error.message))
  await mockApi(page, content)
  await page.goto(new URL('notes', baseUrl).href)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(800)
  const setup = await page.evaluate(() => {
    const { leaferCanvas, state, getCanvasScale } = window.__personalNote
    return { openingZoom: +getCanvasScale().toFixed(2), ...leaferCanvas().stats(), pages: `${state.pages.columns}x${state.pages.rows}` }
  })
  const rows = []
  rows.push(await measure(page, 'pan at the opening view (dense note)', () => wheelPan(page)))
  await page.evaluate(() => {
    const { viewSize, state, getCanvasScale, setCanvasViewportOffset } = window.__personalNote
    state.canvasZoom = 1
    setCanvasViewportOffset(viewSize.width / 2 - 430 * getCanvasScale(), 104)
  })
  await page.waitForTimeout(300)
  rows.push(await measure(page, 'pan (wheel) at 100%', () => wheelPan(page)))
  rows.push(await measure(page, 'zoom (ctrl+wheel)', async () => {
    await page.mouse.move(700, 450)
    await page.keyboard.down('Control')
    for (let i = 0; i < 120; i += 1) { await page.mouse.wheel(0, i < 60 ? -12 : 12); await nextFrame(page) }
    await page.keyboard.up('Control')
  }))
  await context.close()
  return { dpr, setup, rows }
}

const server = await createServer({ server: { port: 4531, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const baseUrl = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
const content = generateNote()
try {
  for (const dpr of dprs) {
    const result = await runDpr(browser, baseUrl, dpr, content)
    console.log(`\n== Leafer, devicePixelRatio ${dpr}: ${result.setup.drawn} objects drawn (${result.setup.unknown} unknown), ${result.setup.pages} pages, opens at ${result.setup.openingZoom}x ==`)
    console.table(result.rows)
  }
} finally {
  await browser.close()
  await server.close()
}
