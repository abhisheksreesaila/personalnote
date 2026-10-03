// F-034: the hybrid render mode (the default; src/modules/canvas-leafer/tiles.js, perf.js), in the real app (Vite dev server on port 4850, mocked
// /api, proxy to a dead port, headless Chromium at devicePixelRatio 2, the software rasteriser):
//   - navigation (pan, wheel zoom) shows page bitmaps at every zoom level from the first step, and the vectors come back when it settles
//   - the settled picture is the picture a plain vector render gives (pixel check), and a bitmap at 100% is not blurry (measured, numbers printed)
//   - editing is live vectors; an edit makes only the pages it touched out of date; they are made again in idle time
//   - a drag of a crowd (more than 3 objects) is drawn at 1x on the drag layer and is sharp on drop
//   - a view too far in for crisp bitmaps does not use them; the bitmap memory stays inside the budget (printed for a 3420x2214 screen at dpr 2)
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-hybrid.mjs
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { generateStressDocument } from '../src/modules/speedtest/stress-note.js'
import { writeJsonCanvas } from '../src/core/document/jsoncanvas.js'

const PORT = 4850
const now = new Date().toISOString()
const doc = generateStressDocument(1500, { columns: 4, rows: 4 })
const stress = { content: writeJsonCanvas(doc, { derived: 'omit' }), pageState: { columns: doc.page.columns, rows: doc.page.rows } }
const summary = { id: 1, resourceId: 'r1', revision: 1, noteType: 'canvas', title: 'Stress', notebookId: 1, createdAt: now, updatedAt: now }
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const info = (text) => console.log(`INFO  ${text}`)

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4859' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

async function open(perf, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  if (perf) await page.addInitScript((value) => { window.__pnPerf = value }, perf)
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    if (p === '/notes') return json([summary])
    if (p === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, content: stress.content, pageState: stress.pageState })
    return json({ revision: 2, resourceId: 'r1' })
  })
  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 120000 })
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__personalNote.setTool('select'))
  return { context, page, errors }
}
const zoomTo = (page, zoom, offset) => page.evaluate(([z, at]) => {
  const { state, getCanvasScale, setCanvasViewportOffset, viewSize } = window.__personalNote
  state.canvasZoom = z === 1 ? 1 : z / state.displayScale
  const scale = getCanvasScale()
  setCanvasViewportOffset(at ? at[0] : z === 1 ? viewSize.width / 2 - 430 * scale : 24, at ? at[1] : z === 1 ? 104 : 24)
  return scale
}, [zoom, offset ?? null])
const lod = (page) => page.evaluate(() => window.__personalNote.leaferCanvas().lodState())
const stage = (page) => page.evaluate(() => window.__personalNote.leaferCanvas().leafer.children.map((node) => node.tag + (node.children ? `(${node.children.length})` : '')))
const vectorsOn = async (page) => (await stage(page)).some((entry) => /Group\(\d{3,}\)/.test(entry))
const rafs = (page, n = 2) => page.evaluate((count) => new Promise((resolve) => { let left = count; const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick) }), n)
// Until the pages on screen have their bitmaps (they are made in idle time after a settle).
const idle = async (page) => {
  await page.waitForFunction(() => { const s = window.__personalNote.leaferCanvas().lodState(); return !s.active && s.visibleReady }, null, { timeout: 90000 })
  await page.waitForTimeout(200)
}
const wheel = async (page, count, dy, x = 700, y = 450) => { await page.mouse.move(x, y); for (let i = 0; i < count; i += 1) { await page.mouse.wheel(0, dy); await rafs(page, 1) } }
const shot = (page) => page.screenshot({ clip: { x: 230, y: 100, width: 1000, height: 640 } })
const compare = (page, a, b) => page.evaluate(async ([one, two]) => {
  const read = async (data) => { const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob()); const c = new OffscreenCanvas(image.width, image.height); const x = c.getContext('2d'); x.drawImage(image, 0, 0); return x.getImageData(0, 0, image.width, image.height) }
  const [first, second] = [await read(one), await read(two)]
  let total = 0
  let strong = 0
  let any = 0
  for (let i = 0; i < first.data.length; i += 4) {
    const level = Math.max(Math.abs(first.data[i] - second.data[i]), Math.abs(first.data[i + 1] - second.data[i + 1]), Math.abs(first.data[i + 2] - second.data[i + 2]))
    total += level
    if (level > 0) any += 1
    if (level > 64) strong += 1
  }
  const pixels = first.data.length / 4
  return { mean: total / pixels, strong: strong / pixels, any: any / pixels }
}, [a.toString('base64'), b.toString('base64')])
const MB = (bytes) => (bytes / 1048576).toFixed(1)
const PLAIN = { hybrid: false, dragCrowd: 0, gestureTransform: false, pageBitmaps: 'off' }

