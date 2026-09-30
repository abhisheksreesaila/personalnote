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
import { connectorBox, connectorEndpoints } from '../src/modules/editor/connectors.js'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=')
  return [key, value]
}))
const dprs = args.dpr ? [Number(args.dpr)] : [1, 2]
// Default gate: p95 frame under 25ms at dpr 1. dpr 2 is software-rendered a 4x larger
// surface, so it is only gated when --max-p95 is passed explicitly.
const explicitMaxP95 = args['max-p95'] ? Number(args['max-p95']) : null
const DEFAULT_MAX_P95 = 25
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
  const rects = []
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
    const width = 120 + random() * 160
    const height = 80 + random() * 120
    rects.push({ left: x, top: y, width, height })
    objects.push({
      type: 'Rect', version: '7.4.0', semanticId: `res_rect_${i}`, originX: 'left', originY: 'top', left: x, top: y, width, height,
      fill: 'rgba(80,120,200,0.15)', stroke: '#4a6fb0', strokeWidth: 2, rx: 6, ry: 6,
    })
  }
  // Connector scenario: rect 3 (the one the drag scenarios move) carries several arrows, and
  // 40 more link other rects. Geometry is recomputed from the endpoints on load.
  const links = [[3, 4], [3, 5], [6, 3], [3, 7], [8, 3], [3, 9]]
  for (let i = 10; i < 50; i += 1) links.push([i, i + 1])
  // Saved geometry is real (edge to edge), so the fixture loads exactly as a saved note would.
  if (!args['no-connectors']) links.forEach(([from, to], index) => {
    const ends = connectorEndpoints(rects[from], rects[to])
    if (!ends.visible) return
    const box = connectorBox(ends.start, ends.end)
    objects.push({
      type: 'Connector', version: '7.4.0', semanticId: `res_conn_${index}`, fromId: `res_rect_${from}`, toId: `res_rect_${to}`,
      originX: 'center', originY: 'center', left: box.left + box.width / 2, top: box.top + box.height / 2, width: box.width, height: box.height,
      reverseX: box.reverseX, reverseY: box.reverseY, fill: null, strokeWidth: 0, lineWidth: 2.6, color: '#223',
    })
  })
  return { version: '7.4.0', objects }
}

