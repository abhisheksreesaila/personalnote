// F-034: undo and redo that draw only the objects a step names (scene.applyChanged) end in exactly the state a full redraw of the document gives:
// the same nodes in the same order, in the same places, and the same picture. On a note with arrows (that follow what moves), a picture, stickies and a
// step that adds a page (Vite dev server on port 4807, mocked in-memory /api, headless Chromium).
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-undo.mjs
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { writeJsonCanvas } from '../src/core/document/jsoncanvas.js'

const now = new Date().toISOString()
const UP = { rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
const rect = (id, x, y, z) => ({ id, type: 'shape', kind: 'rect', z, fill: '#c9d9ee', stroke: '#4a6fb0', strokeWidth: 2, geometry: { x, y, width: 200, height: 120, ...UP } })
const doc = {
  schemaVersion: 1, page: { columns: 1, rows: 1 }, extras: {},
  objects: [
    rect('A', 100, 200, 0), rect('B', 500, 200, 1), rect('C', 300, 600, 2),
    { id: 'S', type: 'sticky', z: 3, content: 'a sticky', color: '#ffd60a', style: { fontFamily: 'Geist', fontSize: 20, color: '#292202', lineHeight: 1.4 }, geometry: { x: 600, y: 700, width: 220, height: 180, ...UP } },
    { id: 'T', type: 'text', mode: 'box', z: 4, content: 'some words', style: { fontFamily: 'Source Serif 4', fontSize: 24, color: '#222222' }, geometry: { x: 120, y: 800, width: 260, height: 60, ...UP } },
    { id: 'P', type: 'image', z: 5, mediaRef: { kind: 'inline', dataUrl: GIF }, geometry: { x: 380, y: 100, width: 90, height: 60, ...UP } },
    { id: 'c1', type: 'connector', z: 6, fromId: 'A', toId: 'B', color: '#20201e', lineWidth: 2.6, reverseX: false, reverseY: false, geometry: { x: 1, y: 1, width: 5, height: 5, ...UP } },
    { id: 'c2', type: 'connector', z: 7, fromId: 'C', toId: 'A', color: '#20201e', lineWidth: 2.6, reverseX: false, reverseY: false, geometry: { x: 1, y: 1, width: 5, height: 5, ...UP } },
  ],
}
const notesDb = { 1: { id: 1, resourceId: 'r1', revision: 1, noteType: 'canvas', title: 'Undo', notebookId: 1, createdAt: now, updatedAt: now, content: writeJsonCanvas(doc, { derived: 'omit' }), pageState: { columns: 1, rows: 1 } } }
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

const server = await createServer({ server: { port: 4807, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4809' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    if (p === '/notes' && req.method() === 'GET') return json([{ ...notesDb[1], content: undefined, pageState: undefined }])
    if (p === '/notes/1' && req.method() === 'GET') return json(notesDb[1])
    if (p === '/notes/1' && req.method() === 'PUT') { notesDb[1].revision += 1; return json({ revision: notesDb[1].revision, resourceId: 'r1' }) }
    return json({})
  })
  await page.goto('http://127.0.0.1:4807/notes')
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(800)
  const scene = (name, ...args) => page.evaluate(([n, a]) => window.__personalNote.leaferCanvas()[n](...a), [name, args])
  const steps = () => page.evaluate(() => window.__personalNote.leaferEdits.stats().undoSteps)
  const settle = () => page.evaluate(() => window.__personalNote.leaferCanvas().whenSettled())
  const snapshot = () => page.evaluate(() => {
    const scene = window.__personalNote.leaferCanvas()
    const ids = scene.nodeOrder()
    return { order: ids, info: Object.fromEntries(ids.map((id) => [id, scene.nodeInfo(id)])), grid: scene.gridNow() }
  })
  const shot = () => page.screenshot({ clip: { x: 260, y: 90, width: 800, height: 640 } })
  const differ = (a, b) => page.evaluate(async ([one, two]) => {
    const read = async (data) => { const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob()); const c = new OffscreenCanvas(image.width, image.height); const x = c.getContext('2d'); x.drawImage(image, 0, 0); return x.getImageData(0, 0, image.width, image.height) }
    const [first, second] = [await read(one), await read(two)]
    let strong = 0
    let any = 0
    for (let i = 0; i < first.data.length; i += 4) {
      const level = Math.max(Math.abs(first.data[i] - second.data[i]), Math.abs(first.data[i + 1] - second.data[i + 1]), Math.abs(first.data[i + 2] - second.data[i + 2]))
      if (level > 0) any += 1
      if (level > 8) strong += 1
    }
    return { any, strong }
  }, [a.toString('base64'), b.toString('base64')])
  const near = (a, b) => typeof a === 'number' ? Math.abs(a - b) < 1e-6 : JSON.stringify(a) === JSON.stringify(b)
  const sameState = (a, b) => JSON.stringify(a.order) === JSON.stringify(b.order) && JSON.stringify(a.grid) === JSON.stringify(b.grid) && a.order.every((id) => ['x', 'y', 'rotation', 'visible', 'path', 'width', 'height'].every((key) => near(a.info[id]?.[key], b.info[id]?.[key])))

  // a step that moves an object (its arrows follow), one that adds a picture over the right edge (a page is added), one that deletes an object with arrows
  await scene('select', ['A'])
  await scene('nudge', 60, 40)
  await page.evaluate(() => window.__personalNote.leaferEdits.stats())
  await scene('clearSelection')
  await page.waitForTimeout(700)
  await scene('addImages', [{ mediaId: 'pic-edge', url: GIF, width: 400, height: 300 }], { x: 840, y: 500 })
  await scene('select', ['B'])
  await scene('deleteSelection')
  await settle()
  const total = await steps()
  check('(setup) three steps were made: a move, a picture that adds a page, a delete', total >= 3, String(total))
  const grid = await scene('gridNow')
  check('(setup) one of them added a page', grid.columns > 1, JSON.stringify(grid))

  for (const direction of ['undo', 'redo']) {
    for (let n = 0; n < 3; n += 1) {
      await page.evaluate((d) => window.__personalNote.leaferEdits[d](), direction)
      await settle()
      await page.waitForTimeout(150)
      await scene('clearSelection')
      await page.waitForTimeout(100)
      const incremental = await snapshot()
      const picture = await shot()
      await page.evaluate(() => window.__personalNote.leaferCanvas().load(window.__personalNote.leaferEdits.doc))
      await settle()
      await page.waitForTimeout(150)
      const full = await snapshot()
      const fullPicture = await shot()
      const d = await differ(picture, fullPicture)
      check(`${direction} ${n + 1}: the nodes, their order, places and the page grid are what a full redraw gives`, sameState(incremental, full), JSON.stringify([incremental.order, full.order, incremental.grid, full.grid]))
      check(`${direction} ${n + 1}: the picture is the one a full redraw gives (under 100 pixels differ at all: the engine's own first-draw quirk)`, d.strong <= 8 && d.any < 100, JSON.stringify(d)) // (the engine's first draw differs from a redraw by a few edge pixels, see verify-leafer-history)
    }
  }
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
