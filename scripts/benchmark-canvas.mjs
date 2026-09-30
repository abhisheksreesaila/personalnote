// Canvas smoothness benchmark: loads a generated 600-object, 12-page note into the
// real app (Vite dev server, mocked /api) and measures frame times while dragging,
// growing pages, panning and zooming.
//
//   npm run benchmark:canvas                  # dpr 1 and dpr 2
//   npm run benchmark:canvas -- --dpr=2 --max-p95=25
//
// Frame time is the gap between requestAnimationFrame callbacks, so ~16.7ms is 60fps.
import { createServer } from 'vite'
import { chromium } from 'playwright'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=')
  return [key, value]
}))
const dprs = args.dpr ? [Number(args.dpr)] : [1, 2]
const maxP95 = args['max-p95'] ? Number(args['max-p95']) : null
const PAGE_WIDTH = 860
const PAGE_HEIGHT = 1080
const COLUMNS = 3
const ROWS = 4

let seed = 7
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

function inkPath(x, y) {
  const commands = [['M', x, y]]
  let px = x
  let py = y
  for (let i = 0; i < 120; i += 1) {
    const nx = px + (random() - 0.4) * 8
    const ny = py + (random() - 0.5) * 8
    commands.push(['Q', px, py, (px + nx) / 2, (py + ny) / 2])
    px = nx
    py = ny
  }
  return {
    type: 'Path', version: '7.4.0', left: x, top: y, originX: 'left', originY: 'top',
    fill: null, stroke: '#223', strokeWidth: 2.5, strokeLineCap: 'round', strokeLineJoin: 'round',
    path: commands, isInk: true,
  }
}

export function generateNote() {
  const place = () => ({
    x: Math.floor(random() * COLUMNS) * PAGE_WIDTH + 40 + random() * (PAGE_WIDTH - 640),
    y: Math.floor(random() * ROWS) * PAGE_HEIGHT + 40 + random() * (PAGE_HEIGHT - 480),
  })
  const objects = []
  const texts = ['Meeting notes: ship the export', 'Idea: spatial search\nacross pages', 'TODO\n- draw\n- link\n- review']
  for (let i = 0; i < 300; i += 1) {
    const { x, y } = place()
    objects.push({
      type: 'IText', version: '7.4.0', originX: 'left', originY: 'top', left: x, top: y, text: texts[i % 3], fontSize: 20 + (i % 3) * 4,
      fontFamily: 'Source Serif 4', fill: '#222', lineHeight: 1.45, padding: 8,
    })
  }
  for (let i = 0; i < 240; i += 1) { const { x, y } = place(); objects.push(inkPath(x, y)) }
  for (let i = 0; i < 60; i += 1) {
    const { x, y } = place()
    objects.push({
      type: 'Rect', version: '7.4.0', originX: 'left', originY: 'top', left: x, top: y, width: 120 + random() * 160, height: 80 + random() * 120,
      fill: 'rgba(80,120,200,0.15)', stroke: '#4a6fb0', strokeWidth: 2, rx: 6, ry: 6,
    })
  }
  return { version: '7.4.0', objects }
}

const now = new Date().toISOString()
const summary = {
  id: 1, resourceId: 'res_bench', revision: 1, noteType: 'canvas', title: 'Benchmark note', notebookId: 1,
  createdAt: now, updatedAt: now,
}
const notebooks = [{ id: 1, resourceId: 'res_nb', revision: 1, name: 'Bench', color: '#76669a', noteCount: 1 }]

async function mockApi(page, content) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/notebooks') return json(notebooks)
    if (path === '/notes') return json([summary])
    if (path === '/notes/1' && route.request().method() === 'GET') {
      return json({ ...summary, content, pageState: { columns: COLUMNS, rows: ROWS } })
    }
    if (path.startsWith('/notes/')) return json({ ...summary, revision: 2 })
    if (path === '/settings/capabilities') return json({})
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
  const moved = await run()
  const frames = await page.evaluate(() => { cancelAnimationFrame(window.__loop); return window.__frames.slice(2) })
  return { scenario: name, ...stat(frames), slowFrames: frames.filter((f) => f > 20).length, movedPx: moved ?? '' }
}