// Arrows of the dragged rect must still touch it (within the gap) after the drag.
const connectorsAttached = (page) => page.evaluate(() => {
  const { canvas } = window.__personalNote
  const rect = canvas.getObjects().filter((o) => o.type === 'rect')[3]
  const box = rect.getBoundingRect()
  const gaps = canvas.getObjects().filter((o) => o.type === 'connector' && o.visible && (o.fromId === rect.semanticId || o.toId === rect.semanticId)).map((c) => {
    const { start, end } = c.endpoints()
    const p = c.fromId === rect.semanticId ? start : end
    return Math.max(box.left - p.x, p.x - (box.left + box.width), box.top - p.y, p.y - (box.top + box.height))
  })
  return { count: gaps.length, worst: gaps.length ? Math.max(...gaps) : 0 }
})

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
    window.__cols = []
    let last = performance.now()
    const tick = (time) => { window.__frames.push(time - last); window.__cols.push(window.__personalNote.state.pages.columns); last = time; window.__loop = requestAnimationFrame(tick) }
    window.__loop = requestAnimationFrame(tick)
  })
  const moved = await run()
  const { frames, cols } = await page.evaluate(() => { cancelAnimationFrame(window.__loop); return { frames: window.__frames.slice(2), cols: window.__cols.slice(2) } })
  if (args.debug) {
    const slow = frames.map((f, i) => [i, +f.toFixed(0), cols[i]]).filter(([, f]) => f > 25)
    console.log(name, 'slow frames [index, ms, columns]:', JSON.stringify(slow))
  }
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
  if (args.debug) console.log('costs ms', await page.evaluate(() => { const n = window.__personalNote; const time = (fn) => { const t = performance.now(); fn(); return +(performance.now() - t).toFixed(0) }; return JSON.stringify({ bounds: time(() => n.getContentBounds()), reconcile: time(() => n.reconcilePages(true)), snapshot: time(() => n.snapshot()) }) }))
  if (args.debug) console.log('toJSON ms', await page.evaluate(() => { const t = performance.now(); JSON.stringify(window.__personalNote.canvas.toJSON()); return +(performance.now() - t).toFixed(0) }))
  if (args.debug) await page.evaluate(() => {
    window.__loaf = []
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.duration > 60) window.__loaf.push({ t: Math.round(e.startTime), d: Math.round(e.duration), render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0), scripts: e.scripts.map((sc) => `${sc.invoker}:${sc.sourceFunctionName}:${Math.round(sc.duration)}`) }) }).observe({ type: 'long-animation-frame', buffered: false })
  })
  const rows = []
  if (args.debug) await measure(page, 'idle 3s', () => page.waitForTimeout(3000))
  rows.push(await measure(page, 'drag inside note (6 connectors follow)', () => dragScenario(page, 3, 2, 90)))
  const attached = await connectorsAttached(page)
  if (!args['no-connectors'] && (!attached.count || attached.worst > 8)) { console.error(`connectors did not follow the drag: ${JSON.stringify(attached)}`); process.exitCode = 1 }
  // Push an object across the grid's right edge so pages grow while dragging.
  await page.evaluate(() => {
    const { canvas, state } = window.__personalNote
    const rect = canvas.getObjects().filter((o) => o.type === 'rect')[3]
    rect.set({ left: state.pages.columns * 860 - 200, top: 300 })
    rect.setCoords()
  })
  const columnsBefore = await page.evaluate(() => window.__personalNote.state.pages.columns)
  rows.push(await measure(page, 'drag across page edge (grow)', () => dragScenario(page, 8, 0, 90)))
  const attachedGrown = await connectorsAttached(page)
  if (!args['no-connectors'] && (!attachedGrown.count || attachedGrown.worst > 8)) { console.error(`connectors did not follow the growing drag: ${JSON.stringify(attachedGrown)}`); process.exitCode = 1 }
  if (args.debug) console.log('after grow drag', await page.evaluate(() => { const { canvas, state } = window.__personalNote; const r = canvas.getObjects().filter((o) => o.type === 'rect')[3]; return JSON.stringify({ pages: state.pages, left: r.left, right: r.getBoundingRect().left + r.getBoundingRect().width, tool: state.tool }) }))
  const grown = await page.evaluate(() => ({
    columns: window.__personalNote.state.pages.columns,
    canvasPx: `${window.__personalNote.canvas.lowerCanvasEl.width}x${window.__personalNote.canvas.lowerCanvasEl.height}`,
  }))
  rows.push(await measure(page, 'pan (wheel)', async () => {
    await page.mouse.move(700, 450)
    for (let i = 0; i < 120; i += 1) { await page.mouse.wheel(i < 60 ? 6 : -6, i < 60 ? 24 : -24); await nextFrame(page) }
  }))
  if (args.debug) console.log('LOAF', JSON.stringify(await page.evaluate(() => window.__loaf)))
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

