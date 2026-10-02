// F-035 checks (phones, touch and the Apple Pencil), in the real app on Leafer (Vite dev server on port 4811, mocked in-memory /api,
// headless Chromium with touch emulation at 390 px and 768 px wide; pen input through the DevTools protocol with pointerType 'pen').
//   - a finger selects, moves and resizes objects; a mouse drag in the same touch-emulated context does too (the reported bug)
//   - a finger on empty paper pans, two fingers pinch; text and stickies are placed by a tap
//   - ink by finger; with a pen in use, the pen draws and a finger pans (palm rejection)
//   - the text editor stays above the on-screen keyboard
//   - the dock and the speak/draw/connect buttons are reachable and big enough at phone widths
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-phone.mjs
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const PORT = 4811
const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'pn-shots-')) // a folder of this run's own
fs.mkdirSync(SHOTS, { recursive: true })
const now = new Date().toISOString()
const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/documents/app-all-tools.json', import.meta.url), 'utf8'))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

let stored
let puts = []
const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4819' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

async function mock(page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    const summary = { id: 1, resourceId: 'r1', revision: stored.revision, noteType: 'canvas', title: 'Phone', notebookId: 1, createdAt: now, updatedAt: now }
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary])
    if (p === '/changes') return json({ sequence: 1, changes: [], agents: [] })
    if (p === '/notes/1' && req.method() === 'GET') return json({ ...summary, content: stored.content, pageState: stored.pageState })
    if (p === '/notes/1' && req.method() === 'PUT') {
      const body = JSON.parse(req.postData())
      puts.push(body)
      stored = { content: body.content, pageState: body.pageState, revision: stored.revision + 1 }
      return json({ revision: stored.revision, resourceId: 'r1' })
    }
    return json({})
  })
}

const live = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))
const steps = (page) => page.evaluate(() => window.__personalNote.leaferEdits.stats().undoSteps)
const objectOf = (doc, id) => doc.objects.find((object) => object.id === id)
const nextFrame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const view = (page) => page.evaluate(() => { const { getCanvasScale } = window.__personalNote; const world = window.__personalNote.leaferCanvas().leafer.children[1]; return { x: world.x, y: world.y, scale: world.scaleX, app: getCanvasScale() } })
const selection = (page) => page.evaluate(() => window.__personalNote.leaferCanvas().selection())
async function centre(page, id) {
  return page.evaluate((target) => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); const b = window.__personalNote.leaferCanvas().screenBox(target); return { x: r.left + b.x + b.width / 2, y: r.top + b.y + b.height / 2, left: r.left + b.x, top: r.top + b.y, width: b.width, height: b.height } }, id)
}

// A spot on screen that is bare paper (nothing within `clear` px of it, on a page), away from the dock and the edges.
const bareSpot = (page, clear = 30) => page.evaluate((reach) => {
  const scene = window.__personalNote.leaferCanvas()
  const r = document.querySelector('#leafer-host').getBoundingClientRect()
  const w = scene.leafer.children[1]
  for (let sy = 110; sy < innerHeight - 170; sy += 12) for (let sx = 40; sx < innerWidth - 60; sx += 12) {
    const px = (sx - r.left - w.x) / w.scaleX
    const py = (sy - r.top - w.y) / w.scaleX
    if (px < 20 || py < 20 || px > 840 || py > 1080) continue
    if (scene.touchHit(sx, sy, { slop: reach }) === 'empty') return { x: sx, y: sy }
  }
  return null
}, clear)

// ---- input through the DevTools protocol
const finger = (cdp) => ({
  down: (...points) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id, force: 0.5 })) }),
  move: (...points) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id, force: 0.5 })) }),
  up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
})
const pen = (cdp) => ({
  down: (p) => cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 }),
  move: (p) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 1, pointerType: 'pen', force: 0.5 }),
  up: (p) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 }),
})
const mouse = (cdp) => ({
  down: (p) => cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }),
  move: (p) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 1, pointerType: 'mouse' }),
  up: (p) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }),
})
async function drag(page, device, from, to, count = 8) {
  await device.down(from)
  for (let i = 1; i <= count; i += 1) { await device.move({ x: from.x + ((to.x - from.x) * i) / count, y: from.y + ((to.y - from.y) * i) / count }); await nextFrame(page) }
  await device.up(to)
  await nextFrame(page)
  await page.waitForTimeout(60)
}
async function tap(page, device, p) { await device.down(p); await page.waitForTimeout(30); await device.up(p); await nextFrame(page); await page.waitForTimeout(60) }

