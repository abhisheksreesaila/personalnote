import { createServer } from 'vite'
import { chromium } from 'playwright'
import { generateStressNote } from '../src/modules/speedtest/stress-note.js'
const note = generateStressNote(5400)
const now = new Date().toISOString()
const summary = { id: 1, resourceId: 'res_bench', revision: 1, noteType: 'canvas', title: 'Benchmark note', notebookId: 1, createdAt: now, updatedAt: now }
const server = await createServer({ server: { port: 4803, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4809' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await context.newPage()
await page.route('**/api/**', async (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^\/api/, '')
  const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  if (p === '/notebooks') return json([{ id: 1, resourceId: 'res_nb', revision: 1, name: 'Bench', color: '#76669a', noteCount: 1 }])
  if (p === '/notes') return json([summary])
  if (p === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, content: note.content, pageState: note.pageState })
  return json({ revision: 2, resourceId: 'res_bench' })
})
await page.goto('http://127.0.0.1:4803/notes')
await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 120000 })
await page.waitForTimeout(5000)
await page.evaluate(() => { const { canvas, state, getCanvasScale, setCanvasViewportOffset } = window.__personalNote; state.canvasZoom = 1; setCanvasViewportOffset(canvas.getWidth() / 2 - 430 * getCanvasScale(), 104) })
await page.waitForTimeout(1500)
await page.evaluate(() => {
  const scene = window.__personalNote.leaferCanvas()
  const lay = scene.leafer.layouter
  window.__lay = []
  scene.leafer.on('layout.end', (e) => { const bl = e.blocks ?? []; window.__lay.push(['end', bl.length, bl.map((b) => b.updatedList?.length), e.times, +(performance.now()).toFixed(0)]) })
  scene.leafer.on('layout.start', () => { window.__lay.push(['start', +(performance.now()).toFixed(0)]) })
  const orig = lay.layout.bind(lay)
  lay.layout = function () { window.__stack = window.__stack || new Error().stack; const t = performance.now(); const n = lay.__updatedList?.length ?? -1; const r = orig(); window.__lay.push([n, +(performance.now() - t).toFixed(1)]); return r }
})
const objs = await page.evaluate(() => { const { leaferCanvas, leaferEdits } = window.__personalNote; const host = document.querySelector('#leafer-host').getBoundingClientRect(); const v = leaferCanvas().view(); return leaferEdits.doc.objects.filter((o) => o.type === 'sticky').map((o) => ({ x: host.left + v.x + (o.geometry.x + o.geometry.width / 2) * v.scale, y: host.top + v.y + (o.geometry.y + o.geometry.height / 2) * v.scale, w: o.geometry.width * v.scale })).filter((b) => b.x > 300 && b.x < 1300 && b.y > 120 && b.y < 700) })
await page.evaluate(() => { window.__g = []; let last = performance.now(); const tick = (t) => { window.__g.push(Math.round(t - last)); last = t; requestAnimationFrame(tick) }; requestAnimationFrame(tick) })
if (process.env.PRIME) { await page.evaluate(() => { const sc = window.__personalNote.leaferCanvas(); const id = window.__personalNote.leaferEdits.doc.objects.find((o) => o.type === 'sticky').id; sc.select([id]); sc.clearSelection() }); await page.waitForTimeout(800) }
await page.evaluate(() => { window.__g.length = 0 })
const mode = process.env.MODE ?? 'click'
if (mode === 'api') await page.evaluate(() => { const sc = window.__personalNote.leaferCanvas(); sc.select([window.__personalNote.leaferEdits.doc.objects.find((o) => o.type === 'sticky').id]) })
else if (mode === 'move') { await page.mouse.move(objs[0].x, objs[0].y); await page.mouse.move(objs[0].x + 3, objs[0].y + 3) }
else if (mode === 'none') await page.waitForTimeout(100)
else if (mode === 'empty') await page.mouse.click(1000, 150)
else await page.mouse.click(objs[0].x, objs[0].y)
await page.waitForTimeout(500)
await page.mouse.click(objs[3].x, objs[3].y)
await page.waitForTimeout(500)
console.log(await page.evaluate(() => window.__stack))
console.log('slow frames', JSON.stringify(await page.evaluate(() => window.__g.filter((v) => v > 20))))
const out = await page.evaluate(() => window.__lay)
console.log(JSON.stringify(out))
await browser.close()
await server.close()
