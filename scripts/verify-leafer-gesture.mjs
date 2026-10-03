// F-034 checks for the gesture transform (src/modules/canvas-leafer/gesture-view.js), in the real app (Vite dev server on port 4840, mocked /api, proxy
// to a dead port, headless Chromium at devicePixelRatio 2): while the view is panned or zoomed the drawn canvas is moved with a CSS transform and the
// note is drawn once when the gesture settles. Checks: the canvas moves instead of being drawn again; the settled picture equals a plain draw at the same
// view; a click right after a gesture picks what is under the pointer; the text overlay and the selection follow the view; a long pan draws again before
// a blank edge shows; every other render mode still works.
//
//   node scripts/verify-leafer-gesture.mjs
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { COLUMNS, ROWS, generateNote } from './benchmark-note.mjs'

const PORT = 4840
const now = new Date().toISOString()
const summary = { id: 1, resourceId: 'res_gest', revision: 1, noteType: 'canvas', title: 'Gesture', notebookId: 1, createdAt: now, updatedAt: now }
const note = { content: generateNote(), pageState: { columns: COLUMNS, rows: ROWS } }
// A sparse note for the picking and typing checks: a grid of separate rectangles and some words, two pages wide.
const sparse = (() => {
  const objects = []
  for (let i = 0; i < 4; i += 1) for (let j = 0; j < 6; j += 1) {
    objects.push({ type: 'Rect', version: '7.4.0', semanticId: `res_rect_${i}_${j}`, originX: 'left', originY: 'top', left: 60 + i * 200, top: 80 + j * 150, width: 140, height: 90, fill: `rgba(${40 * i + 40}, ${30 * j + 60}, 160, 0.5)`, stroke: '#4a6fb0', strokeWidth: 2, rx: 6, ry: 6 })
  }
  for (let j = 0; j < 4; j += 1) objects.push({ type: 'IText', version: '7.4.0', originX: 'left', originY: 'top', left: 1000, top: 100 + j * 200, text: `Words number ${j} to type into`, fontSize: 24, fontFamily: 'Source Serif 4', fill: '#222', lineHeight: 1.45, padding: 8 })
  return { content: { version: '7.4.0', objects }, pageState: { columns: 2, rows: 1 } }
})()
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`) }

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4849' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true })

async function open(flags, data = note) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  if (flags) await page.addInitScript((value) => { window.__pnPerf = value }, flags)
  await page.route('**/api/**', async (route) => {
    const apiPath = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (apiPath === '/notebooks') return json([{ id: 1, resourceId: 'res_nb', revision: 1, name: 'G', color: '#76669a', noteCount: 1 }])
    if (apiPath === '/notes') return json([summary])
    if (apiPath === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, ...data })
    return json({ revision: 2, resourceId: 'res_gest' })
  })
  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 120000 })
  await page.waitForTimeout(800)
  return { context, page, errors }
}

const gesture = (page) => page.evaluate(() => window.__personalNote.leaferCanvas().gestureState())
const sleep = (page, ms) => page.waitForTimeout(ms)
const shot = (page) => page.screenshot({ clip: { x: 228, y: 0, width: 1052, height: 800 } })

// Two PNGs compared pixel by pixel in a page: how many pixels differ, and by how much at most.
async function diff(page, a, b) {
  return page.evaluate(async ([x, y]) => {
    const load = (base64) => new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image); image.src = `data:image/png;base64,${base64}` })
    const [ia, ib] = await Promise.all([load(x), load(y)])
    const read = (image) => { const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; const g = c.getContext('2d'); g.drawImage(image, 0, 0); return g.getImageData(0, 0, c.width, c.height).data }
    const da = read(ia)
    const db = read(ib)
    let different = 0
    let max = 0
    let box = null
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]))
      if (d > 8) {
        different += 1
        const px = (i / 4) % ia.width; const py = Math.floor(i / 4 / ia.width)
        box = box ? [Math.min(box[0], px), Math.min(box[1], py), Math.max(box[2], px), Math.max(box[3], py)] : [px, py, px, py]
      }
      if (d > max) max = d
    }
    return { pixels: da.length / 4, different, max, box }
  }, [a.toString('base64'), b.toString('base64')])
}

try {
  // ---- the canvas moves, it is not drawn again
  const main = await open(process.env.GEST_FLAGS ? JSON.parse(process.env.GEST_FLAGS) : null)
  let { page } = main
  const first = await gesture(page)
  check('the canvas is drawn a margin past the window (and the transform is on by default)', first.margin > 0 && first.canvas[0] === 1052 + 2 * first.margin, JSON.stringify(first))
  await page.mouse.move(600, 400)
  const before = await page.evaluate(() => performance.getEntriesByType('measure').length)
  for (let i = 0; i < 8; i += 1) { await page.mouse.wheel(0, 30); await sleep(page, 16) }
  const during = await gesture(page)
  check('during a pan the canvas is moved (a transform), not drawn again', during.pending && Math.abs(during.transform.ty) > 100 && during.drawn.y === first.view.y, JSON.stringify(during.transform))
  await sleep(page, 400)
  const settled = await gesture(page)
  check('after the pan stops the note is drawn once at the exact view and the transform is gone', !settled.pending && settled.transform.ty === 0 && settled.drawn.y === settled.view.y && settled.view.y !== first.view.y, JSON.stringify(settled.drawn))

  // ---- zoom: scaled while it goes, sharp when it stops
  await page.keyboard.down('Control')
  for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(0, -20); await sleep(page, 16) }
  await page.keyboard.up('Control')
  const zooming = await gesture(page)
  check('during a zoom the canvas is scaled by a transform', zooming.pending && Math.abs(zooming.transform.k - 1) > 0.05 && zooming.drawn.scale !== zooming.view.scale, JSON.stringify(zooming.transform))
  await sleep(page, 400)
  const zoomed = await gesture(page)
  check('after the zoom stops it is drawn at the exact scale', !zoomed.pending && zoomed.drawn.scale === zoomed.view.scale && zoomed.view.scale !== first.view.scale)

  // ---- a long pan outruns the margin: drawn again before a blank edge shows
  const stats0 = (await gesture(page)).intermediate
  for (let i = 0; i < 30; i += 1) { await page.mouse.wheel(0, 60); await sleep(page, 16) }
  const longPan = await gesture(page)
  check('a pan past the margin draws again on the way (no blank edge), and the view reaches the end', longPan.intermediate > stats0 && longPan.view.y !== zoomed.view.y, JSON.stringify({ intermediate: longPan.intermediate, margin: longPan.margin }))
  await sleep(page, 400)

  // ---- the settled picture is the picture a plain draw gives at the same view
  await page.evaluate(() => { const n = window.__personalNote; n.state.canvasZoom = 1; n.setCanvasViewportOffset(n.viewSize.width / 2 - 430 * n.getCanvasScale(), 104) })
  await sleep(page, 400)
  await page.mouse.move(700, 450)
  for (let i = 0; i < 10; i += 1) { await page.mouse.wheel(40, 25); await sleep(page, 16) }
  await page.keyboard.down('Control')
  for (let i = 0; i < 5; i += 1) { await page.mouse.wheel(0, -25); await sleep(page, 16) }
  await page.keyboard.up('Control')
  await sleep(page, 500)
  const target = await page.evaluate(() => { const n = window.__personalNote; return { view: n.leaferCanvas().view(), zoom: n.state.canvasZoom } })
  const gestured = await shot(page)
  const plain = await open({ gestureTransform: false, pageBitmaps: 'off' })
  await plain.page.evaluate((t) => { const n = window.__personalNote; n.state.canvasZoom = t.zoom; n.setCanvasViewportOffset(t.view.x, t.view.y, true) }, target)
  await sleep(plain.page, 600)
  const planePlain = await plain.page.evaluate(() => window.__personalNote.leaferCanvas().view())
  const reference = await shot(plain.page)
  const d = await diff(page, gestured, reference)
  if (process.env.GEST_DUMP) { (await import('node:fs')).writeFileSync('/var/tmp/pn-f034-a.png', gestured); (await import('node:fs')).writeFileSync('/var/tmp/pn-f034-b.png', reference) }
  check('after pan + zoom settle, the picture matches a plain draw at the same view', Math.abs(planePlain.x - target.view.x) < 1e-6 && Math.abs(planePlain.scale - target.view.scale) < 1e-9 && d.different / d.pixels < 0.002 && d.max < 80, 'only the antialiasing slivers along long arrows differ: ' + JSON.stringify({ ...d, view: target.view, plainView: planePlain }))
  // the noise of the screen itself: a second plain draw at that view, in another page
  const plain2 = await open({ gestureTransform: false, pageBitmaps: 'off' })
  await plain2.page.evaluate((t) => { const n = window.__personalNote; n.state.canvasZoom = t.zoom; n.setCanvasViewportOffset(t.view.x, t.view.y, true) }, target)
  await sleep(plain2.page, 600)
  const noise = await diff(page, reference, await shot(plain2.page))
  console.log('noise between two plain draws', JSON.stringify(noise))
  await plain.context.close()
  await plain2.context.close()

  await main.context.close()
  // ---- a click right after a gesture picks the object under the pointer
  const second = await open(process.env.GEST_FLAGS ? JSON.parse(process.env.GEST_FLAGS) : null, sparse)
  main.context = second.context
  main.errors = second.errors
  page = second.page
  await page.evaluate(() => { const n = window.__personalNote; n.state.canvasZoom = 1; n.setCanvasViewportOffset(n.viewSize.width / 2 - 430 * n.getCanvasScale(), 104) })
  await sleep(page, 500)
  await page.evaluate(() => window.__personalNote.setTool('select')) // a note opens with the Text tool
  const candidates = () => page.evaluate(() => {
    const { leaferCanvas, leaferEdits } = window.__personalNote
    const scene = leaferCanvas()
    const host = document.querySelector('#leafer-host').getBoundingClientRect()
    const out = []
    for (const object of leaferEdits.doc.objects) {
      if (object.type !== 'shape' && object.type !== 'sticky') continue
      const box = scene.screenBox(object.id)
      if (!box) continue
      const x = host.left + box.x; const y = host.top + box.y
      if (x > 300 && y > 140 && x + box.width < host.right - 100 && y + box.height < host.bottom - 150 && box.width > 20 && box.height > 20) out.push({ id: object.id, x: x + box.width / 2, y: y + box.height / 2 })
    }
    return out
  })
  const pick = async (label, run) => {
    await page.evaluate(() => window.__personalNote.leaferCanvas().clearSelection())
    await run()
    const list = await candidates() // while the canvas is still moving: the boxes are where the settled view will put them
    const stillMoving = (await gesture(page)).pending
    const mine = list
    const choice = mine[Math.floor(mine.length / 2)]
    if (!choice) { check(`${label}: an object to click`, false, `candidates ${list.length}`); return }
    await page.mouse.click(choice.x, choice.y)
    await sleep(page, 150)
    const selected = await page.evaluate(() => window.__personalNote.leaferCanvas().selection())
    check(`${label}: the click picks the object under the pointer`, selected.length === 1 && selected[0] === choice.id && stillMoving, JSON.stringify({ selected, expected: choice.id, stillMoving }))
  }
  await page.mouse.move(700, 450)
  await pick('right after a wheel pan', async () => { for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(30, 20); await sleep(page, 10) } })
  await sleep(page, 500)
  await pick('right after a ctrl+wheel zoom', async () => { await page.keyboard.down('Control'); for (let i = 0; i < 5; i += 1) { await page.mouse.wheel(0, -20); await sleep(page, 10) } await page.keyboard.up('Control') })
  await sleep(page, 500)

  // ---- the selection frame and the text overlay follow the view while the canvas moves
  const frame = await page.evaluate(() => { const s = window.__personalNote.leaferCanvas(); const id = s.selection()[0]; return { id, box: s.screenBox(id) } })
  await page.mouse.move(700, 450)
  for (let i = 0; i < 5; i += 1) { await page.mouse.wheel(0, 20); await sleep(page, 10) }
  const during2 = await page.evaluate((id) => { const s = window.__personalNote.leaferCanvas(); return { box: s.screenBox(id), view: s.view(), pending: s.gestureState().pending } }, frame.id)
  await sleep(page, 400)
  const after2 = await page.evaluate((id) => window.__personalNote.leaferCanvas().screenBox(id), frame.id)
  check('the selected object\'s box follows the pan while the canvas moves, and does not jump when it is drawn', during2.pending && Math.abs(during2.box.y - after2.y) < 1.5 && Math.abs(during2.box.x - after2.x) < 1.5 && Math.abs(during2.box.y - frame.box.y) > 20, JSON.stringify({ frame: frame.box, during: during2.box, after: after2 }))
  for (let i = 0; i < 4; i += 1) { await page.mouse.wheel(0, -15); await sleep(page, 10) }
  await page.waitForFunction(() => !window.__personalNote.leaferCanvas().gestureState().pending)
  const handles = await shot(page) // the first frames after the picture was drawn: the handles must already be where the selection is
  await sleep(page, 400)
  const again = await shot(page)
  const hd = await diff(page, handles, again)
  check('the selection handles are where the selection is once the picture is drawn (nothing moves after the frame)', hd.different === 0, JSON.stringify(hd))

  // text overlay
  const textId = await page.evaluate(() => window.__personalNote.leaferEdits.doc.objects.find((o) => o.type === 'text' && o.content && o.content.length > 4)?.id)
  await page.evaluate((id) => { const n = window.__personalNote; n.leaferCanvas().clearSelection(); n.fitAllPages?.() }, textId)
  await sleep(page, 400)
  await page.evaluate((id) => { const n = window.__personalNote; const s = n.leaferCanvas(); const box = s.screenBox(id); const v = s.view(); n.state.canvasZoom = 1.5; n.setCanvasViewportOffset(n.viewSize.width / 2 - 430 * n.getCanvasScale(), 104) }, textId)
  await sleep(page, 400)
  // bring that text to the middle of the window, then edit it
  await page.evaluate((id) => {
    const n = window.__personalNote; const s = n.leaferCanvas(); const corners = s.pageCorners(id); const v = s.view()
    const cx = (corners[0].x + corners[2].x) / 2; const cy = (corners[0].y + corners[2].y) / 2
    n.setCanvasViewportOffset(n.viewSize.width / 2 - cx * v.scale, n.viewSize.height / 2 - cy * v.scale, true)
  }, textId)
  await sleep(page, 400)
  await page.evaluate((id) => window.__personalNote.leaferCanvas().editText(id, { select: false }), textId)
  await sleep(page, 200)
  const overlayRect = () => page.evaluate((id) => {
    const area = document.querySelector('.leafer-text-editor')
    const s = window.__personalNote.leaferCanvas()
    const host = document.querySelector('#leafer-host').getBoundingClientRect()
    const box = s.screenBox(id)
    const a = area?.getBoundingClientRect()
    return area ? { overlay: [a.left, a.top, a.width, a.height], node: [host.left + box.x, host.top + box.y, box.width, box.height] } : null
  }, textId)
  const closeEnough = (r) => r && Math.abs(r.overlay[0] - r.node[0]) < 3 && Math.abs(r.overlay[1] - r.node[1]) < 3
  const idle = await overlayRect()
  check('text editing: the overlay sits over the drawn text at rest', closeEnough(idle), JSON.stringify(idle))
  await page.mouse.move(700, 450)
  await page.keyboard.down('Control')
  for (let i = 0; i < 5; i += 1) { await page.mouse.wheel(0, -20); await sleep(page, 10) }
  await page.keyboard.up('Control')
  const mid = await overlayRect()
  const midState = await gesture(page)
  check('text editing: the overlay follows a zoom while the canvas is scaled', midState.pending && closeEnough(mid), JSON.stringify(mid))
  await sleep(page, 400)
  const end = await overlayRect()
  check('text editing: the overlay is still over the text after the zoom is drawn', closeEnough(end), JSON.stringify(end))
  await page.keyboard.press('Escape')

  // a page that grows while typing (F-029), with a zoom going on in between: the overlay stays over the words
  await page.evaluate(() => { const n = window.__personalNote; n.leaferCanvas().clearSelection(); n.state.canvasZoom = 1; n.setCanvasViewportOffset(n.viewSize.width / 2 - 430 * n.getCanvasScale(), -700) })
  await sleep(page, 500)
  const typed = { x: 60, y: 940 } // a page point near the bottom of the first page (1080 high)
  await page.evaluate((point) => window.__personalNote.leaferCanvas().createText(point), typed)
  await sleep(page, 200)
  const expectOverlay = () => page.evaluate((point) => {
    const s = window.__personalNote.leaferCanvas(); const v = s.view(); const host = document.querySelector('#leafer-host').getBoundingClientRect()
    const a = document.querySelector('.leafer-text-editor')?.getBoundingClientRect()
    return a ? { dx: (a.left - host.left - v.x) / v.scale, dy: (a.top - host.top - v.y) / v.scale, rows: s.gridNow().rows } : null // (the page point the overlay's corner is over)
  }, typed)
  const t0 = await expectOverlay()
  for (let i = 0; i < 9; i += 1) { await page.keyboard.type('a line of words'); await page.keyboard.press('Enter') }
  const t1 = await expectOverlay()
  check('typing past the bottom edge grows the page grid', t0 && t1 && t1.rows > t0.rows && Boolean(t1), JSON.stringify([t0, t1]))
  await page.mouse.move(700, 450)
  await page.keyboard.down('Control')
  for (let i = 0; i < 4; i += 1) { await page.mouse.wheel(0, -20); await sleep(page, 10) }
  await page.keyboard.up('Control')
  await page.keyboard.type('more words')
  await page.keyboard.press('Enter')
  await page.keyboard.type('and a page grows while the picture is still moving')
  const t2 = await expectOverlay()
  check('typing on right after a zoom: the overlay is there, and the grid keeps its pages', Boolean(t2) && t2.rows >= t1.rows, JSON.stringify([t1, t2]))
  await sleep(page, 500)
  const t3 = await expectOverlay()
  const settledState = await gesture(page)
  check('and it is where it was when the picture is drawn', t3 && !settledState.pending && Math.abs(t3.dx - t2.dx) < 1.5 && Math.abs(t3.dy - t2.dy) < 1.5, JSON.stringify([t2, t3]))
  await page.keyboard.press('Escape')
  check('no page errors', main.errors.length === 0, main.errors.join(' | '))
  await main.context.close()

  // ---- the other modes still draw and move the view
  for (const flags of [{ gestureTransform: false, pageBitmaps: 'off' }, { gestureTransform: false, pageBitmaps: 'adaptive' }]) {
    const other = await open(flags)
    await other.page.mouse.move(600, 400)
    for (let i = 0; i < 6; i += 1) { await other.page.mouse.wheel(0, 30); await sleep(other.page, 16) }
    const state = await other.page.evaluate(() => window.__personalNote.leaferCanvas().gestureState())
    check(`mode ${JSON.stringify(flags)}: no margin, no transform, the view moves`, state.margin === 0 && !state.pending && state.view.y !== 104 && other.errors.length === 0, JSON.stringify({ margin: state.margin, y: state.view.y }))
    await other.context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