const nextFrame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))

const objectClientPoint = (page, index) => page.evaluate((i) => {
  const { canvas } = window.__personalNote
  const object = canvas.getObjects().filter((o) => o.type === 'rect')[i]
  const center = object.getCenterPoint()
  const v = canvas.viewportTransform
  const rect = canvas.upperCanvasEl.getBoundingClientRect()
  return { x: rect.left + center.x * v[0] + v[4], y: rect.top + center.y * v[3] + v[5] }
}, index)

async function revealObject(page, index) {
  await page.evaluate((i) => {
    const { canvas, getCanvasScale, setCanvasViewportOffset } = window.__personalNote
    const object = canvas.getObjects().filter((o) => o.type === 'rect')[i]
    const c = object.getCenterPoint()
    const s = getCanvasScale()
    setCanvasViewportOffset(canvas.getWidth() / 2 - c.x * s, canvas.getHeight() / 2 - c.y * s)
    canvas.renderAll()
  }, index)
}

const objectCenter = (page, index) => page.evaluate((i) => {
  const c = window.__personalNote.canvas.getObjects().filter((o) => o.type === 'rect')[i].getCenterPoint()
  return { x: c.x, y: c.y }
}, index)

async function dragScenario(page, dx, dy, steps) {
  await revealObject(page, 3)
  const before = await objectCenter(page, 3)
  await page.evaluate(() => window.__personalNote.setTool('select'))
  const start = await objectClientPoint(page, 3)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(start.x + dx * i, start.y + dy * i)
    await nextFrame(page)
  }
  await page.mouse.up()
  const after = await objectCenter(page, 3)
  const moved = Math.round(Math.hypot(after.x - before.x, after.y - before.y))
  if (moved < 50) throw new Error(`drag scenario did not move the object (moved ${moved}px)`)
  return moved
}

