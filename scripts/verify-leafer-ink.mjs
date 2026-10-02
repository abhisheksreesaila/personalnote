// F-031 checks, in the real app (Vite dev server on port 4771, mocked in-memory /api that keeps what the app saves and serves it back
// on reload, headless Chromium): the pen, the highlighter and the eraser on the Leafer canvas, driven with real (CDP) pen events with
// pressure and real mouse events. Stroke model, colours and widths, one undo step per stroke and per erase pass, the saved JSON
// Canvas, the picture after a reload against the picture before it, and (on the 600-object note) the time from pointer to frame.
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-ink.mjs
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { readJsonCanvas } from '../src/core/document/jsoncanvas.js'
import { COLUMNS, ROWS, generateNote } from './benchmark-note.mjs'

const PORT = 4771
const now = new Date().toISOString()
const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/documents/app-all-tools.json', import.meta.url), 'utf8'))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

let stored = { content: fixture.content, pageState: fixture.pageState, revision: 1 }
const puts = []
const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4779' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

async function mock(page, getNote) {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    const note = getNote()
    const summary = { id: 1, resourceId: 'r1', revision: note.revision, noteType: 'canvas', title: 'Ink', notebookId: 1, createdAt: now, updatedAt: now }
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary])
    if (p === '/notes/1' && req.method() === 'GET') return json({ ...summary, content: note.content, pageState: note.pageState })
    if (p === '/notes/1' && req.method() === 'PUT') {
      const body = JSON.parse(req.postData())
      puts.push(body)
      Object.assign(note, { content: body.content, pageState: body.pageState, revision: note.revision + 1 })
      return json({ revision: note.revision, resourceId: 'r1' })
    }
    return json({})
  })
}

const api = (page, expression, arg) => page.evaluate(`(${expression})(${JSON.stringify(arg ?? null)})`)
async function open(page) {
  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(500)
}
// a point on the page (page pixels) -> where it is on screen
const screenOf = (page, x, y) => page.evaluate(([px, py]) => {
  const view = window.__personalNote.leaferCanvas().view()
  const rect = document.querySelector('#leafer-host').getBoundingClientRect()
  return { x: rect.left + view.x + px * view.scale, y: rect.top + view.y + py * view.scale }
}, [x, y])
const nextFrame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
const inkObjects = (page) => page.evaluate(() => window.__personalNote.leaferEdits.doc.objects.filter((o) => o.type === 'ink'))
const steps = (page) => page.evaluate(() => window.__personalNote.leaferEdits.stats().undoSteps)

// pen: real pen pointer events with pressure (CDP); mouse: Playwright's. One move per frame.
async function stroke(page, cdp, points, { type = 'pen', frames = true } = {}) {
  const screen = []
  for (const point of points) screen.push(await screenOf(page, point.x, point.y))
  if (type === 'mouse') {
    await page.mouse.move(screen[0].x, screen[0].y)
    await page.mouse.down()
    for (const point of screen.slice(1)) { await page.mouse.move(point.x, point.y); if (frames) await nextFrame(page) }
    await page.mouse.up()
  } else {
    const send = (kind, point, force) => cdp.send('Input.dispatchMouseEvent', { type: kind, x: point.x, y: point.y, button: kind === 'mouseMoved' ? 'none' : 'left', buttons: kind === 'mouseReleased' ? 0 : 1, clickCount: kind === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force })
    await send('mouseMoved', screen[0], 0)
    await send('mousePressed', screen[0], 0.5)
    screen.slice(1).forEach(() => {})
    for (let i = 1; i < screen.length; i += 1) { await send('mouseMoved', screen[i], 0.3 + 0.6 * Math.sin((i / screen.length) * Math.PI)); if (frames) await nextFrame(page) }
    await send('mouseReleased', screen.at(-1), 0)
  }
  await nextFrame(page)
}
const wave = (x, y, length = 260, count = 40, amp = 30) => Array.from({ length: count + 1 }, (_, i) => ({ x: x + (length * i) / count, y: y + Math.sin((i / count) * Math.PI * 2) * amp }))
const tool = (page, name) => page.click(`[data-tool="${name}"]`)

