// F-029: frame times while typing on the 600-object, 12-page benchmark note (the same note and measuring as benchmark-leafer-edit.mjs):
// type into a new text (one character per frame), type into a new sticky until it grows, type into an existing text, and the frames
// that open and close the editor. Frame time = the gap between requestAnimationFrame callbacks (about 16.7 ms is 60 fps).
//
//   node scripts/benchmark-leafer-text.mjs [--dpr=1]      # default: dpr 1 and dpr 2
//
// The dev server uses port 4761; /api is mocked, and the proxy to the real server is pointed at a dead port.
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { COLUMNS, ROWS, generateNote } from './benchmark-note.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, value = 'true'] = arg.replace(/^--/, '').split('='); return [key, value] }))
const dprs = args.dpr ? [Number(args.dpr)] : [1, 2]
const PORT = 4761

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
const TEXT = 'The quick brown fox jumps over the lazy dog, and then types a few more words to fill a line or two. '

async function typeFrames(page, count) {
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.type(TEXT[i % TEXT.length])
    await nextFrame(page)
  }
}

// Page coordinates -> screen, from where Leafer has put the page.
async function pagePoint(page, x, y) {
  const v = await page.evaluate(() => {
    const world = window.__personalNote.leaferCanvas().drawnWorld()
    const rect = document.querySelector('#leafer-host').getBoundingClientRect()
    return { x: rect.left + world.x, y: rect.top + world.y, scale: world.scaleX }
  })
  return { x: v.x + x * v.scale, y: v.y + y * v.scale }
}

async function scenarios(page, label) {
  const rows = []
  const where = await page.evaluate(() => {
    const world = window.__personalNote.leaferCanvas().drawnWorld()
    const rect = document.querySelector('#leafer-host').getBoundingClientRect()
    // a page spot on screen, near the middle of the view
    return { x: (rect.width / 2 - world.x) / world.scaleX, y: (rect.height / 2 - world.y) / world.scaleX }
  })
  const first = await pagePoint(page, where.x, where.y)
  await page.click('[data-tool="text"]')
  rows.push(await measure(page, `${label}: type 200 characters into a new text`, async () => {
    await page.mouse.click(first.x, first.y)
    await page.waitForSelector('.leafer-text-editor')
    await typeFrames(page, 200)
    await page.keyboard.press('Escape') // the frame that ends the edit: the words become an edit and a save is queued
    await nextFrame(page)
    await nextFrame(page)
  }))
  await page.waitForTimeout(900)
  await page.click('[data-tool="sticky"]')
  const second = await pagePoint(page, where.x + 120, where.y + 160)
  rows.push(await measure(page, `${label}: type into a new sticky until it grows`, async () => {
    await page.mouse.click(second.x, second.y)
    await page.waitForSelector('.leafer-text-editor')
    await typeFrames(page, 120)
    await page.keyboard.press('Escape')
    await nextFrame(page)
    await nextFrame(page)
  }))
  await page.waitForTimeout(900)
  const id = await page.evaluate(() => window.__personalNote.leaferEdits.doc.objects.findLast((o) => o.type === 'text')?.id)
  rows.push(await measure(page, `${label}: open the editor on an existing text, type 60 characters, end the edit`, async () => {
    await page.evaluate((target) => window.__personalNote.leaferCanvas().editText(target), id)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.press('Control+End')
    await typeFrames(page, 60)
    await page.keyboard.press('Escape')
    await nextFrame(page)
    await nextFrame(page)
  }))
  await page.waitForTimeout(900)
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
    const { viewSize, state, getCanvasScale, setCanvasViewportOffset } = window.__personalNote
    state.canvasZoom = 1
    setCanvasViewportOffset(viewSize.width / 2 - 430 * getCanvasScale(), 104)
  })
  await page.waitForTimeout(400)
  rows.push(...await scenarios(page, '100%'))
  await context.close()
  return { dpr, setup, rows }
}

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4769' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
const content = generateNote()
try {
  for (const dpr of dprs) {
    const result = await runDpr(browser, dpr, content)
    console.log(`\n== Leafer text editing, devicePixelRatio ${dpr}: ${result.setup.drawn} objects drawn, opens at ${result.setup.openingZoom}x ==`)
    console.table(result.rows)
  }
} finally {
  await browser.close()
  await server.close()
}