async function openPhone(width, height) {
  stored = { content: structuredClone(fixture.content), pageState: fixture.pageState, revision: 1 }
  puts = []
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  if (process.env.DEBUG_PHONE) page.on('console', (message) => console.log('console:', message.text().slice(0, 600)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await mock(page)
  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(500)
  const cdp = await context.newCDPSession(page)
  return { context, page, cdp, errors }
}

try {
  for (const [width, height] of [[390, 844], [768, 1024]]) {
    const tag = `${width}px`
    const { context, page, cdp, errors } = await openPhone(width, height)
    page.setDefaultTimeout(8000)
    const touch = finger(cdp)
    const doc0 = await live(page)
    const A = doc0.objects.filter((o) => o.type === 'sticky')[0].id
    const B = doc0.objects.filter((o) => o.type === 'text')[0].id
    await page.screenshot({ path: `${SHOTS}/${tag}-open.png` })

    // ---- select, move, resize by finger
    await page.evaluate(() => window.__personalNote.setTool('select'))
    let c = await centre(page, A)
    await tap(page, touch, c)
    check(`${tag}: a finger tap selects a sticky`, (await selection(page)).includes(A), JSON.stringify(await selection(page)))
    const v = await view(page)
    const stepsBefore = await steps(page)
    const g0 = objectOf(await live(page), A).geometry
    c = await centre(page, A)
    await drag(page, touch, c, { x: c.x + 40, y: c.y + 30 })
    const g1 = objectOf(await live(page), A).geometry
    check(`${tag}: a finger drag moves the selected sticky by the distance dragged`, Math.abs(g1.x - g0.x - 40 / v.scale) < 3 && Math.abs(g1.y - g0.y - 30 / v.scale) < 3, JSON.stringify([g0.x, g0.y, g1.x, g1.y, v.scale]))
    check(`${tag}: the finger move is one undo step`, (await steps(page)) === stepsBefore + 1, `${stepsBefore} -> ${await steps(page)}`)

    const m = mouse(cdp)
    const g2 = objectOf(await live(page), A).geometry
    await tap(page, m, await centre(page, A))
    c = await centre(page, A)
    await drag(page, m, c, { x: c.x - 30, y: c.y - 20 })
    const g3 = objectOf(await live(page), A).geometry
    check(`${tag}: a mouse drag in the touch-emulated context moves the sticky too`, Math.abs(g3.x - g2.x + 30 / v.scale) < 3 && Math.abs(g3.y - g2.y + 20 / v.scale) < 3, JSON.stringify([g2.x, g2.y, g3.x, g3.y]))

    // resize by a corner handle: a finger lands a little off the exact corner
    await tap(page, touch, await centre(page, A))
    {
      const b = await centre(page, A)
      const before = objectOf(await live(page), A).geometry
      await drag(page, touch, { x: b.left + b.width + 6, y: b.top + b.height + 6 }, { x: b.left + b.width + 6 + 40, y: b.top + b.height + 6 + 40 })
      const after = objectOf(await live(page), A).geometry
      check(`${tag}: a finger 6 px off a corner handle resizes`, after.width > before.width + 5, JSON.stringify([before.width, after.width]))
    }
    await page.screenshot({ path: `${SHOTS}/${tag}-select.png` })

    // two finger resizes and a move in a row on one sticky: every lift reaches the editor, so nothing sticks and nothing throws
    {
      await page.evaluate(() => { window.__personalNote.leaferCanvas().clearSelection(); window.__personalNote.setTool('select') })
      await tap(page, touch, await centre(page, A))
      const errorsBefore = errors.length
      for (const [dx, dy] of [[24, 18], [20, 14]]) {
        const b = await centre(page, A)
        const before = objectOf(await live(page), A).geometry
        await drag(page, touch, { x: b.left + b.width + 4, y: b.top + b.height + 4 }, { x: b.left + b.width + 4 + dx, y: b.top + b.height + 4 + dy })
        const after = objectOf(await live(page), A).geometry
        check(`${tag}: consecutive finger resize grows by about the drag (${dx},${dy})`, Math.abs(after.width - before.width - dx / v.scale) < 4, JSON.stringify([before.width, after.width, dx / v.scale]))
      }
      const b = await centre(page, A)
      const g = objectOf(await live(page), A).geometry
      await drag(page, touch, { x: b.x, y: b.y }, { x: b.x - 20, y: b.y - 16 })
      const g2 = objectOf(await live(page), A).geometry
      check(`${tag}: and a move after them moves by the drag`, Math.abs(g2.x - g.x + 20 / v.scale) < 3 && Math.abs(g2.y - g.y + 16 / v.scale) < 3, JSON.stringify([g.x, g2.x]))
      check(`${tag}: with no errors from the editor`, errors.length === errorsBefore, errors.slice(errorsBefore).join(' | ').slice(0, 300))
    }

    // ---- pan and pinch
    await page.evaluate(() => { window.__personalNote.leaferCanvas().clearSelection(); window.__personalNote.setTool('select') })
    {
      await page.evaluate(() => { const n = window.__personalNote; n.state.canvasZoom = 2; n.setCanvasViewportOffset(-200, -300) }) // zoomed in, so the view has room to move
      await page.waitForTimeout(150)
      const v0 = await view(page)
      const stepsPan = await steps(page)
      const emptyAt = await page.evaluate(() => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); const w = window.__personalNote.leaferCanvas().leafer.children[1]; return { x: r.left + w.x + 20 * w.scaleX, y: r.top + w.y + 1150 * w.scaleX } })
      void emptyAt
      const spot = await bareSpot(page)
      if (process.env.DEBUG_PHONE) console.log('spot', JSON.stringify(spot), await page.evaluate(([x, y]) => [window.__personalNote.leaferCanvas().touchHit(x, y), window.__personalNote.state.tool, innerWidth], [spot.x, spot.y]))
      await drag(page, touch, spot, { x: spot.x - 30, y: spot.y + 25 })
      const v1 = await view(page)
      check(`${tag}: one finger dragged over empty paper pans the view`, Math.abs(v1.x - v0.x) + Math.abs(v1.y - v0.y) > 15, JSON.stringify([v0, v1]))
      check(`${tag}: and selects nothing and records nothing`, (await selection(page)).length === 0 && (await steps(page)) === stepsPan, JSON.stringify([await selection(page), stepsPan, await steps(page)]))
      const z0 = (await view(page)).scale
      const cx = width / 2
      const cy = height / 2
      await touch.down({ x: cx - 40, y: cy }, { x: cx + 40, y: cy })
      for (let i = 1; i <= 6; i += 1) { await touch.move({ x: cx - 40 - i * 10, y: cy }, { x: cx + 40 + i * 10, y: cy }); await nextFrame(page) }
      await touch.up()
      await nextFrame(page)
      const z1 = (await view(page)).scale
      check(`${tag}: two fingers pinch to zoom`, z1 > z0 * 1.2, `${z0} -> ${z1}`)
      check(`${tag}: the pinch moved no object and recorded no step`, (await steps(page)) === stepsPan)
    }

    // ---- a tap places text and a sticky
    {
      await page.evaluate(() => { window.__personalNote.leaferCanvas().clearSelection(); window.__personalNote.setTool('select') })
      const spot = await bareSpot(page, 70)
      await page.evaluate(() => window.__personalNote.setTool('sticky'))
      if (process.env.DEBUG_PHONE) await page.evaluate(() => { window.__ev = []; for (const t of ['pointerdown', 'pointerup', 'click', 'mousedown', 'touchstart', 'touchend']) window.addEventListener(t, (e) => console.log('EV', t, e.pointerType || '', e.target.className || e.target.tagName, e.target.id, e.clientX, e.clientY, e.defaultPrevented), true) })
      const objectsBefore = (await live(page)).objects.length
      await tap(page, touch, spot)
      await page.waitForTimeout(150)
      check(`${tag}: a tap with the Sticky tool makes a sticky and opens the keyboard on it`, (await live(page)).objects.length === objectsBefore + 1 && (await page.evaluate(() => document.activeElement?.classList.contains('leafer-text-editor'))), `${(await live(page)).objects.length} vs ${objectsBefore}`)
      check(`${tag}: page zoom is locked while the text editor is open`, (await page.getAttribute('meta[name="viewport"]', 'content')).includes('maximum-scale=1'))
      await page.keyboard.type('by finger')
      await page.evaluate(() => window.__personalNote.leaferCanvas().finishTextEdit())
      check(`${tag}: and allowed again when it closes`, !(await page.getAttribute('meta[name="viewport"]', 'content')).includes('maximum-scale'))
      check(`${tag}: the sticky holds what was typed`, (await live(page)).objects.some((o) => o.type === 'sticky' && o.content === 'by finger'))
      await page.evaluate(() => window.__personalNote.setTool('text'))
      await page.evaluate(() => window.__personalNote.leaferCanvas().clearSelection())
      const spot2 = (await bareSpot(page, 40)) ?? (await bareSpot(page, 25)) ?? (await bareSpot(page, 12))
      await tap(page, touch, spot2)
      await page.waitForTimeout(150)
      check(`${tag}: a tap with the Text tool opens the editor`, await page.evaluate(() => document.activeElement?.classList.contains('leafer-text-editor')))
      await page.keyboard.type('phone text')
      if (process.env.DEBUG_PHONE) console.log('EDITOR', await page.evaluate(() => [document.querySelector('.leafer-text-editor')?.value, document.activeElement?.tagName]))
      await page.evaluate(() => window.__personalNote.leaferCanvas().finishTextEdit())
      check(`${tag}: the text holds what was typed`, (await live(page)).objects.some((o) => o.type === 'text' && o.content === 'phone text'), JSON.stringify([spot2, (await live(page)).objects.filter((o) => o.type === 'text').map((o) => o.content)]))
    }

    // ---- ink by finger, then the pen with a finger panning (palm rejection)
    {
      await page.evaluate(() => { const n = window.__personalNote; n.leaferCanvas().clearSelection(); n.state.canvasZoom = 1; n.setCanvasViewportOffset(20, 110); n.setTool('pen') })
      await page.waitForTimeout(150)
      const inks = async () => (await live(page)).objects.filter((o) => o.type === 'ink').length
      const inkBefore = await inks()
      const start = await bareSpot(page, 20)
      const stroke = (d) => [0, 1, 2, 3, 4, 5].map((i) => ({ x: start.x + i * 8 * d, y: start.y + Math.sin(i) * 6 }))
      const draw = async (device, points) => { await device.down(points[0]); for (const q of points.slice(1)) { await device.move(q); await nextFrame(page) } await device.up(points.at(-1)); await nextFrame(page); await page.waitForTimeout(80) }
      await draw(touch, stroke(1))
      check(`${tag}: before a pen is used, a finger draws`, (await inks()) === inkBefore + 1, `${inkBefore} -> ${await inks()}`)
      const p = pen(cdp)
      const penDevice = { down: p.down, move: p.move, up: p.up }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y - 30, button: 'none', buttons: 0, pointerType: 'pen' }) // a pen only hovering
      await draw(touch, stroke(1))
      check(`${tag}: a hovering pen does not stop a finger drawing`, (await inks()) === inkBefore + 2, `${inkBefore} -> ${await inks()}`)
      await draw(penDevice, stroke(-1))
      check(`${tag}: the pen draws`, (await inks()) === inkBefore + 3, `${inkBefore} -> ${await inks()}`)
      const v0 = await view(page)
      await draw(touch, stroke(1))
      check(`${tag}: once a pen has touched, a finger draws nothing`, (await inks()) === inkBefore + 3, `${inkBefore} -> ${await inks()}`)
      // a finger drag pans while the pen tool is on (the view has room: zoom in)
      await page.evaluate(() => { const n = window.__personalNote; n.state.canvasZoom = 2; n.setCanvasViewportOffset(-300, -300) })
      await page.waitForTimeout(150)
      const v1 = await view(page)
      await drag(page, touch, { x: width / 2, y: height / 2 }, { x: width / 2 - 40, y: height / 2 - 30 })
      const v2 = await view(page)
      check(`${tag}: a finger pans the view while the pen tool is on and a pen is in use`, Math.abs(v2.x - v1.x) + Math.abs(v2.y - v1.y) > 20 && (await inks()) === inkBefore + 3, JSON.stringify([v1.x, v1.y, v2.x, v2.y]))
      // the pen draws while a finger is down on the paper (a resting hand)
      await touch.down({ x: 60, y: height - 260 })
      await draw(penDevice, stroke(1).map((q) => ({ x: q.x, y: q.y + 20 })))
      await touch.up()
      check(`${tag}: the pen draws while a finger rests on the screen`, (await inks()) === inkBefore + 4, `${inkBefore} -> ${await inks()}`)
      // tapping the Draw tool with a finger says a finger is drawing now
      await page.evaluate(() => { const n = window.__personalNote; n.state.canvasZoom = 1; n.setCanvasViewportOffset(20, 110) })
      await page.waitForTimeout(100)
      const again = await bareSpot(page, 20)
      const strokeAgain = [0, 1, 2, 3, 4, 5].map((i) => ({ x: again.x + i * 8, y: again.y + Math.sin(i) * 6 }))
      const drawButton = width <= 560 ? '#mobile-draw' : '[data-tool="pen"]'
      if (width <= 560) { await page.tap(drawButton); await page.tap(drawButton) } else { await page.evaluate(() => window.__personalNote.setTool('select')); await page.tap(drawButton) }
      await draw(touch, strokeAgain)
      check(`${tag}: tapping the Draw tool with a finger lets a finger draw at once`, (await inks()) === inkBefore + 5, `${inkBefore} -> ${await inks()}`)
      // and with no pen input for ten seconds a finger draws again
      await draw(penDevice, stroke(-1).map((q) => ({ x: q.x, y: q.y + 40 })))
      const afterPen = await inks()
      await draw(touch, strokeAgain.map((q) => ({ x: q.x, y: q.y + 60 })))
      check(`${tag}: right after a pen a finger still draws nothing`, (await inks()) === afterPen, `${afterPen} -> ${await inks()}`)
      await page.waitForTimeout(10500)
      await draw(touch, strokeAgain.map((q) => ({ x: q.x, y: q.y + 80 })))
      check(`${tag}: ten seconds after the last pen input a finger draws again`, (await inks()) === afterPen + 1, `${afterPen} -> ${await inks()}`)
      void v0
      await page.evaluate(() => window.__personalNote.setTool('select'))
    }

    // ---- the keyboard: the editor stays above it
    {
      await page.evaluate(() => { const n = window.__personalNote; n.leaferCanvas().clearSelection(); n.state.canvasZoom = 1.2; n.setCanvasViewportOffset(20, 40); n.setTool('text') })
      await page.waitForTimeout(150)
      const low = await page.evaluate(() => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: 60, y: Math.round(innerHeight * 0.72) + r.top * 0 } })
      await tap(page, touch, low)
      await page.waitForSelector('.leafer-text-editor')
      await page.keyboard.type('line one')
      // the on-screen keyboard takes the lower half of the window
      await page.setViewportSize({ width, height: Math.round(height * 0.5) })
      await page.waitForTimeout(500)
      const area = await page.evaluate(() => { const r = document.querySelector('.leafer-text-editor').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: window.visualViewport.height + window.visualViewport.offsetTop } })
      check(`${tag}: the text being typed stays above the on-screen keyboard`, area.bottom <= area.vh - 4 && area.top >= 0, JSON.stringify(area))
      await page.setViewportSize({ width, height })
      await page.waitForTimeout(300)
      await page.evaluate(() => window.__personalNote.leaferCanvas().finishTextEdit())
      await page.evaluate(() => window.__personalNote.setTool('select'))
    }

    // ---- the controls
    {
      const boxes = await page.evaluate(() => [...document.querySelectorAll('.tool-dock .tool-button, .tool-dock .voice-button, .mobile-capture-controls button')].filter((b) => b.offsetParent && getComputedStyle(b).visibility !== 'hidden').map((b) => { const r = b.getBoundingClientRect(); return { id: b.id || b.dataset.tool || b.className, x: r.left, y: r.top, w: r.width, h: r.height } }))
      const inside = boxes.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= width + 0.5 && b.y + b.h <= height + 0.5)
      const big = boxes.filter((b) => b.w < 38 || b.h < 38)
      check(`${tag}: every visible dock and phone button is on screen`, inside && boxes.length > 3, JSON.stringify(boxes.filter((b) => b.x < 0 || b.x + b.w > width)))
      check(`${tag}: and big enough for a finger (38 px or more)`, big.length === 0, JSON.stringify(big))
      if (width <= 560) {
        await page.evaluate(() => window.__personalNote.setTool('text'))
        await page.tap('#mobile-select')
        check(`${tag}: the phone Select button turns the Select tool on`, (await page.evaluate(() => window.__personalNote.state.tool)) === 'select' && (await page.getAttribute('#mobile-select', 'aria-pressed')) === 'true', JSON.stringify([await page.evaluate(() => window.__personalNote.state.tool), await page.getAttribute('#mobile-select', 'aria-pressed')]))
        await page.tap('#mobile-sticky')
        check(`${tag}: the phone Sticky button turns the Sticky tool on`, (await page.evaluate(() => window.__personalNote.state.tool)) === 'sticky')
        await page.tap('#mobile-sticky')
      }
      const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      let collide = []
      for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) if (overlap(boxes[i], boxes[j])) collide.push([boxes[i].id, boxes[j].id])
      check(`${tag}: no two buttons overlap`, collide.length === 0, JSON.stringify(collide))
    }
    await page.screenshot({ path: `${SHOTS}/${tag}-after.png` })

    await context.close()
    check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '))
  }
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