// the pixels of one sheet region, and how many differ between two shots
async function shot(page, clip) { return page.screenshot({ clip }) }
const diff = (page, a, b) => page.evaluate(async ([one, two]) => {
  const load = async (data) => { const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob()); const c = new OffscreenCanvas(image.width, image.height); const x = c.getContext('2d'); x.drawImage(image, 0, 0); return x.getImageData(0, 0, image.width, image.height) }
  const [first, second] = await Promise.all([load(one), load(two)])
  let count = 0
  let peak = 0
  let minX = 1e9; let minY = 1e9; let maxX = -1; let maxY = -1
  for (let i = 0; i < first.data.length; i += 4) {
    let level = 0
    for (let k = 0; k < 4; k += 1) level = Math.max(level, Math.abs(first.data[i + k] - second.data[i + k]))
    if (level > 0) { count += 1; peak = Math.max(peak, level); const px = (i / 4) % first.width; const py = Math.floor(i / 4 / first.width); minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py) }
  }
  return { count, peak, box: count ? [minX, minY, maxX, maxY] : null }
}, [a.toString('base64'), b.toString('base64')])

const waitSave = async (page, before) => { for (let i = 0; i < 40 && puts.length <= before; i += 1) await page.waitForTimeout(150); await page.waitForTimeout(100); return puts.length > before }