async function runDpr(browser, baseUrl, dpr, content) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('page error:', error.message))
  page.on('console', (message) => { if (message.type() === 'error') console.error('console error:', message.text()) })
  await mockApi(page, content)
  await page.goto(new URL('notes', baseUrl).href)
  await page.waitForFunction(() => window.__personalNote?.canvas.getObjects().length > 0, null, { timeout: 30000 })
  await page.waitForTimeout(600)
  const setup = await page.evaluate(() => {
    const { canvas, state } = window.__personalNote
    return {
      objects: canvas.getObjects().length,
      pages: `${state.pages.columns}x${state.pages.rows}`,
      canvasPx: `${canvas.lowerCanvasEl.width}x${canvas.lowerCanvasEl.height}`,
    }
  })
  if (args.debug) {
    console.log(await page.evaluate(() => {
      const { canvas } = window.__personalNote
      const by = {}
      for (const o of canvas.getObjects()) { const b = o.getBoundingRect(); const t = (by[o.type] ||= { maxRight: 0, maxBottom: 0, minLeft: 1e9, n: 0 }); t.n++; t.maxRight = Math.max(t.maxRight, b.left + b.width); t.maxBottom = Math.max(t.maxBottom, b.top + b.height); t.minLeft = Math.min(t.minLeft, b.left); t.minLeftProp = Math.min(t.minLeftProp ?? 1e9, o.left); t.maxTop = Math.max(t.maxTop ?? 0, o.top); t.minTop = Math.min(t.minTop ?? 1e9, o.top) }; by.pages = JSON.stringify(window.__personalNote.state.pages)
      return JSON.stringify(by)
    }))
  }
  const rows = []
  rows.push(await measure(page, 'drag inside note', () => dragScenario(page, 3, 2, 90)))
  // Push an object across the grid's right edge so pages grow while dragging.
  await page.evaluate(() => {
    const { canvas, state } = window.__personalNote
    const rect = canvas.getObjects().filter((o) => o.type === 'rect')[3]
    rect.set({ left: state.pages.columns * 860 - 200, top: 300 })
    rect.setCoords()
  })
  const columnsBefore = await page.evaluate(() => window.__personalNote.state.pages.columns)
  rows.push(await measure(page, 'drag across page edge (grow)', () => dragScenario(page, 8, 0, 90)))
  if (args.debug) console.log('after grow drag', await page.evaluate(() => { const { canvas, state } = window.__personalNote; const r = canvas.getObjects().filter((o) => o.type === 'rect')[3]; return JSON.stringify({ pages: state.pages, left: r.left, right: r.getBoundingRect().left + r.getBoundingRect().width, tool: state.tool }) }))
  const grown = await page.evaluate(() => ({
    columns: window.__personalNote.state.pages.columns,
    canvasPx: `${window.__personalNote.canvas.lowerCanvasEl.width}x${window.__personalNote.canvas.lowerCanvasEl.height}`,
  }))
  rows.push(await measure(page, 'pan (wheel)', async () => {
    await page.mouse.move(700, 450)
    for (let i = 0; i < 120; i += 1) { await page.mouse.wheel(i < 60 ? 6 : -6, i < 60 ? 24 : -24); await nextFrame(page) }
  }))
  rows.push(await measure(page, 'zoom (ctrl+wheel)', async () => {
    await page.mouse.move(700, 450)
    await page.keyboard.down('Control')
    for (let i = 0; i < 120; i += 1) { await page.mouse.wheel(0, i < 60 ? -12 : 12); await nextFrame(page) }
    await page.keyboard.up('Control')
  }))
  const probe = await page.evaluate(() => {
    const { canvas, state } = window.__personalNote
    const object = canvas.getObjects().filter((o) => o.type === 'rect')[3]
    const c = object.getCenterPoint()
    state.canvasZoom = 4
    const s = 4
    canvas.setViewportTransform([s, 0, 0, s, canvas.getWidth() / 2 - c.x * s, canvas.getHeight() / 2 - c.y * s])
    canvas.renderAll()
    const d = devicePixelRatio
    const pixel = canvas.getContext().getImageData(canvas.getWidth() / 2 * d, canvas.getHeight() / 2 * d, 1, 1).data
    return { alpha: pixel[3], canvasPx: `${canvas.lowerCanvasEl.width}x${canvas.lowerCanvasEl.height}` }
  })
  await context.close()
  return { dpr, setup, columnsBefore, grown, rows, probe }
}

if (args.debug) { const n = generateNote(); console.log(JSON.stringify(n.objects.filter((o) => o.type === 'Path')[0]).slice(0, 400)) }
const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const baseUrl = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
const content = generateNote()
let worst = 0
try {
  for (const dpr of dprs) {
    const result = await runDpr(browser, baseUrl, dpr, content)
    console.log(`\n== devicePixelRatio ${dpr}: ${result.setup.objects} objects, ${result.setup.pages} pages, canvas ${result.setup.canvasPx}px ==`)
    console.table(result.rows)
    console.log(`page growth: ${result.columnsBefore} -> ${result.grown.columns} columns, canvas stayed ${result.grown.canvasPx}px`)
    console.log(`zoom 4x probe: canvas ${result.probe.canvasPx}px, pixel alpha at object centre ${result.probe.alpha} (${result.probe.alpha > 0 ? 'painted' : 'BLANK'})`)
    for (const row of result.rows) worst = Math.max(worst, row.p95)
    if (result.probe.alpha === 0) process.exitCode = 1
  }
} finally {
  await browser.close()
  await server.close()
}
if (maxP95 && worst > maxP95) {
  console.error(`worst p95 frame ${worst}ms exceeds --max-p95=${maxP95}`)
  process.exitCode = 1
}