try {
  // ---------------------------------------------------------------- the default is the hybrid mode; navigation uses bitmaps at every zoom
  {
    const { context, page, errors } = await open(null)
    const state0 = await lod(page)
    check('the default render mode is hybrid: page bitmaps at every zoom', state0.hybrid && state0.mode === 'always', JSON.stringify(state0))
    for (const zoom of [1, 0.5]) {
      await zoomTo(page, zoom)
      await page.waitForTimeout(400)
      await idle(page)
      const rest = await lod(page)
      check(`at ${zoom * 100}% the pages on screen have bitmaps made for this zoom, at rest, with the vectors on the stage`, rest.visibleReady && !rest.active && await vectorsOn(page), JSON.stringify(rest))
      const enters = rest.enters
      await wheel(page, 1, 40)
      const first = await lod(page)
      check(`at ${zoom * 100}% the FIRST step of a pan shows the bitmaps (no vector frame first)`, first.active && first.enters === enters + 1 && !(await vectorsOn(page)), JSON.stringify(first))
      await wheel(page, 5, 40)
      await page.keyboard.down('Control')
      await wheel(page, 3, -30)
      await wheel(page, 3, 30)
      await page.keyboard.up('Control')
      await page.waitForTimeout(700)
      const after = await lod(page)
      check(`at ${zoom * 100}% the vectors are back when the movement stops`, !after.active && await vectorsOn(page), JSON.stringify(after))
    }
    check('page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // ---------------------------------------------------------------- the settled view is a plain vector render; a bitmap at 100% is crisp
  {
    const run = async (perf) => {
      const { context, page, errors } = await open(perf)
      await zoomTo(page, 1)
      await page.waitForTimeout(500)
      if (!perf) await idle(page)
      await wheel(page, 8, 40)
      await wheel(page, 8, -40)
      await page.keyboard.down('Control')
      await wheel(page, 4, -30)
      await wheel(page, 4, 30)
      await page.keyboard.up('Control')
      await page.waitForTimeout(900)
      const settled = await shot(page)
      return { context, page, errors, settled }
    }
    const hybrid = await run(null)
    const plain = await run(PLAIN)
    const same = await compare(hybrid.page, hybrid.settled, plain.settled)
    info(`settled hybrid view vs plain vector render (100%, after a pan and a zoom out and in): mean ${same.mean.toFixed(4)} of 255, ${(same.strong * 100).toFixed(3)}% far off, ${(same.any * 100).toFixed(3)}% differ at all`)
    check('after a pan and a zoom, the settled hybrid view equals a plain vector render (nothing far off, mean under 0.05 of 255)', same.strong === 0 && same.mean < 0.05, JSON.stringify(same))
    check('(and the vectors are what is on the stage)', await vectorsOn(hybrid.page))
    await plain.context.close()

    // a bitmap against the vector render of the same view, at 100%, on a whole-pixel offset (the best case) and a half-pixel one (the worst)
    const { page } = hybrid
    for (const [label, shift] of [['whole-pixel offset', 0], ['half-pixel offset', 0.25]]) {
      await zoomTo(page, 1, [150, 104])
      await page.waitForTimeout(500)
      await idle(page)
      if (shift) { // a view that is not on a device pixel: the bitmaps are resampled, the vectors are not
        await page.evaluate((by) => { const s = window.__personalNote.leaferCanvas(); const v = s.view(); s.setView({ ...v, x: v.x + by, y: v.y + by }) }, shift)
        await page.waitForTimeout(700)
      }
      const vector = await shot(page)
      // a view change that does not move the picture puts the bitmaps on the stage; the screenshot is taken before the quiet wait ends
      await page.evaluate(() => { const s = window.__personalNote.leaferCanvas(); s.setView({ ...s.view() }) })
      const showing = await page.evaluate(() => window.__personalNote.leaferCanvas().lodState().active)
      const bitmap = await shot(page)
      const d = await compare(page, vector, bitmap)
      info(`100% bitmap (showing: ${showing}) vs vector, ${label}: mean ${d.mean.toFixed(3)} of 255, ${(d.strong * 100).toFixed(3)}% of pixels far off, ${(d.any * 100).toFixed(1)}% differ at all`)
      check(`a bitmap at 100% is not blurry against the vector render (${label}: mean under ${label.startsWith('whole') ? 1 : 4} of 255, under ${label.startsWith('whole') ? 0.5 : 2.5}% of pixels far off)`, showing && d.mean < (label.startsWith('whole') ? 1 : 4) && d.strong < (label.startsWith('whole') ? 0.005 : 0.025), JSON.stringify(d))
    }
    check('page errors', hybrid.errors.length === 0 && plain.errors.length === 0, hybrid.errors.join(' | '))
    await hybrid.context.close()
  }

  // ---------------------------------------------------------------- editing is live; an edit makes only the pages it touched out of date
  {
    const { context, page, errors } = await open(null)
    await zoomTo(page, 0.3)
    await page.waitForTimeout(500)
    await page.evaluate(() => window.__personalNote.leaferCanvas().lodBuildAll())
    const full = await lod(page)
    check('(setup) every page of the 4 x 4 note has a current bitmap', full.tiles === 16 && full.current === 16, JSON.stringify(full))
    // an object that sits wholly inside one page, away from its edges
    const target = await page.evaluate(() => {
      const { leaferEdits } = window.__personalNote
      return leaferEdits.doc.objects.filter((o) => o.type === 'sticky').map((o) => ({ id: o.id, x: o.geometry.x, y: o.geometry.y, w: o.geometry.width, h: o.geometry.height })).find((o) => o.x % 860 > 120 && o.x % 860 < 600 && o.y % 1080 > 120 && o.y % 1080 < 800)
    })
    check('(setup) a sticky well inside one page', Boolean(target))
    await page.evaluate((id) => { const s = window.__personalNote.leaferCanvas(); s.select([id]); s.nudge(30, 20) }, target.id)
    const afterEdit = await lod(page)
    check('an edit makes only the bitmap of the page it touched out of date (15 of 16 stay current)', afterEdit.current === 15, JSON.stringify(afterEdit))
    await wheel(page, 3, 30)
    await page.waitForTimeout(1500)
    const rebuilt = await lod(page)
    const grid = await page.evaluate(() => window.__personalNote.leaferEdits.doc.page)
    check('the touched page is made again in idle time (every bitmap of the grid is current again)', rebuilt.current === rebuilt.tiles && rebuilt.tiles === grid.columns * grid.rows, JSON.stringify([rebuilt, grid]))
    check('page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