try {
  // ---------------------------------------------------------------- the stroke model, undo, save, reload
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mock(page, () => stored)
  await open(page)
  const cdp = await context.newCDPSession(page)
  const empty = await api(page, `() => { const g = { x: 120, y: 1000, w: 640, h: 60 }; return window.__personalNote.leaferCanvas().boxes().every((b) => b.left + b.width < g.x || b.left > g.x + g.w || b.top + b.height < g.y || b.top > g.y + g.h) }`)
  check('the strip of the page used for drawing is empty', empty)
  const baseInk = (await inkObjects(page)).length
  const baseSteps = await steps(page)
  const fabricObjects = () => page.evaluate(() => window.__personalNote.canvas.getObjects().length)

  await tool(page, 'pen')
  check('the pen tool is on and its surface takes the pointer', await page.evaluate(() => window.__personalNote.state.tool === 'pen' && getComputedStyle(document.querySelector('.ink-surface')).display !== 'none'))
  await stroke(page, cdp, wave(140, 1030, 240, 40, 18))
  let ink = await inkObjects(page)
  const pen = ink.at(-1)
  check('a pen stroke is one new ink object in the document', ink.length === baseInk + 1 && pen.kind === 'stroke' && pen.tool === 'pen' && pen.cap === 'round' && pen.join === 'round', JSON.stringify(pen)?.slice(0, 200))
  const penState = await api(page, `() => ({ color: window.__personalNote.state.color, width: window.__personalNote.state.penWidth })`)
  check('it has the pen colour and width', pen.color === penState.color && pen.width === penState.width, `${pen.color} ${pen.width} vs ${JSON.stringify(penState)}`)
  check('it is one undo step and the picture has a node for it', (await steps(page)) === baseSteps + 1 && await api(page, `() => window.__personalNote.leaferCanvas().hasNode(${JSON.stringify(pen.id)})`))
  check('the Fabric canvas stays empty', (await fabricObjects()) === 0)
  const near = pen.points.length > 3 && pen.geometry.width > 200 && pen.geometry.x > 130 && pen.geometry.x < 150
  check('its geometry follows the pointer', near, JSON.stringify(pen.geometry))

  // colours and widths
  await page.evaluate(() => { const { state } = window.__personalNote; state.color = '#1c70a8'; state.penWidth = 6 })
  await stroke(page, cdp, wave(140, 1000, 240, 30, 4), { type: 'mouse' })
  ink = await inkObjects(page)
  check('another colour and width: a mouse stroke takes them', ink.at(-1).color === '#1c70a8' && ink.at(-1).width === 6 && ink.at(-1).alpha === undefined, JSON.stringify([ink.at(-1).color, ink.at(-1).width]))

  await tool(page, 'highlight')
  await page.evaluate(() => { const { state } = window.__personalNote; state.color = '#df8437'; state.highlightWidth = 20 })
  await stroke(page, cdp, [{ x: 400, y: 1030 }, { x: 460, y: 1034 }, { x: 520, y: 1030 }, { x: 600, y: 1036 }, { x: 700, y: 1030 }])
  ink = await inkObjects(page)
  const hi = ink.at(-1)
  check('the highlighter is a stroke at a third of the opacity with its own width', hi.tool === 'highlight' && hi.color === '#df8437' && Math.abs(hi.alpha - 0x55 / 255) < 1e-9 && hi.width === 20, JSON.stringify([hi.tool, hi.color, hi.alpha, hi.width]))
  const clickAt = await screenOf(page, 650, 1000)
  await page.mouse.click(clickAt.x, clickAt.y)
  await nextFrame(page)
  ink = await inkObjects(page)
  check('a tap with the highlighter is a dot', ink.at(-1).kind === 'dot' && ink.at(-1).radius === 10 && ink.at(-1).tool === 'highlight', JSON.stringify(ink.at(-1)))
  check('four marks are four undo steps', (await steps(page)) === baseSteps + 4, String(await steps(page)))

  // saved
  const putsBefore = puts.length - 1
  check('the note is saved with the ink', await waitSave(page, putsBefore))
  await page.waitForTimeout(1500) // the save of the last mark
  const saved = readJsonCanvas(puts.at(-1).content)
  const savedInk = saved.objects.filter((o) => o.type === 'ink')
  check('the saved JSON Canvas holds every mark, equal to the model', savedInk.length === ink.length && ink.every((o) => {
    const s = savedInk.find((x) => x.id === o.id)
    return s && s.kind === o.kind && s.tool === o.tool && s.color === o.color && Math.abs((s.alpha ?? 0) - (o.alpha ?? 0)) < 0.01 && Math.abs(s.geometry.x - o.geometry.x) < 0.01 && (o.kind === 'dot' || (s.width === o.width && s.path.length === o.path.length))
  }), JSON.stringify(savedInk.map((o) => [o.kind, o.tool, o.color, o.alpha, o.width, o.path?.length, o.geometry?.x])) + ' vs ' + JSON.stringify(ink.map((o) => [o.kind, o.tool, o.color, o.alpha, o.width, o.path?.length, o.geometry.x])))
  const svgOf = (id) => (puts.at(-1).content.nodes ?? []).find((n) => n.id === id)
  // The browser's encoder leaves the derived SVG out (file ''): the server writes media/<sha>.svg from the node (core/note-codec.js, ADR 0002).
  check('every mark is a file node of the JSON Canvas that carries its ink (the server derives the SVG from it)', ink.every((o) => svgOf(o.id)?.type === 'file' && svgOf(o.id).pn?.type === 'ink' && svgOf(o.id).pn.kind === o.kind), JSON.stringify(svgOf(ink.at(-1).id))?.slice(0, 300))

  // the picture: committed stroke vs the same document drawn again vs after a real reload (only where the ink is)
  await page.evaluate(() => window.__personalNote.leaferCanvas().whenSettled())
  const region = await (async () => {
    const a = await screenOf(page, 120, 990)
    const b = await screenOf(page, 780, 1070)
    return { x: Math.floor(a.x), y: Math.floor(a.y), width: Math.ceil(b.x - a.x), height: Math.ceil(b.y - a.y) }
  })()
  const committed = await shot(page, region)
  await page.evaluate(() => window.__personalNote.leaferCanvas().leafer.forceRender(undefined, true))
  await page.waitForTimeout(200)
  const forced = await shot(page, region)
  if (process.env.INK_DEBUG) { fs.writeFileSync(`${process.env.INK_DEBUG}/committed.png`, committed); fs.writeFileSync(`${process.env.INK_DEBUG}/forced.png`, forced) }
  console.log('INFO  committed vs full forced render', JSON.stringify(await diff(page, committed, forced)))
  await page.evaluate(() => window.__personalNote.leaferCanvas().load(window.__personalNote.leaferEdits.doc))
  await page.evaluate(() => window.__personalNote.leaferCanvas().whenSettled())
  const redrawn = await shot(page, region)
  let d = await diff(page, committed, redrawn)
  // Leafer paints a new node into a partial block and the same note drawn again whole; those differ by anti-aliasing at a stroke's edge
  // (the F-027 'first draw' quirk). Measured here: a few dozen edge pixels, at most 42 levels off.
  console.log('INFO  committed vs the document drawn again:', JSON.stringify(d))
  check('the stroke as committed is the same picture as the document drawn again (edge anti-aliasing noise only)', d.count <= 150 && d.peak <= 60, JSON.stringify(d))
  await page.waitForTimeout(800)
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(500)
  const reloaded = await shot(page, region)
  d = await diff(page, redrawn, reloaded)
  check('after a reload the strokes are pixel-identical to the stored-note render', d.count === 0, JSON.stringify(d))
  check('the reloaded note has the same ink', (await inkObjects(page)).length === ink.length)

  // ---------------------------------------------------------------- undo and redo
  await tool(page, 'pen')
  await stroke(page, cdp, wave(300, 1040, 120, 20, 4))
  await tool(page, 'select')
  const afterReloadSteps = await steps(page)
  const before = await inkObjects(page)
  await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  check('undo takes the last mark away (one step)', (await inkObjects(page)).length === before.length - 1 && (await steps(page)) === afterReloadSteps - 1)
  await page.evaluate(() => window.__personalNote.leaferEdits.redo())
  const redone = await inkObjects(page)
  check('redo brings it back unselected, equal to what was drawn', redone.length === before.length && JSON.stringify(redone.at(-1)) === JSON.stringify(before.at(-1)) && await api(page, `() => window.__personalNote.leaferCanvas().selection().length === 0`))

  // ---------------------------------------------------------------- the eraser
  await tool(page, 'pen')
  await page.evaluate(() => { const { state } = window.__personalNote; state.color = '#20201e'; state.penWidth = 3 })
  await stroke(page, cdp, [{ x: 140, y: 960 }, { x: 760, y: 960 }].flatMap((p, i, all) => (i ? Array.from({ length: 30 }, (_, k) => ({ x: all[0].x + ((p.x - all[0].x) * (k + 1)) / 30, y: 960 })) : [p])))
  const line = (await inkObjects(page)).at(-1)
  const stepsBefore = await steps(page)
  const countBefore = (await inkObjects(page)).length
  await tool(page, 'eraser')
  await stroke(page, cdp, [{ x: 450, y: 935 }, { x: 450, y: 960 }, { x: 450, y: 985 }], { type: 'mouse' })
  ink = await inkObjects(page)
  const pieces = ink.filter((o) => o.kind === 'stroke' && o.id !== line.id && o.geometry.y > 950 && o.geometry.y < 970 && o.width === 3)
  check('erasing across a stroke leaves two fragments and the original is gone', !ink.some((o) => o.id === line.id) && pieces.length === 2 && ink.length === countBefore + 1, `${pieces.length} pieces, ${ink.length} vs ${countBefore}`)
  check('the pass is one undo step', (await steps(page)) === stepsBefore + 1)
  check('the fragments are on screen', await api(page, `() => ${JSON.stringify(pieces.map((p) => p.id))}.every((id) => window.__personalNote.leaferCanvas().hasNode(id))`) && !(await api(page, `() => window.__personalNote.leaferCanvas().hasNode(${JSON.stringify(line.id)})`)))
  // a long sweep through several marks is still one step
  await stroke(page, cdp, Array.from({ length: 30 }, (_, k) => ({ x: 130 + k * 22, y: 1030 })), { type: 'mouse' })
  check('a sweep through several marks is one more undo step', (await steps(page)) === stepsBefore + 2)
  await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  const restored = await inkObjects(page)
  check('two undos bring the erased stroke back exactly', restored.some((o) => JSON.stringify(o) === JSON.stringify(line)) && restored.length === countBefore, String(restored.length))
  await page.evaluate(() => window.__personalNote.leaferEdits.redo())
  check('redo erases it again', !(await inkObjects(page)).some((o) => o.id === line.id))
  // a redraw from the document keeps the pictures the note was opened with (undo and redo redraw it)
  const images = await page.evaluate(() => {
    const scene = window.__personalNote.leaferCanvas()
    const doc = window.__personalNote.leaferEdits.doc
    const picture = { type: 'image', id: 'media-picture', z: 9999, geometry: { x: 10, y: 10, width: 50, height: 50, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }, mediaRef: { kind: 'media', id: 'abc' } }
    const withPicture = { ...doc, objects: [...doc.objects, picture] }
    const resolve = () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
    scene.load(doc, { resolveMedia: resolve })
    const base = scene.stats().images
    scene.load(withPicture, { resolveMedia: resolve })
    const first = scene.stats().images - base
    scene.load(withPicture) // what an undo or a redo does
    return [first, scene.stats().images - base]
  })
  check('a redraw after undo or redo still draws a library picture', images[0] === 1 && images[1] === 1, JSON.stringify(images))
  await page.evaluate(() => window.__personalNote.leaferCanvas().load(window.__personalNote.leaferEdits.doc))

  // a stroke that grew the page grid and is then given up puts the grid back, and the next step does not carry the growth
  await tool(page, 'pen')
  const grid = await api(page, `() => ({ ...window.__personalNote.state.pages, doc: window.__personalNote.leaferEdits.doc.page.columns })`)
  await page.evaluate(() => { window.addEventListener('pointerdown', (e) => { window.__lastPointer = e.pointerId }, true) })
  const edge = await screenOf(page, grid.columns * 860 - 40, 500)
  const beyond = await screenOf(page, grid.columns * 860 + 30, 520)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: edge.x, y: edge.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: beyond.x, y: beyond.y, button: 'none', buttons: 1, pointerType: 'pen', force: 0.5 })
  await nextFrame(page)
  const grown = await api(page, `() => window.__personalNote.state.pages.columns`)
  await page.evaluate(() => document.querySelector('.ink-surface').dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__lastPointer, bubbles: true })))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: beyond.x, y: beyond.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 })
  check('the pen going past the edge grows the page grid', grown === grid.columns + 1, `${grown} vs ${grid.columns}`)
  check('giving that stroke up puts the page grid back', (await api(page, `() => window.__personalNote.state.pages.columns`)) === grid.columns)
  const stepsNow = await steps(page)
  await stroke(page, cdp, wave(200, 520, 100, 10, 5))
  const lastStep = await page.evaluate(() => window.__personalNote.leaferEdits.doc.page.columns)
  check('the next stroke is an ordinary step with no page growth in it', lastStep === grid.doc && (await steps(page)) === stepsNow + 1)
  check('no page errors', errors.length === 0, errors.join(' | '))
  await context.close()

  // ---------------------------------------------------------------- a phone: touch draws, a second finger is a pinch and drops the stroke
  {
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
    const small = await phone.newPage()
    small.on('pageerror', (error) => console.log('INFO  phone page error', error.message))
    small.on('console', (m) => { if (m.type() === 'error') console.log('INFO  phone console', m.text()) })
    const note = { content: fixture.content, pageState: fixture.pageState, revision: 1 }
    await mock(small, () => note)
    await open(small)
    const touch = await phone.newCDPSession(small)
    await small.evaluate(() => { window.__ev = []; for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) document.addEventListener(t, (e) => window.__ev.push([t, e.pointerType, e.target.className || e.target.tagName]), true) })
    await small.click('#mobile-draw') // the phone's Draw button
    const base = (await inkObjects(small)).length
    const spots = []
    for (let i = 0; i < 12; i += 1) spots.push(await screenOf(small, 200 + i * 20, 300 + Math.sin(i / 2) * 20))
    const point = (p, id = 0) => ({ x: p.x, y: p.y, id, force: 0.5 })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(spots[0])] })
    for (const spot of spots.slice(1)) { await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(spot)] }); await nextFrame(small) }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await nextFrame(small)
    check('phone: a finger draws a stroke', (await inkObjects(small)).length === base + 1, JSON.stringify(await small.evaluate(() => ({ tool: window.__personalNote.state.tool, surface: getComputedStyle(document.querySelector('.ink-surface')).display, w: innerWidth }))) + JSON.stringify(await small.evaluate(() => window.__ev.slice(-4))))
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(spots[0])] })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(spots[3])] })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(spots[3]), point(spots[8], 1)] })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(spots[4]), point(spots[9], 1)] })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await nextFrame(small)
    check('phone: a second finger drops the stroke the first began (a pinch, not a mark)', (await inkObjects(small)).length === base + 1)
    await phone.close()
  }

  // ---------------------------------------------------------------- latency on the 600-object, 12-page note
  const big = { content: generateNote(), pageState: { columns: COLUMNS, rows: ROWS }, revision: 1 }
  for (const dpr of [1, 2]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr })
    const bigPage = await ctx.newPage()
    await mock(bigPage, () => big)
    await open(bigPage)
    const bigCdp = await ctx.newCDPSession(bigPage)
    await bigPage.evaluate(() => {
      const { canvas, state, getCanvasScale, setCanvasViewportOffset } = window.__personalNote
      state.canvasZoom = 1
      setCanvasViewportOffset(canvas.getWidth() / 2 - 430 * getCanvasScale(), 104)
    })
    await bigPage.waitForTimeout(500)
    await tool(bigPage, 'pen')
    await bigPage.evaluate(() => {
      window.__lat = []
      window.__proc = []
      window.__frames = []
      let last = performance.now()
      const tick = (time) => { window.__frames.push(time - last); last = time; window.__loop = requestAnimationFrame(tick) }
      window.__loop = requestAnimationFrame(tick)
      // the time the app's own handler takes (the surface draws the new segments in it): from just before it runs to just after
      let began = 0
      window.addEventListener('pointermove', () => { began = performance.now() }, true)
      window.addEventListener('pointermove', () => { window.__proc.push(performance.now() - began) })
      window.__marks = []
      const mark = (name) => (event) => window.__marks.push([name, performance.now()])
      window.addEventListener('pointerdown', mark('down'), true)
      window.addEventListener('pointerup', mark('up'), true)
      const slow = (time) => { if (window.__frames.at(-1) > 30) window.__marks.push([`slow ${window.__frames.at(-1).toFixed(0)}ms`, time]) }
      const watch = (time) => { slow(time); requestAnimationFrame(watch) }
      requestAnimationFrame(watch)
      window.addEventListener('pointermove', (event) => {
        const stamp = event.timeStamp
        requestAnimationFrame(() => setTimeout(() => window.__lat.push(performance.now() - stamp), 0)) // the frame that follows the event, after its paint work was queued
      }, true)
    })
    const marks = []
    for (let s = 0; s < 5; s += 1) {
      await stroke(bigPage, bigCdp, wave(180 + s * 20, 300 + s * 90, 420, 70, 40))
      marks.push(await steps(bigPage))
    }
    const { latency, frames, proc, marks: marked } = await bigPage.evaluate(() => { cancelAnimationFrame(window.__loop); return { latency: window.__lat, frames: window.__frames.slice(2), proc: window.__proc, marks: window.__marks } })
    if (marked.some(([name]) => name.startsWith('slow'))) console.log('INFO  slow frames:', JSON.stringify(marked.map(([name, time]) => [name, Math.round(time)])))
    const at = (list, q) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(q * list.length))]
    const objects = await bigPage.evaluate(() => window.__personalNote.leaferEdits.doc.objects.length)
    console.log(`INFO  600-object note (${objects} objects incl. 5 new strokes), devicePixelRatio ${dpr}: frame gap median ${at(frames, 0.5).toFixed(1)} ms, p95 ${at(frames, 0.95).toFixed(1)} ms, max ${Math.max(...frames).toFixed(1)} ms over ${frames.length} frames; time inside the pointer handler median ${at(proc, 0.5).toFixed(1)} ms, p95 ${at(proc, 0.95).toFixed(1)} ms, max ${Math.max(...proc).toFixed(1)} ms; pointer to the frame after it median ${at(latency, 0.5).toFixed(1)} ms, p95 ${at(latency, 0.95).toFixed(1)} ms over ${latency.length} moves`)
    check(`dpr ${dpr}: p95 frame while drawing on the 600-object note is within 16.8 ms`, at(frames, 0.95) <= 16.85, `${at(frames, 0.95)}`)
    check(`dpr ${dpr}: p95 time inside our pointer handler (it draws the move on the live layer; not present-to-glass latency) is within 16.8 ms`, at(proc, 0.95) <= 16.8, `${at(proc, 0.95)}`)
    check(`dpr ${dpr}: five strokes, five undo steps`, marks.at(-1) === 5)
    await ctx.close()
  }
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
