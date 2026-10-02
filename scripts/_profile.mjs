// scratch profiler (not committed): node scripts/_profile.mjs open|drag|zoom|pan|type [dpr] [software]
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { generateStressNote } from '../src/modules/speedtest/stress-note.js'
const what = process.argv[2] ?? 'open'
const dpr = Number(process.argv[3] ?? 1)
const software = process.argv[4] === 'software'
const note = generateStressNote(Number(process.env.COUNT ?? 5400))
const initFlag = process.env.NOLIFT ? 'window.__noLiftShadow = true' : ''
const now = new Date().toISOString()
const summary = { id: 1, resourceId: 'res_bench', revision: 1, noteType: 'canvas', title: 'Benchmark note', notebookId: 1, createdAt: now, updatedAt: now }
const server = await createServer({ server: { port: 4803, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4809' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', ...(software ? [] : ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'])] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr })
const page = await context.newPage()
await page.route('**/api/**', async (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^\/api/, '')
  const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  if (p === '/notebooks') return json([{ id: 1, resourceId: 'res_nb', revision: 1, name: 'Bench', color: '#76669a', noteCount: 1 }])
  if (p === '/notes') return json([summary])
  if (p === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, content: note.content, pageState: note.pageState })
  return json({ revision: 2, resourceId: 'res_bench' })
})
if (process.env.PERF) await page.addInitScript((v) => { window.__pnPerf = v }, JSON.parse(process.env.PERF))
if (process.env.NOLIFT) await page.addInitScript('window.__noLiftShadow = true')
const cdp = await context.newCDPSession(page)
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
if (what === 'open') {
  // warm the module cache first, so the profile is of opening the note and not of loading code
  await page.goto('http://127.0.0.1:4803/notes')
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 120000 })
  await page.waitForTimeout(1000)
  await cdp.send('Profiler.start')
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 120000 })
  await page.waitForTimeout(300)
} else {
  await page.goto('http://127.0.0.1:4803/notes')
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 120000 })
  await page.waitForTimeout(1500)
  await page.evaluate((zoomOut) => { const { canvas, state, getCanvasScale, setCanvasViewportOffset } = window.__personalNote; if (zoomOut) { state.canvasZoom = 0.3 / state.displayScale; setCanvasViewportOffset(24, 24) } else { state.canvasZoom = 1; setCanvasViewportOffset(canvas.getWidth() / 2 - 430 * getCanvasScale(), 104) } }, Boolean(process.env.ZOOMOUT))
  await page.waitForTimeout(process.env.ZOOMOUT ? 5000 : 800)
  if (process.env.PROBELAYOUT) console.log('layout pending cost', await page.evaluate(() => { const l = window.__personalNote.leaferCanvas().leafer.layouter; const t = performance.now(); l.layout(); return +(performance.now() - t).toFixed(1) }))
  await cdp.send('Profiler.start')
  await page.evaluate(() => { window.__g = []; let last = performance.now(); const tick = (t) => { window.__g.push(Math.round(t - last)); last = t; requestAnimationFrame(tick) }; requestAnimationFrame(tick) })
  if (what === 'drag') {
    const objs = await page.evaluate(() => { const { leaferCanvas, leaferEdits } = window.__personalNote; const host = document.querySelector('#leafer-host').getBoundingClientRect(); return leaferEdits.doc.objects.filter((o) => o.type === 'sticky').map((o) => { const b = leaferCanvas().screenBox(o.id); return b && { x: host.left + b.x + b.width / 2, y: host.top + b.y + b.height / 2, ok: host.left + b.x > 300 && host.top + b.y > 120 && host.left + b.x + b.width < 1300 && host.top + b.y + b.height < 700 } }).filter((b) => b && b.ok) })
    for (const t of objs.slice(0, process.argv[5] === 'first' ? 1 : 6)) {
      await page.mouse.click(t.x, t.y)
      if (process.argv[5] === 'click') { for (let i = 0; i < 20; i++) await frame(); break }
      await page.mouse.move(t.x, t.y)
      await page.mouse.down()
      for (let i = 1; i <= (process.argv[5] === 'first' ? 8 : 30); i++) { await page.mouse.move(t.x + i * 5, t.y + i * 3); await frame() }
      await page.mouse.up()
      await frame()
      await page.evaluate(() => window.__personalNote.leaferCanvas().clearSelection())
    }
  } else if (what === 'pentype') {
    await page.click('[data-tool="pen"]')
    await page.mouse.move(500, 300); await page.mouse.down()
    for (let i = 0; i < 30; i++) { await page.mouse.move(500 + i * 8, 300 + Math.sin(i / 3) * 30); await frame() }
    await page.mouse.up()
    await page.click('[data-tool="select"]')
    const id = await page.evaluate(() => window.__personalNote.leaferEdits.doc.objects.findLast((o) => o.type === 'text')?.id)
    await page.evaluate((target) => window.__personalNote.leaferCanvas().editText(target), id)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.press('Control+End')
    await page.evaluate(() => { window.__d = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__d.push([e.name, Math.round(e.startTime), Math.round(e.duration)]) }).observe({ type: 'event', durationThreshold: 16 }) })
    for (let i = 0; i < 60; i++) { await page.keyboard.type('abcdefghij'[i % 10]); await frame() }
    console.log(JSON.stringify((await page.evaluate(() => window.__d)).filter((e) => e[0] === 'keydown').slice(0, 40)))
  } else if (what === 'zoom') {
    await page.mouse.move(700, 450)
    await page.keyboard.down('Control')
    for (let i = 0; i < 120; i += 1) { await page.mouse.wheel(0, i < 60 ? -12 : 12); await frame() }
    await page.keyboard.up('Control')
  } else if (what === 'pan') {
    await page.mouse.move(700, 450)
    for (let i = 0; i < 120; i += 1) { await page.mouse.wheel(i < 60 ? 6 : -6, i < 60 ? 24 : -24); await frame() }
  }
}
if (what !== 'open') { const g = await page.evaluate(() => window.__g); console.log('frames>20ms (index:ms):', g.map((v, i) => [i, v]).filter(([, v]) => v > 20).map(([i, v]) => `${i}:${v}`).join(' ')) }
const { profile } = await cdp.send('Profiler.stop')
fs.writeFileSync(`/var/tmp/f034-${what}.cpuprofile`, JSON.stringify(profile))
await browser.close()
await server.close()
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map()
const dt = profile.timeDeltas
profile.samples.forEach((sid, i) => { const n = byId.get(sid); const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber}`; self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0)) })
console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`).join('\n'))