// Objects must keep their on-screen position while pages are prepended and folded back.
async function checkPositionStability(browser, baseUrl) {
  const small = { version: '7.4.0', objects: [
    { type: 'Rect', version: '7.4.0', originX: 'left', originY: 'top', left: 400, top: 300, width: 160, height: 100, fill: 'rgba(80,120,200,.3)', stroke: '#4a6fb0', strokeWidth: 2 },
    { type: 'Rect', version: '7.4.0', originX: 'left', originY: 'top', left: 60, top: 300, width: 160, height: 100, fill: 'rgba(200,120,80,.3)', stroke: '#b06f4a', strokeWidth: 2 },
  ] }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/notebooks') return json(notebooks)
    if (path === '/notes') return json([summary])
    if (path === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, content: small, pageState: { columns: 1, rows: 1 } })
    return json({ ...summary, revision: 2 })
  })
  await page.goto(new URL('notes', baseUrl).href)
  await page.waitForFunction(() => window.__personalNote?.canvas.getObjects().length > 0)
  await page.waitForTimeout(600)
  const screenOf = (index) => page.evaluate((i) => {
    const { canvas } = window.__personalNote
    const c = canvas.getObjects()[i].getCenterPoint()
    const v = canvas.viewportTransform
    return { x: c.x * v[0] + v[4], y: c.y * v[3] + v[5] }
  }, index)
  const columns = () => page.evaluate(() => window.__personalNote.state.pages.columns)
  const failures = []
  const expectSame = (label, a, b) => {
    if (Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1) failures.push(`${label}: moved from ${a.x.toFixed(1)},${a.y.toFixed(1)} to ${b.x.toFixed(1)},${b.y.toFixed(1)}`)
  }
  await page.evaluate(() => window.__personalNote.setTool('select'))
  const anchorBefore = await screenOf(0)
  const start = await page.evaluate(() => {
    const { canvas } = window.__personalNote
    const c = canvas.getObjects()[1].getCenterPoint()
    const v = canvas.viewportTransform
    const box = canvas.upperCanvasEl.getBoundingClientRect()
    return { x: box.left + c.x * v[0] + v[4], y: box.top + c.y * v[3] + v[5] }
  })
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (let i = 1; i <= 20; i += 1) { await page.mouse.move(start.x - i * 8, start.y); await page.waitForTimeout(16) }
  await page.mouse.up()
  await page.waitForTimeout(900)
  if ((await columns()) !== 2) failures.push(`expected a prepended page (2 columns), got ${await columns()}`)
  expectSame('stationary object after page prepend', anchorBefore, await screenOf(0))
  const draggedAfterPrepend = await screenOf(1)
  // Move the dragged object away from the leading page so the emptied page folds back.
  await page.evaluate(() => {
    const { canvas } = window.__personalNote
    const moved = canvas.getObjects()[1]
    moved.set({ left: moved.left + 400 })
    moved.setCoords()
    canvas.fire('object:modified', { target: moved })
  })
  await page.waitForTimeout(900)
  const foldedAnchor = await screenOf(0)
  if ((await columns()) !== 1) failures.push(`expected the emptied page to fold back (1 column), got ${await columns()}`)
  expectSame('stationary object after fold-back', anchorBefore, foldedAnchor)
  await context.close()
  void draggedAfterPrepend
  return failures
}

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const baseUrl = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
const content = generateNote()
let worst = 0
let worstAny = 0
try {
  for (const dpr of dprs) {
    const result = await runDpr(browser, baseUrl, dpr, content)
    console.log(`\n== devicePixelRatio ${dpr}: ${result.setup.objects} objects, ${result.setup.pages} pages, canvas ${result.setup.canvasPx}px ==`)
    console.table(result.rows)
    console.log(`page growth: ${result.columnsBefore} -> ${result.grown.columns} columns, canvas stayed ${result.grown.canvasPx}px`)
    console.log(`zoom 4x probe: canvas ${result.probe.canvasPx}px, pixel alpha at object centre ${result.probe.alpha} (${result.probe.alpha > 0 ? 'painted' : 'BLANK'})`)
    for (const row of result.rows) {
      worstAny = Math.max(worstAny, row.p95)
      if (dpr === 1) worst = Math.max(worst, row.p95)
    }
    if (result.probe.alpha === 0) process.exitCode = 1
  }
  const stability = await checkPositionStability(browser, baseUrl)
  console.log(stability.length ? `\nposition stability: FAIL\n  ${stability.join('\n  ')}` : '\nposition stability: objects keep their on-screen position across page prepend and fold-back')
  if (stability.length) process.exitCode = 1
} finally {
  await browser.close()
  await server.close()
}
const limit = explicitMaxP95 ?? DEFAULT_MAX_P95
const measured = explicitMaxP95 ? worstAny : worst
if (measured > limit) {
  console.error(`worst p95 frame ${measured}ms exceeds the ${limit}ms limit`)
  process.exitCode = 1
}
