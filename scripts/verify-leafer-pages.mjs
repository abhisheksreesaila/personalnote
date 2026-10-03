// F-032 checks, in the real app (Vite dev server on port 4780, mocked in-memory /api that keeps what the app saves and serves it back on
// reload, headless Chromium): pages on the Leafer canvas (a page appears as an object nears ANY edge, right, bottom, up and left, and folds
// back when emptied; it is part of the same undo step as the edit; the view stays put), connectors (create, follow a moved, resized or turned
// object live and in the saved note, pick and delete, delete with an end), the lift and the ghost page while dragging, a reload that shows
// the same, an agent's merge that adds a page or moves a connected object, and the drag of the most connected object on the 600-object note.
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-pages.mjs
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { readJsonCanvas, writeJsonCanvas } from '../src/core/document/jsoncanvas.js'
import { followChanges } from '../src/modules/canvas-leafer/connectors.js'
import { boundingRect } from '../src/modules/canvas-leafer/bounds.js'
import { COLUMNS, ROWS, generateNote } from './benchmark-note.mjs'

const PORT = Number(process.env.VERIFY_PORT) || 4780
const W = 860
const H = 1080
const now = new Date().toISOString()
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const near = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance

const UPRIGHT = { rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const rect = (id, x, y, width, height, z) => ({ id, type: 'shape', kind: 'rect', z, geometry: { x, y, width, height, ...UPRIGHT }, fill: '#c9d9ee', stroke: '#4a6fb0', strokeWidth: 2 })
const sticky = (id, x, y, z) => ({ id, type: 'sticky', z, content: 'a sticky', color: '#ffd60a', style: { fontFamily: 'Geist', fontSize: 20, color: '#292202', lineHeight: 1.4 }, geometry: { x, y, width: 240, height: 200, ...UPRIGHT } })
// a connector whose stored box is wrong on purpose: the app works the box out again from the two ends when the note opens
const staleConnector = (id, fromId, toId, z) => ({ id, type: 'connector', z, fromId, toId, color: '#20201e', lineWidth: 2.6, reverseX: false, reverseY: false, geometry: { x: 1, y: 1, width: 5, height: 5, ...UPRIGHT } })
const baseDoc = () => ({
  schemaVersion: 1, page: { columns: 1, rows: 1 }, extras: {},
  objects: [rect('A', 100, 200, 200, 120, 0), rect('B', 500, 200, 200, 120, 1), sticky('C', 300, 600, 2), staleConnector('c1', 'A', 'B', 3), staleConnector('c2', 'C', 'A', 4)],
})
const store = (doc) => writeJsonCanvas(doc, { derived: 'omit' })

let stored = { content: store(baseDoc()), pageState: { columns: 1, rows: 1 }, revision: 1 }
const puts = []
let changeSeq = 1
let putGate = null
let release = () => {}
const hold = () => { let open; putGate = new Promise((resolve) => { open = () => { putGate = null; resolve() } }); return open }
const changeLog = []
const agentWrite = (change) => {
  const doc = readJsonCanvas(stored.content)
  change(doc)
  stored.content = store(doc)
  stored.pageState = { columns: doc.page.columns, rows: doc.page.rows }
  stored.revision += 1
  changeSeq += 1
  changeLog.push({ sequence: changeSeq, resourceKind: 'note', resourceId: 'r1', changeType: 'updated', revision: stored.revision })
}

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4789' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

async function mock(page, getNote) {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    const note = getNote()
    const summary = { id: 1, resourceId: 'r1', revision: note.revision, noteType: 'canvas', title: 'Pages', notebookId: 1, createdAt: now, updatedAt: now }
    if (p === '/changes') { const since = Number(new URL(req.url()).searchParams.get('since') ?? changeSeq); return json({ sequence: changeSeq, changes: changeLog.filter((c) => c.sequence > since), agents: [] }) }
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary])
    if (p === '/notes/1' && req.method() === 'GET') return json({ ...summary, content: note.content, pageState: note.pageState })
    if (p === '/notes/1' && req.method() === 'PUT') {
      if (putGate) await putGate
      const body = JSON.parse(req.postData())
      if (body.revision !== note.revision) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Resource revision does not match' }) }) // like the real server: a save that is not on the newest revision is refused
      puts.push(body)
      Object.assign(note, { content: body.content, pageState: body.pageState, revision: note.revision + 1 })
      return json({ revision: note.revision, resourceId: 'r1' })
    }
    return json({})
  })
}

async function open(page) {
  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__personalNote.setTool('select')) // a note opens with the Text tool; these checks select and drag
  await page.waitForTimeout(200) // a drag in the first frames after the switch does not lift
}
const scene = (page, name, ...args) => page.evaluate(([n, a]) => window.__personalNote.leaferCanvas()[n](...a), [name, args])
const doc = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))
const steps = (page) => page.evaluate(() => window.__personalNote.leaferEdits.stats().undoSteps)
const grid = (page) => page.evaluate(() => ({ ...window.__personalNote.state.pages }))
const nextFrame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
const objectOf = (d, id) => d.objects.find((o) => o.id === id)
const consistent = (d) => followChanges(d.objects, null, (object) => boundingRect(object)).length === 0 // every connector is where its two ends put it
const waitSave = async (page, before) => { for (let i = 0; i < 40 && puts.length <= before; i += 1) await page.waitForTimeout(150); await page.waitForTimeout(150); return puts.length > before }
const savedDoc = () => readJsonCanvas(puts.at(-1).content)
// a page point -> where it is on screen
const screenOf = (page, x, y) => page.evaluate(([px, py]) => {
  const view = window.__personalNote.leaferCanvas().view()
  const host = document.querySelector('#leafer-host').getBoundingClientRect()
  return { x: host.left + view.x + px * view.scale, y: host.top + view.y + py * view.scale }
}, [x, y])
// where an object's centre is on screen, now
const centre = async (page, id) => {
  const box = await scene(page, 'screenBox', id)
  const host = await page.evaluate(() => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: r.left, y: r.top } })
  return { x: host.x + box.x + box.width / 2, y: host.y + box.y + box.height / 2, left: host.x + box.x, top: host.y + box.y, right: host.x + box.x + box.width, bottom: host.y + box.y + box.height }
}
const drag = async (page, from, to, { steps: count = 12, hold = false, frames = true } = {}) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= count; i += 1) { await page.mouse.move(from.x + ((to.x - from.x) * i) / count, from.y + ((to.y - from.y) * i) / count); if (frames) await nextFrame(page) }
  if (!hold) { await page.mouse.up(); await nextFrame(page); await page.waitForTimeout(60) }
}
const select = async (page, id) => {
  const away = await screenOf(page, 700, 1000)
  await page.mouse.click(away.x, away.y)
  const c = await centre(page, id)
  await page.mouse.click(c.x, c.y)
  await page.waitForTimeout(80)
}
const tool = (page, name) => page.click(`[data-tool="${name}"]`)
const dragState = (page) => scene(page, 'dragState')
const shot = async (page, name) => { if (process.env.PAGES_DEBUG) await page.screenshot({ path: `${process.env.PAGES_DEBUG}/${name}.png` }) }
// the on-screen position of an object's top-left corner (to see that nothing seems to move when pages are added)
const cornerOf = async (page, id) => { const c = await centre(page, id); return { x: c.left, y: c.top } }

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error' && !/409 \(Conflict\)|revision does not match/.test(message.text())) errors.push(message.text()) })
  await mock(page, () => stored)
  await open(page)

  // ---------------------------------------------------------------- the note opens with its arrows in line
  let d = await doc(page)
  check('opening a note brings a stale arrow in line with the two objects it joins', consistent(d), JSON.stringify(d.objects.filter((o) => o.type === 'connector').map((o) => o.geometry)))
  check('both arrows are on screen', await scene(page, 'hasNode', 'c1') && await scene(page, 'hasNode', 'c2'))
  const c1Line = await page.evaluate(() => { const o = window.__personalNote.leaferEdits.doc.objects.find((x) => x.id === 'c1'); return o.geometry })
  check('the arrow between A and B runs between their facing edges', c1Line.x > 300 && c1Line.x < 320 && c1Line.x + c1Line.width < 500 && c1Line.x + c1Line.width > 480, JSON.stringify(c1Line))

  // ---------------------------------------------------------------- an arrow follows its end live and in the saved note
  const baseSteps = await steps(page)
  await select(page, 'B')
  let cB = await centre(page, 'B')
  const before = await doc(page)
  await drag(page, cB, { x: cB.x - 60, y: cB.y + 140 }, { hold: true })
  await shot(page, 'lift-mid-drag')
  const midDoc = await doc(page)
  check('while B is dragged the document is still the old one (nothing is recorded until it lands)', JSON.stringify(objectOf(midDoc, 'c1').geometry) === JSON.stringify(objectOf(before, 'c1').geometry) && (await steps(page)) === baseSteps)
  check('while B is dragged it is lifted (tilted two degrees)', (await dragState(page)).lifted.join() === 'B' && Math.abs((await dragState(page)).tilt[0] - 2) < 1e-9, JSON.stringify(await dragState(page)))
  await page.mouse.up()
  await nextFrame(page)
  await page.waitForTimeout(100)
  d = await doc(page)
  const b1 = objectOf(d, 'B').geometry
  check('B landed where it was dragged (60 left, 140 down, screen px)', b1.rotation === 0 && b1.y > objectOf(before, 'B').geometry.y + 100, JSON.stringify(b1))
  check('the arrow A-B follows B in the saved model, and so does C-A (unchanged)', consistent(d) && JSON.stringify(objectOf(d, 'c2').geometry) === JSON.stringify(objectOf(before, 'c2').geometry), JSON.stringify(objectOf(d, 'c1').geometry))
  check('the lift is gone and the object is untilted', (await dragState(page)).lifted.length === 0 && (await dragState(page)).ghost === null)
  check('one undo step', (await steps(page)) === baseSteps + 1)
  await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  d = await doc(page)
  check('undo puts B and its arrow back', JSON.stringify(objectOf(d, 'B').geometry) === JSON.stringify(objectOf(before, 'B').geometry) && JSON.stringify(objectOf(d, 'c1').geometry) === JSON.stringify(objectOf(before, 'c1').geometry))
  await page.evaluate(() => window.__personalNote.leaferEdits.redo())
  await page.waitForTimeout(900)
  check('the saved note has the arrow in line', consistent(savedDoc()))

  // ---------------------------------------------------------------- a page appears as an object nears the right edge, and the ghost shows first
  {
    await select(page, 'B')
    const start = await centre(page, 'B')
    const beforeDoc = await doc(page)
    const stepsBefore = await steps(page)
    const gBefore = objectOf(beforeDoc, 'B').geometry
    const toward = async (rightEdgePageX) => { // drag B so that its right edge is at this page x
      const cNow = await centre(page, 'B')
      const target = await screenOf(page, rightEdgePageX - gBefore.width / 2 - 1, gBefore.y + gBefore.height / 2)
      return { from: cNow, to: { x: target.x, y: cNow.y } }
    }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    let leg = await toward(W - 100)
    for (let i = 1; i <= 8; i += 1) { await page.mouse.move(start.x + ((leg.to.x - start.x) * i) / 8, start.y); await nextFrame(page) }
    const near1 = await dragState(page)
    check('near the right edge (160 px) the page that would be added is previewed as "Page 2"', near1.ghost?.pageNumber === 2 && near1.ghost.rect.left === W && near1.ghost.rect.width === W, JSON.stringify(near1.ghost))
    check('the preview is not a page yet (the grid is still 1 x 1)', (await grid(page)).columns === 1)
    await shot(page, 'ghost')
    const sampleBefore = await cornerOf(page, 'A')
    const from2 = await centre(page, 'B')
    const target2 = await screenOf(page, W + 30 - gBefore.width / 2, gBefore.y + gBefore.height / 2)
    for (let i = 1; i <= 8; i += 1) { await page.mouse.move(from2.x + ((target2.x - from2.x) * i) / 8, start.y); await nextFrame(page) }
    check('past 24 px from the edge a page appears at once, while dragging', (await grid(page)).columns === 2, JSON.stringify(await grid(page)))
    check('the grid in the document is still the old one until the drop', (await doc(page)).page.columns === 1)
    check('adding a page on the right moves nothing on screen', (await cornerOf(page, 'A')).x === sampleBefore.x)
    await shot(page, 'grown')
    const putsBefore = puts.length
    await page.mouse.up()
    await nextFrame(page)
    await page.waitForTimeout(150)
    d = await doc(page)
    check('after the drop: two pages in the document, in the same single undo step as the move', d.page.columns === 2 && (await steps(page)) === stepsBefore + 1, `${JSON.stringify(d.page)} steps ${await steps(page)} vs ${stepsBefore}`)
    check('the ghost is gone, the lift is gone', (await dragState(page)).ghost === null && (await dragState(page)).lifted.length === 0)
    check('the arrows follow, and the note is saved with 2 pages', consistent(d) && (await waitSave(page, putsBefore)) && puts.at(-1).pageState.columns === 2, JSON.stringify(puts.at(-1)?.pageState))
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    d = await doc(page)
    check('one undo takes the move and the page back', d.page.columns === 1 && JSON.stringify(objectOf(d, 'B').geometry) === JSON.stringify(gBefore) && (await grid(page)).columns === 1, JSON.stringify(d.page))
    await page.evaluate(() => window.__personalNote.leaferEdits.redo())
    d = await doc(page)
    check('redo brings both back', d.page.columns === 2 && (await grid(page)).columns === 2)
    // fold back: B goes home, the page it emptied folds in the same step
    await select(page, 'B')
    const home = await centre(page, 'B')
    const homeTo = await screenOf(page, 300, 260)
    const stepsFold = await steps(page)
    await drag(page, home, homeTo)
    d = await doc(page)
    check('moving the object back folds the emptied page in the same step', d.page.columns === 1 && (await grid(page)).columns === 1 && (await steps(page)) === stepsFold + 1, JSON.stringify(d.page))
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    check('undoing the fold-back brings the page and the object back', (await doc(page)).page.columns === 2)
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    check('undo to the start: one page, the original layout', (await doc(page)).page.columns === 1)
    while ((await steps(page)) > 0) await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  }

  // ---------------------------------------------------------------- up and left: a page is added there, everything moves a page, nothing seems to move
  {
    const beforeDoc = await doc(page)
    const stepsBefore = await steps(page)
    await select(page, 'A')
    const startA = await centre(page, 'A')
    const aBox = objectOf(beforeDoc, 'A').geometry
    const cBefore = await cornerOf(page, 'C')
    // drag A over the top-left corner: its box ends at page (-40, -60)
    const target = await screenOf(page, -40 + (aBox.width + 2) / 2, -60 + (aBox.height + 2) / 2)
    await page.mouse.move(startA.x, startA.y)
    await page.mouse.down()
    for (let i = 1; i <= 14; i += 1) { await page.mouse.move(startA.x + ((target.x - startA.x) * i) / 14, startA.y + ((target.y - startA.y) * i) / 14); await nextFrame(page) }
    const live = await page.evaluate(() => ({ grid: { ...window.__personalNote.state.pages }, drag: window.__personalNote.leaferCanvas().dragState() }))
    check('dragging past the top-left corner adds a page on the left and one above, at once', live.grid.columns === 2 && live.grid.rows === 2 && live.drag.shift.x === W && live.drag.shift.y === H, JSON.stringify(live))
    const cMid = await cornerOf(page, 'C')
    check('an object that is not dragged stays where it is on screen while the pages are added', Math.abs(cMid.x - cBefore.x) < 0.01 && Math.abs(cMid.y - cBefore.y) < 0.01, `${JSON.stringify(cBefore)} -> ${JSON.stringify(cMid)}`)
    check('the document still has the old frame until the drop', (await doc(page)).page.columns === 1 && objectOf(await doc(page), 'C').geometry.x === 300)
    await shot(page, 'grown-up-left')
    await page.mouse.up()
    await nextFrame(page)
    await page.waitForTimeout(150)
    let d2 = await doc(page)
    check('after the drop every object has moved a page right and a page down, in one undo step', objectOf(d2, 'C').geometry.x === 300 + W && objectOf(d2, 'C').geometry.y === 600 + H && objectOf(d2, 'B').geometry.x === objectOf(beforeDoc, 'B').geometry.x + W && d2.page.columns === 2 && d2.page.rows === 2 && (await steps(page)) === stepsBefore + 1, JSON.stringify(d2.page))
    check('the dragged object is inside the new first page', objectOf(d2, 'A').geometry.x < 0 + W && objectOf(d2, 'A').geometry.x > W - aBox.width && objectOf(d2, 'A').geometry.y < H, JSON.stringify(objectOf(d2, 'A').geometry))
    check('the arrows moved with it and still join the two ends', consistent(d2))
    const cAfter = await cornerOf(page, 'C')
    check('after the drop nothing has jumped on screen', Math.abs(cAfter.x - cBefore.x) < 0.01 && Math.abs(cAfter.y - cBefore.y) < 0.01, `${JSON.stringify(cBefore)} -> ${JSON.stringify(cAfter)}`)
    const view0 = await scene(page, 'view')
    await page.evaluate(([x, y]) => window.__personalNote.setCanvasViewportOffset(x + 1, y), [view0.x, view0.y])
    const cPanned = await cornerOf(page, 'C')
    check('after pages were added, panning by 1 px moves the content by 1 px: no snap, nothing re-centres', Math.abs(cPanned.x - cAfter.x - 1) < 0.01 && Math.abs(cPanned.y - cAfter.y) < 0.01, `${JSON.stringify(cAfter)} -> ${JSON.stringify(cPanned)}`)
    cBefore.x += 1 // (the view may move back toward its range, not further out, so the 1 px stays)
    // saved
    check('the saved note has 2 x 2 pages and the shifted objects', (await waitSave(page, puts.length - 1)) && (await new Promise((resolve) => setTimeout(resolve, 900))) === undefined && puts.at(-1).pageState.columns === 2 && puts.at(-1).pageState.rows === 2 && objectOf(savedDoc(), 'C').geometry.x === 300 + W, JSON.stringify(puts.at(-1)?.pageState))
    // undo: everything moves back, the view follows
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    d2 = await doc(page)
    const cUndone = await cornerOf(page, 'C')
    check('undo puts every object and the page grid back', d2.page.columns === 1 && d2.page.rows === 1 && JSON.stringify(objectOf(d2, 'A').geometry) === JSON.stringify(aBox) && objectOf(d2, 'C').geometry.x === 300)
    check('undo does not make the picture jump', Math.abs(cUndone.x - cBefore.x) < 0.01 && Math.abs(cUndone.y - cBefore.y) < 0.01, `${JSON.stringify(cBefore)} -> ${JSON.stringify(cUndone)}`)
    await page.evaluate(() => window.__personalNote.leaferEdits.redo())
    const cRedone = await cornerOf(page, 'C')
    await page.evaluate(() => window.__personalNote.setCanvasViewportOffset())
    const cRedoneSettled = await cornerOf(page, 'C')
    check('redo settles the view at once: a later pan or zoom does not snap it', Math.abs(cRedone.x - cRedoneSettled.x) < 0.01 && Math.abs(cRedone.y - cRedoneSettled.y) < 0.01, `${JSON.stringify(cRedone)} -> ${JSON.stringify(cRedoneSettled)}`)
    // fold back: A goes home; the first page and the first row it emptied fold away and everything moves back
    await select(page, 'A')
    const there = await centre(page, 'A')
    const homeAt = await screenOf(page, 100 + W + 100, 200 + H + 60)
    const stepsFold = await steps(page)
    await drag(page, there, homeAt)
    d2 = await doc(page)
    const cFold = await cornerOf(page, 'C')
    check('moving it back into the middle folds the empty first page and row away, everything moves back, one step', d2.page.columns === 1 && d2.page.rows === 1 && objectOf(d2, 'C').geometry.x === 300 && objectOf(d2, 'C').geometry.y === 600 && (await steps(page)) === stepsFold + 1, JSON.stringify(d2.page))
    check('the fold-back does not make the picture jump, and the view is settled (no later snap)', Math.abs(cFold.x - cBefore.x) < 0.01 && Math.abs(cFold.y - cBefore.y) < 0.01, `${JSON.stringify(cBefore)} -> ${JSON.stringify(cFold)}`)
    await page.evaluate(() => window.__personalNote.setCanvasViewportOffset())
    const cFoldSettled = await cornerOf(page, 'C')
    check('and a later pan or zoom does not move it', Math.abs(cFoldSettled.x - cFold.x) < 0.01 && Math.abs(cFoldSettled.y - cFold.y) < 0.01, `${JSON.stringify(cFold)} -> ${JSON.stringify(cFoldSettled)}`)
    while ((await steps(page)) > 0) await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    check('undone to the start', (await doc(page)).page.columns === 1)
    // a view that no longer overlaps any page goes at once to the nearest page edge (it is otherwise never moved)
    await page.evaluate(() => window.__personalNote.setCanvasViewportOffset(-5000, 104, true))
    const lost = await scene(page, 'view')
    await page.evaluate(() => window.__personalNote.setCanvasViewportOffset())
    const found = await page.evaluate(() => { const v = window.__personalNote.leaferCanvas().view(); const g = window.__personalNote.state.pages; return { x: v.x, y: v.y, right: v.x + g.columns * 860 * v.scale, width: window.__personalNote.viewSize.width } })
    check('a view that left every page behind (after an undo or a fold-back) comes back at once, to the nearest page edge', lost.x < -4000 && found.right > 0 && found.x < found.width, JSON.stringify([lost, found]))
    await page.evaluate(() => { window.__personalNote.setCanvasViewportOffset(300, 104, true) })
  }

  // ---------------------------------------------------------------- an arrow follows an end that is resized or turned
  {
    const info = (id) => scene(page, 'nodeInfo', id)
    await select(page, 'A')
    let before1 = await doc(page)
    const gA = objectOf(before1, 'A').geometry
    let c = await centre(page, 'A')
    const arrowAtStart = await info('c1')
    const stepsBefore = await steps(page)
    await drag(page, { x: c.right, y: c.bottom }, { x: c.right + 80, y: c.bottom + 60 }, { hold: true })
    const arrowMid = await info('c1')
    check('while A is resized, the arrow A-B is redrawn live (its node changed before the drop)', JSON.stringify(arrowMid) !== JSON.stringify(arrowAtStart), JSON.stringify([arrowAtStart, arrowMid]))
    await page.mouse.up()
    await nextFrame(page)
    await page.waitForTimeout(120)
    let d3 = await doc(page)
    const gA2 = objectOf(d3, 'A').geometry
    check('A is bigger by the drag, in one undo step', gA2.width > gA.width + 60 && (await steps(page)) === stepsBefore + 1, JSON.stringify([gA, gA2]))
    check('the arrows follow the resized A in the model and on screen', consistent(d3) && JSON.stringify(objectOf(d3, 'c1').geometry) !== JSON.stringify(objectOf(before1, 'c1').geometry), JSON.stringify(objectOf(d3, 'c1').geometry))
    const nodeNow = await info('c1')
    check('the arrow node is where the model has it', near(nodeNow.x, objectOf(d3, 'c1').geometry.x, 0.01) && near(nodeNow.y, objectOf(d3, 'c1').geometry.y, 0.01), JSON.stringify(nodeNow))
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    // turn A by 45 degrees: the arrow follows the bounding box of the turned object
    before1 = await doc(page)
    await select(page, 'A')
    c = await centre(page, 'A')
    const middle = { x: (c.left + c.right) / 2, y: (c.top + c.bottom) / 2 }
    const start = { x: c.right + 9, y: c.bottom + 9 }
    const angle = Math.PI / 4
    const dxs = start.x - middle.x
    const dys = start.y - middle.y
    const end = { x: middle.x + dxs * Math.cos(angle) - dys * Math.sin(angle), y: middle.y + dxs * Math.sin(angle) + dys * Math.cos(angle) }
    await drag(page, start, end, { hold: true })
    const turnedMid = await info('c1')
    await page.mouse.up()
    await nextFrame(page)
    await page.waitForTimeout(120)
    d3 = await doc(page)
    check('A is turned about 45 degrees', Math.abs(objectOf(d3, 'A').geometry.rotation - 45) < 4, String(objectOf(d3, 'A').geometry.rotation))
    check('the arrows follow the turned A (the Fabric rule: its bounding box), live and saved', consistent(d3) && JSON.stringify(objectOf(d3, 'c1').geometry) !== JSON.stringify(objectOf(before1, 'c1').geometry) && near(turnedMid.x, objectOf(d3, 'c1').geometry.x, 8), `${JSON.stringify(turnedMid)} vs ${JSON.stringify(objectOf(d3, 'c1').geometry)}`)
    await shot(page, 'turned')
    await waitSave(page, puts.length - 1)
    await page.waitForTimeout(900)
    check('the saved note has the arrows in line with the resized and turned object', consistent(savedDoc()))
    while ((await steps(page)) > 0) await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    d3 = await doc(page)
    check('undoing both puts A and the arrows back as they were', JSON.stringify(objectOf(d3, 'A').geometry) === JSON.stringify(gA) && consistent(d3))
  }

  // ---------------------------------------------------------------- the connect tool: create, refuse, undo
  {
    const stepsBefore = await steps(page)
    const connectors = async () => (await doc(page)).objects.filter((o) => o.type === 'connector')
    const countBefore = (await connectors()).length
    await tool(page, 'connect')
    check('the connect tool is on, and its surface takes the pointer', await page.evaluate(() => window.__personalNote.state.tool === 'connect' && getComputedStyle(document.querySelector('.connect-surface')).display !== 'none'))
    const cb = await centre(page, 'B')
    const cc = await centre(page, 'C')
    await page.mouse.move(cb.x, cb.y)
    check('hovering an object outlines it', (await scene(page, 'overlayState')).outlines === 1 && (await scene(page, 'overlayState')).dots === 1, JSON.stringify(await scene(page, 'overlayState')))
    await page.mouse.down()
    for (let i = 1; i <= 8; i += 1) { await page.mouse.move(cb.x + ((cc.x - cb.x) * i) / 8, cb.y + ((cc.y - cb.y) * i) / 8); await nextFrame(page) }
    const draft = await scene(page, 'overlayState')
    check('while drawing, the source and the target are outlined and the arrow is drawn', draft.outlines === 2 && draft.draft && draft.dots === 2, JSON.stringify(draft))
    await shot(page, 'connect-draft')
    await page.mouse.up()
    await nextFrame(page)
    await page.waitForTimeout(100)
    let list = await connectors()
    const made = list.find((o) => o.fromId === 'B' && o.toId === 'C')
    check('letting go on another object makes an arrow from the first to the second, in one undo step', list.length === countBefore + 1 && Boolean(made) && (await steps(page)) === stepsBefore + 1, JSON.stringify(list.map((o) => [o.fromId, o.toId])))
    check('the new arrow is in line with its ends, on screen, with the tool colour', consistent(await doc(page)) && await scene(page, 'hasNode', made.id) && made.color === (await page.evaluate(() => window.__personalNote.state.color)), JSON.stringify(made))
    check('the preview is gone', (await scene(page, 'overlayState')).draft === false && (await scene(page, 'overlayState')).outlines === 0)
    // the same pair again, the same object, empty paper: nothing
    await page.mouse.move(cb.x, cb.y)
    await page.mouse.down()
    await page.mouse.move(cc.x, cc.y, { steps: 6 })
    await page.mouse.up()
    check('the same pair again makes no second arrow', (await connectors()).length === countBefore + 1 && (await steps(page)) === stepsBefore + 1)
    await page.mouse.move(cb.x, cb.y)
    await page.mouse.down()
    await page.mouse.move(cb.x + 4, cb.y + 4, { steps: 3 })
    await page.mouse.up()
    check('letting go on the same object makes none', (await connectors()).length === countBefore + 1)
    const empty = await screenOf(page, 780, 1040)
    await page.mouse.move(empty.x, empty.y)
    await page.mouse.down()
    await page.mouse.move(cc.x, cc.y, { steps: 6 })
    await page.mouse.up()
    check('pressing on empty paper starts nothing', (await connectors()).length === countBefore + 1 && (await steps(page)) === stepsBefore + 1)
    await page.mouse.move(cb.x, cb.y)
    await page.mouse.down()
    await page.mouse.move(cc.x, cc.y, { steps: 4 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    check('Escape while drawing drops the arrow', (await connectors()).length === countBefore + 1 && (await scene(page, 'overlayState')).draft === false, JSON.stringify(await scene(page, 'overlayState')))
    await tool(page, 'select')
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    check('undo takes the new arrow away, from the document and from the screen', (await connectors()).length === countBefore && !(await scene(page, 'hasNode', made.id)))
    await page.evaluate(() => window.__personalNote.leaferEdits.redo())
    check('redo brings it back, on screen', (await connectors()).length === countBefore + 1 && await scene(page, 'hasNode', made.id))
    await page.waitForTimeout(900)
    check('the saved note has the new arrow as an edge between the two', savedDoc().objects.some((o) => o.type === 'connector' && o.fromId === 'B' && o.toId === 'C'))
    // the new arrow follows too
    await select(page, 'C')
    const cNow = await centre(page, 'C')
    const arrowBefore = await scene(page, 'nodeInfo', made.id)
    await drag(page, cNow, { x: cNow.x - 40, y: cNow.y + 60 })
    check('and it follows when C is moved', consistent(await doc(page)) && JSON.stringify(await scene(page, 'nodeInfo', made.id)) !== JSON.stringify(arrowBefore))
  }

  // ---------------------------------------------------------------- pick an arrow by its line, delete it; delete an object and its arrows go
  {
    const before2 = await doc(page)
    const stepsBefore = await steps(page)
    await page.mouse.click(5, 5) // nothing selected
    const line = objectOf(before2, 'c1').geometry
    const midLine = await screenOf(page, line.x + line.width / 2, line.y + line.height / 2)
    await page.mouse.click(midLine.x, midLine.y)
    check('a click on the arrow\'s line picks it, with its halo', (await scene(page, 'selectedConnector')) === 'c1' && (await scene(page, 'overlayState')).halo === true && (await scene(page, 'selection')).join() === 'c1', JSON.stringify([await scene(page, 'selectedConnector'), await scene(page, 'overlayState')]))
    await shot(page, 'arrow-picked')
    const offLine = await screenOf(page, line.x + line.width / 2 + 3, line.y + line.height / 2 - 120)
    await page.mouse.click(offLine.x, offLine.y)
    check('a click away from the line lets go of it', (await scene(page, 'selectedConnector')) === null && (await scene(page, 'overlayState')).halo === false)
    await page.mouse.click(midLine.x, midLine.y)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(100)
    let after = await doc(page)
    check('Delete removes the arrow and nothing else, in one undo step', !after.objects.some((o) => o.id === 'c1') && after.objects.length === before2.objects.length - 1 && (await steps(page)) === stepsBefore + 1 && !(await scene(page, 'hasNode', 'c1')))
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    check('undo brings the arrow back, in the same place', JSON.stringify(objectOf(await doc(page), 'c1')) === JSON.stringify(objectOf(before2, 'c1')) && await scene(page, 'hasNode', 'c1'))
    // delete an object: its arrows go with it, in the same step
    const connectedTo = (d, id) => d.objects.filter((o) => o.type === 'connector' && (o.fromId === id || o.toId === id)).map((o) => o.id)
    const arrowsOfA = connectedTo(before2, 'A')
    await select(page, 'A')
    await page.keyboard.press('Delete')
    await page.waitForTimeout(100)
    after = await doc(page)
    check('deleting A takes every arrow on it with it, in one step', !after.objects.some((o) => o.id === 'A') && arrowsOfA.length >= 2 && arrowsOfA.every((id) => !after.objects.some((o) => o.id === id)) && (await steps(page)) === stepsBefore + 1)
    check('and they are gone from the screen', (await Promise.all(arrowsOfA.map((id) => scene(page, 'hasNode', id)))).every((has) => !has) && !(await scene(page, 'hasNode', 'A')))
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    after = await doc(page)
    check('one undo brings A and its arrows back', after.objects.some((o) => o.id === 'A') && arrowsOfA.every((id) => after.objects.some((o) => o.id === id)) && (await Promise.all(arrowsOfA.map((id) => scene(page, 'hasNode', id)))).every(Boolean) && consistent(after))
    while ((await steps(page)) > 0) await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  }

  // ---------------------------------------------------------------- a reload shows the same note
  {
    const putsBefore = puts.length
    await select(page, 'B')
    const cb = await centre(page, 'B')
    await drag(page, cb, { x: cb.x + 50, y: cb.y + 90 })
    await tool(page, 'connect')
    const cc = await centre(page, 'C')
    const cb2 = await centre(page, 'B')
    await drag(page, cb2, cc)
    await tool(page, 'select')
    await select(page, 'C')
    const cs = await centre(page, 'C')
    const target = await screenOf(page, W + 140, 800) // a second page appears under it
    await drag(page, cs, target)
    check('a note with a moved object, a new arrow and a second page', (await grid(page)).columns === 2 && (await doc(page)).objects.filter((o) => o.type === 'connector').length === 3)
    await waitSave(page, putsBefore)
    await page.waitForTimeout(1200)
    const live = await doc(page)
    const saved = savedDoc()
    const shape = (d) => d.objects.map((o) => [o.id, o.type, o.fromId, o.toId, o.geometry && ['x', 'y', 'width', 'height', 'rotation'].map((k) => Math.round((o.geometry[k] ?? 0) * 1e6) / 1e6)])
    check('what was saved is what is on screen', JSON.stringify(shape(saved)) === JSON.stringify(shape(live)) && saved.page.columns === live.page.columns && saved.page.rows === live.page.rows, JSON.stringify(shape(saved)).slice(0, 200))
    await page.evaluate(() => { const { state, setCanvasViewportOffset } = window.__personalNote; state.canvasZoom = 1; setCanvasViewportOffset(20, 104) })
    await page.waitForTimeout(300)
    const region = { x: 232, y: 100, width: 830, height: 560 } // the pages, not the chrome around them
    const mask = async () => page.evaluate(() => { document.querySelector('.selection-bar').hidden = true; document.querySelector('#save-state') && (document.querySelector('#save-state').style.visibility = 'hidden') })
    await page.evaluate(() => window.__personalNote.leaferCanvas().clearSelection())
    await mask()
    const first = await page.screenshot({ clip: region })
    await page.reload()
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
    await page.waitForTimeout(500)
    await page.evaluate(() => window.__personalNote.setTool('select'))
    const again = await doc(page)
    check('after a reload the note has the same objects, arrows and pages', JSON.stringify(shape(again)) === JSON.stringify(shape(live)) && again.page.columns === 2 && again.page.rows === 1 && consistent(again))
    await page.evaluate(() => { const { state, setCanvasViewportOffset } = window.__personalNote; state.canvasZoom = 1; setCanvasViewportOffset(20, 104) })
    await page.waitForTimeout(300)
    await mask()
    const second = await page.screenshot({ clip: region })
    const differing = await page.evaluate(async ([one, two]) => {
      const load = async (data) => { const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob()); const c = new OffscreenCanvas(image.width, image.height); const x = c.getContext('2d'); x.drawImage(image, 0, 0); return x.getImageData(0, 0, image.width, image.height).data }
      const [a, b] = await Promise.all([load(one), load(two)])
      let count = 0
      const at = []
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) { count += 1; if (at.length < 4) at.push([(i / 4) % 830, Math.floor(i / 4 / 830), a[i] - b[i]]) }
      return { count, at }
    }, [first.toString('base64'), second.toString('base64')])
    check('and it looks the same: pages, arrows and objects are pixel-identical to before the reload', differing.count === 0, JSON.stringify(differing))
    await shot(page, 'after-reload')
    // clean up to one page for what follows
    await select(page, 'C')
    const c2 = await centre(page, 'C')
    await drag(page, c2, await screenOf(page, 380, 700))
    await page.waitForTimeout(1000)
    while ((await steps(page)) > 0) await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  }

  // ---------------------------------------------------------------- an agent writes: a page, a moved object with arrows on it
  {
    const before3 = await doc(page)
    const stepsBefore = await steps(page)
    agentWrite((d) => { d.page = { ...d.page, columns: d.page.columns + 1 }; d.objects.push(rect('D', W + 120, 300, 160, 100, 99)) })
    await page.waitForTimeout(4500)
    let d4 = await doc(page)
    check('an agent that adds a page and an object on it: the grid grows, the object is there, nothing is added to undo', (await grid(page)).columns === before3.page.columns + 1 && d4.page.columns === before3.page.columns + 1 && Boolean(objectOf(d4, 'D')) && await scene(page, 'hasNode', 'D') && (await steps(page)) === stepsBefore, JSON.stringify([await grid(page), d4.page]))
    check('the chrome shows the new page', (await scene(page, 'gridNow')).columns === d4.page.columns, JSON.stringify([await scene(page, 'gridNow'), d4.page]))
    const gB = objectOf(d4, 'B').geometry
    agentWrite((d) => { const b = objectOf(d, 'B'); b.geometry = { ...b.geometry, y: b.geometry.y + 260 } }) // an agent moves B; it leaves the arrows alone
    await page.waitForTimeout(4500)
    d4 = await doc(page)
    const nodeB = await scene(page, 'nodeInfo', 'B')
    check('an agent that moves a connected object: it moves on screen', objectOf(d4, 'B').geometry.y === gB.y + 260 && near(nodeB.y, gB.y + 260, 2), `${objectOf(d4, 'B').geometry.y} vs ${gB.y + 260}`)
    check('its arrows follow it, in the document and on screen', consistent(d4) && JSON.stringify(objectOf(d4, 'c1').geometry) !== JSON.stringify(objectOf(before3, 'c1').geometry))
    const arrowNode = await scene(page, 'nodeInfo', 'c1')
    check('the arrow node is where the model has it', near(arrowNode.x, objectOf(d4, 'c1').geometry.x, 0.01) && near(arrowNode.y, objectOf(d4, 'c1').geometry.y, 0.01))
    check('the merge is not an edit: undo has nothing from it', (await steps(page)) === stepsBefore)
    const putsMerged = puts.length
    await waitSave(page, putsMerged)
    await page.waitForTimeout(800)
    console.log('INFO  saves after the merges:', puts.length - putsMerged, await page.evaluate(() => document.querySelector('.save-state, #save-state')?.textContent))
    check('the note saved afterwards has the arrows in line too', consistent(savedDoc()) && Boolean(objectOf(savedDoc(), 'D')), JSON.stringify([consistent(savedDoc()), Boolean(objectOf(savedDoc(), 'D')), puts.length, savedDoc().objects.map((o) => o.id)]))
  }

  // ---------------------------------------------------------------- an agent writes while the user's pages grew on the top and left and the save is held
  {
    const start = await doc(page)
    release = hold()
    await page.waitForTimeout(100)
    await select(page, 'A')
    const sa = await centre(page, 'A')
    const aBox = objectOf(start, 'A').geometry
    const stepsBefore = await steps(page)
    await drag(page, sa, await screenOf(page, -40 + (aBox.width + 2) / 2, -60 + (aBox.height + 2) / 2))
    const local = await doc(page)
    check('(setup) the objects moved a page right and a page down on the user\'s side, the save is held', objectOf(local, 'C').geometry.x === objectOf(start, 'C').geometry.x + W && local.page.rows === start.page.rows + 1 && (await steps(page)) === stepsBefore + 1)
    agentWrite((d) => { d.objects.push({ id: 'AG', type: 'text', mode: 'box', z: 120, content: 'the agent was here', geometry: { x: 120, y: 900, width: 200, height: 60, ...UPRIGHT } }) })
    release() // the held save lands on the agent's revision: refused, so the agent's write is merged (it waits for the save to be answered), then saved again
    await page.waitForTimeout(4500)
    const merged = await doc(page)
    const agent = objectOf(merged, 'AG')
    check('the agent\'s new object arrives in the user\'s frame: where it meant to be, next to the others', Boolean(agent) && agent.geometry.x === 120 + W && agent.geometry.y === 900 + H && objectOf(merged, 'C').geometry.x === objectOf(local, 'C').geometry.x, JSON.stringify(agent?.geometry))
    check('the user\'s move is kept and is still one undo step', objectOf(merged, 'A').geometry.x === objectOf(local, 'A').geometry.x && (await steps(page)) === stepsBefore + 1)
    release()
    await page.waitForTimeout(2500)
    const finalSaved = savedDoc()
    check('after the held save lands, the saved note has the agent\'s object in the same place relative to C as the agent wrote it', Boolean(objectOf(finalSaved, 'AG')) && near(objectOf(finalSaved, 'AG').geometry.x - objectOf(finalSaved, 'C').geometry.x, 120 - objectOf(start, 'C').geometry.x, 1e-6) && near(objectOf(finalSaved, 'AG').geometry.y - objectOf(finalSaved, 'C').geometry.y, 900 - objectOf(start, 'C').geometry.y, 1e-6) && consistent(finalSaved), JSON.stringify([objectOf(finalSaved, 'AG')?.geometry, objectOf(finalSaved, 'C')?.geometry]))
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    const undone = await doc(page)
    check('undoing the user\'s move moves the agent\'s object back with the frame: same place relative to C, and inside the grid', Boolean(objectOf(undone, 'AG')) && near(objectOf(undone, 'AG').geometry.x - objectOf(undone, 'C').geometry.x, 120 - objectOf(start, 'C').geometry.x, 1e-6) && near(objectOf(undone, 'AG').geometry.y - objectOf(undone, 'C').geometry.y, 900 - objectOf(start, 'C').geometry.y, 1e-6) && objectOf(undone, 'AG').geometry.x + 200 <= undone.page.columns * W && objectOf(undone, 'AG').geometry.y + 60 <= undone.page.rows * H && objectOf(undone, 'AG').geometry.x >= 0 && objectOf(undone, 'AG').geometry.y >= 0, JSON.stringify([objectOf(undone, 'AG')?.geometry, undone.page]))
  }

  // ---------------------------------------------------------------- a picture placed near an edge grows the page (F-033's pictures go through the same step)
  {
    const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
    const startDoc = await doc(page)
    const stepsBefore = await steps(page)
    const add = (x, y) => page.evaluate(([px, py]) => window.__personalNote.leaferCanvas().addImages([{ mediaId: 'pic-edge', url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', width: 400, height: 300 }], { x: px, y: py }), [x, y])
    const [rightId] = await add(startDoc.page.columns * W - 20, 500)
    let d5 = await doc(page)
    check('a picture put over the right edge adds a page, in the same undo step', Boolean(rightId) && d5.page.columns === startDoc.page.columns + 1 && (await steps(page)) === stepsBefore + 1, JSON.stringify([d5.page, await steps(page)]))
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    d5 = await doc(page)
    check('one undo takes the picture and the page away', d5.page.columns === startDoc.page.columns && !d5.objects.some((o) => o.id === rightId))
    const [leftId] = await add(40, 40)
    d5 = await doc(page)
    check('a picture put over the top-left corner adds pages above and to the left (and tidies the spare ones), moves everything a page, in one step', Boolean(leftId) && d5.page.rows > startDoc.page.rows && near(objectOf(d5, 'C').geometry.x, objectOf(startDoc, 'C').geometry.x + W, 1e-6) && (await steps(page)) === stepsBefore + 1, JSON.stringify([startDoc.page, d5.page, objectOf(startDoc, 'C')?.geometry?.x, objectOf(d5, 'C')?.geometry?.x, await steps(page), stepsBefore]))
    await page.evaluate(() => window.__personalNote.leaferEdits.undo())
    d5 = await doc(page)
    check('and one undo puts the picture, the pages and every object back', d5.page.columns === startDoc.page.columns && near(objectOf(d5, 'C').geometry.x, objectOf(startDoc, 'C').geometry.x, 1e-6) && consistent(d5))
  }


  // ---------------------------------------------------------------- the server's frame: after a merge and a save, an agent writes again, in the frame the save left
  {
    const start = await doc(page)
    release = hold()
    await select(page, 'A')
    const sa = await centre(page, 'A')
    const aBox = objectOf(start, 'A').geometry
    await drag(page, sa, await screenOf(page, -40 + (aBox.width + 2) / 2, -60 + (aBox.height + 2) / 2)) // pages on the top and left: the frame moves; the save is held
    await page.waitForTimeout(1200)
    agentWrite((d) => { objectOf(d, 'C').color = '#aaddff' }) // a first write by the agent: the held save will be refused, the write merged, the note saved again
    release()
    await page.waitForTimeout(4500)
    agentWrite((d) => { const c = objectOf(d, 'C').geometry; d.objects.push({ id: 'AG2', type: 'text', mode: 'box', z: 131, content: 'second write', geometry: { x: c.x + 300, y: c.y, width: 200, height: 60, ...UPRIGHT } }) }) // written in the frame the server holds now: the user's
    await page.waitForTimeout(4500)
    const merged2 = await doc(page)
    const c2 = objectOf(merged2, 'C').geometry
    check('the second write lands where the agent meant, next to C (the server\'s frame is the one the save left it in)', Boolean(objectOf(merged2, 'AG2')) && near(objectOf(merged2, 'AG2').geometry.x - c2.x, 300, 1e-6) && near(objectOf(merged2, 'AG2').geometry.y - c2.y, 0, 1e-6), JSON.stringify([objectOf(merged2, 'AG2')?.geometry, c2]))
    await page.waitForTimeout(2500)
    const finalDoc = readJsonCanvas(stored.content)
    check('the note saved at the end has the second write in place', near(objectOf(finalDoc, 'AG2').geometry.x - objectOf(finalDoc, 'C').geometry.x, 300, 1e-6))
    while ((await steps(page)) > 0) await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  }
  check('no page errors', errors.length === 0, errors.join(' | '))
  await context.close()

  // ---------------------------------------------------------------- the most connected object of the 600-object, 12-page note, dragged
  const big = { content: generateNote(), pageState: { columns: COLUMNS, rows: ROWS }, revision: 1 }
  for (const dpr of [1, 2]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr })
    const bigPage = await ctx.newPage()
    const bigErrors = []
    bigPage.on('pageerror', (error) => bigErrors.push(error.message))
    await mock(bigPage, () => big)
    await open(bigPage)
    const hub = await bigPage.evaluate(() => window.__personalNote.leaferEdits.doc.objects.find((o) => o.id === 'res_rect_3'))
    const arrows = await bigPage.evaluate(() => window.__personalNote.leaferEdits.doc.objects.filter((o) => o.type === 'connector' && (o.fromId === 'res_rect_3' || o.toId === 'res_rect_3')).length)
    const objects = await bigPage.evaluate(() => window.__personalNote.leaferEdits.doc.objects.length)
    await bigPage.evaluate(([gx, gy]) => {
      const { viewSize, state, getCanvasScale, setCanvasViewportOffset } = window.__personalNote
      state.canvasZoom = 1
      setCanvasViewportOffset(viewSize.width / 2 - gx * getCanvasScale(), viewSize.height / 2 - gy * getCanvasScale(), true)
    }, [hub.geometry.x + hub.geometry.width / 2, hub.geometry.y + hub.geometry.height / 2])
    await bigPage.waitForTimeout(600)
    await bigPage.evaluate(() => { window.__personalNote.leaferCanvas().clearSelection() })
    const at = await centre(bigPage, 'res_rect_3')
    await bigPage.mouse.click(at.x, at.y)
    await bigPage.waitForTimeout(150)
    const stepsBeforeBig = await steps(bigPage)
    await bigPage.evaluate(() => {
      window.__frames = []
      window.__proc = []
      let last = performance.now()
      const tick = (time) => { window.__frames.push(time - last); last = time; window.__loop = requestAnimationFrame(tick) }
      window.__loop = requestAnimationFrame(tick)
      let began = 0
      window.addEventListener('pointermove', () => { began = performance.now() }, true)
      window.addEventListener('pointermove', () => { window.__proc.push(performance.now() - began) })
    })
    await bigPage.mouse.move(at.x, at.y)
    await bigPage.mouse.down()
    for (let i = 1; i <= 120; i += 1) {
      const t = i / 120
      await bigPage.mouse.move(at.x + 260 * Math.sin(t * Math.PI), at.y + 180 * t + Math.sin(t * Math.PI * 4) * 30)
      await nextFrame(bigPage)
    }
    const lifted = await dragState(bigPage)
    await bigPage.mouse.up()
    await nextFrame(bigPage)
    const { frames, proc } = await bigPage.evaluate(() => { cancelAnimationFrame(window.__loop); return { frames: window.__frames.slice(2), proc: window.__proc } })
    const q = (list, f) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(f * list.length))]
    console.log(`INFO  600-object note (${objects} objects, ${arrows} arrows on the hub), devicePixelRatio ${dpr}: dragging the hub, frame gap median ${q(frames, 0.5).toFixed(1)} ms, p95 ${q(frames, 0.95).toFixed(1)} ms, max ${Math.max(...frames).toFixed(1)} ms over ${frames.length} frames; time inside the pointer handlers median ${q(proc, 0.5).toFixed(2)} ms, p95 ${q(proc, 0.95).toFixed(2)} ms, max ${Math.max(...proc).toFixed(2)} ms`)
    check(`dpr ${dpr}: the hub is lifted while it is dragged and its ${arrows} arrows are drawn with it`, lifted.lifted.join() === 'res_rect_3' && arrows >= 6, JSON.stringify(lifted))
    // At devicePixelRatio 1 the whole drag is within a frame. At 2 this headless Chromium rasterises in software: the tree before F-032 (measured
    // from the same script on the F-033 head) has the same median 16.7 and p95 66.7 ms, so there the check is that the drag is steady (the median
    // is one frame) and the p95 is reported; the retina number that counts is measured in the Mac app (F-034).
    if (dpr === 1) check('dpr 1: p95 frame while dragging the most connected object is within 16.8 ms', q(frames, 0.95) <= 16.85, `${q(frames, 0.95)}`)
    else check('dpr 2: the median frame while dragging the most connected object is one frame (16.8 ms); the p95 is reported above', q(frames, 0.5) <= 16.85, `${q(frames, 0.5)}`)
    check(`dpr ${dpr}: the drop is one undo step and the arrows are in line`, (await steps(bigPage)) === stepsBeforeBig + 1 && consistent(await doc(bigPage)))
    check(`dpr ${dpr}: no page errors`, bigErrors.length === 0, bigErrors.join(' | '))
    await ctx.close()
  }


  // ---------------------------------------------------------------- typing grows the pages at once (the words, not the end of the session)
  {
    const typeContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const tp = await typeContext.newPage()
    const typeErrors = []
    tp.on('pageerror', (error) => typeErrors.push(error.message))
    const typeNote = { content: store({ schemaVersion: 1, page: { columns: 1, rows: 1 }, extras: {}, objects: [rect('A', 100, 100, 100, 60, 0)] }), pageState: { columns: 1, rows: 1 }, revision: 1 }
    await mock(tp, () => typeNote)
    await open(tp)
    const editor = () => tp.evaluate(() => {
      const el = document.querySelector('.leafer-text-editor')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const host = document.querySelector('#leafer-host').getBoundingClientRect()
      const view = window.__personalNote.leaferCanvas().view()
      return { left: (r.left - host.left - view.x) / view.scale, top: (r.top - host.top - view.y) / view.scale, right: (r.right - host.left - view.x) / view.scale, bottom: (r.bottom - host.top - view.y) / view.scale, screenLeft: r.left, screenTop: r.top }
    })
    const settle = async () => { await tp.keyboard.press('Escape'); await tp.waitForTimeout(250) }
    const stepsStart = await steps(tp)
    const putsBefore = puts.length

    // nothing near an edge: no page
    await scene(tp, 'createText', { x: 100, y: 300 })
    await tp.waitForSelector('.leafer-text-editor')
    await tp.keyboard.type('a few\nshort\nlines')
    check('typing in the middle of the page adds no page', (await grid(tp)).rows === 1 && (await grid(tp)).columns === 1)
    await settle()
    await tp.evaluate(() => window.__personalNote.leaferEdits.undo())

    // bottom: lines pile up until the box nears the bottom edge; the page appears while the session is still open
    await scene(tp, 'createText', { x: 100, y: 800 })
    await tp.waitForSelector('.leafer-text-editor')
    const before = await editor()
    let grewAt = null
    let lines = 0
    for (; lines < 30 && !grewAt; lines += 1) {
      await tp.keyboard.type(`line ${lines}\n`)
      if ((await grid(tp)).rows === 2) grewAt = await editor()
    }
    check('typing down to the bottom edge adds a page before the session ends', Boolean(grewAt) && await tp.evaluate(() => Boolean(document.querySelector('.leafer-text-editor'))), JSON.stringify([lines, await grid(tp)]))
    check('the page appears before the words pass the edge, near it', grewAt && grewAt.bottom <= H + 1 && grewAt.bottom > H - 140, JSON.stringify(grewAt))
    check('the overlay stays exactly where it was (same corner, same words)', grewAt && near(grewAt.left, before.left, 0.5) && near(grewAt.top, before.top, 0.5) && near(grewAt.screenTop, before.screenTop, 0.5) && near(grewAt.screenLeft, before.screenLeft, 0.5), JSON.stringify([before, grewAt]))
    const caret = await tp.evaluate(() => { const a = document.querySelector('.leafer-text-editor'); return [a.selectionStart, a.value.length] })
    check('the caret stays at the end of the words', caret[0] === caret[1], JSON.stringify(caret))
    for (let i = 0; i < 6; i += 1) await tp.keyboard.type(`more ${i}\n`)
    check('typing on inside the new page adds no more', (await grid(tp)).rows === 2, JSON.stringify(await grid(tp)))
    await settle()
    let td = await doc(tp)
    const textId = td.objects.find((o) => o.type === 'text')?.id
    check('the session ends with the text and the page in the document', Boolean(textId) && td.page.rows === 2 && objectOf(td, textId).content.includes('line 0'), JSON.stringify([td.page, textId]))
    check('the text and its page are ONE undo step', (await steps(tp)) === stepsStart + 1, `${stepsStart} -> ${await steps(tp)}`)
    await waitSave(tp, putsBefore)
    check('the pages are saved with the text', savedDoc().page.rows === 2 && savedDoc().objects.some((o) => o.type === 'text'), JSON.stringify(savedDoc().page))
    await tp.evaluate(() => window.__personalNote.setTool('select'))
    await tp.waitForTimeout(150)
    await tp.evaluate(() => window.__personalNote.leaferEdits.undo())
    td = await doc(tp)
    check('one undo takes the text and the grown page away together', td.page.rows === 1 && !td.objects.some((o) => o.type === 'text') && (await grid(tp)).rows === 1, JSON.stringify([td.page, await grid(tp)]))
    await tp.evaluate(() => window.__personalNote.leaferEdits.redo())
    td = await doc(tp)
    check('and one redo brings both back', td.page.rows === 2 && td.objects.some((o) => o.type === 'text') && (await grid(tp)).rows === 2)
    // the saved note reopens with the same pages and the text (a second window on the same saved note)
    await waitSave(tp, puts.length - 1)
    const again = await typeContext.newPage()
    again.on('pageerror', (error) => typeErrors.push(error.message))
    await mock(again, () => typeNote)
    await open(again)
    td = await doc(again)
    check('a reload shows the same pages and the text', (await grid(again)).rows === 2 && td.page.rows === 2 && td.objects.some((o) => o.type === 'text' && o.content.includes('line 0')), JSON.stringify(td.page))
    await again.close()
    await tp.evaluate(() => window.__personalNote.leaferEdits.undo())

    // right: a point text typed toward the right edge widens the grid like a dragged object
    await scene(tp, 'createText', { x: 600, y: 200 })
    await tp.waitForSelector('.leafer-text-editor')
    let widened = null
    for (let i = 0; i < 80 && !widened; i += 1) {
      await tp.keyboard.type('w')
      if ((await grid(tp)).columns === 2) widened = await editor()
    }
    check('typing a point text toward the right edge adds a page on the right while typing', Boolean(widened) && widened.right <= W + 1 && widened.right > W - 100, JSON.stringify(widened))
    await settle()
    await tp.evaluate(() => window.__personalNote.leaferEdits.undo())
    td = await doc(tp)
    check('undo removes the text and the right-hand page', td.page.columns === 1 && !td.objects.some((o) => o.type === 'text'), JSON.stringify(td.page))

    // dictation into a text box
    const began = await scene(tp, 'beginDictation', { x: 100, y: 900 }, { width: 300 })
    await tp.waitForSelector('.leafer-text-editor')
    await scene(tp, 'setDictation', Array.from({ length: 12 }, (_, i) => `dictated sentence number ${i} goes here`).join(' '))
    check('words dictated into a text box near the bottom add a page while dictating', began.ok && (await grid(tp)).rows === 2, JSON.stringify([began, await grid(tp)]))
    await settle()
    await tp.evaluate(() => window.__personalNote.leaferEdits.undo())
    check('undo takes the dictation and its page away', (await doc(tp)).page.rows === 1 && !(await doc(tp)).objects.some((o) => o.type === 'text'))

    // an agent writes after the grid grew but before the draft timer: the page stays, the save is right
    await scene(tp, 'createText', { x: 100, y: 800 })
    await tp.waitForSelector('.leafer-text-editor')
    for (let i = 0; i < 30 && (await grid(tp)).rows === 1; i += 1) await tp.keyboard.type(`merge line ${i}\n`)
    const grownBeforeMerge = (await grid(tp)).rows === 2
    for (let i = 0; i < 4; i += 1) await tp.keyboard.type(`past the edge ${i}\n`) // on past the edge: the page is really needed
    const agentDoc = readJsonCanvas(typeNote.content)
    agentDoc.objects.push({ id: 'AGT', type: 'text', mode: 'box', z: 90, content: 'the agent was here', geometry: { x: 300, y: 100, width: 200, height: 60, ...UPRIGHT } })
    typeNote.content = store(agentDoc)
    typeNote.pageState = { columns: agentDoc.page.columns, rows: agentDoc.page.rows }
    typeNote.revision += 1
    changeSeq += 1
    changeLog.push({ sequence: changeSeq, resourceKind: 'note', resourceId: 'r1', changeType: 'updated', revision: typeNote.revision })
    let merged = null
    for (let i = 0; i < 40 && !merged; i += 1) { await tp.waitForTimeout(250); const d = await doc(tp); if (objectOf(d, 'AGT')) merged = d }
    check('an agent\'s write that merges while the words are typed leaves the grown page in place', grownBeforeMerge && Boolean(merged) && (await grid(tp)).rows === 2 && merged.page.rows === 2, JSON.stringify([grownBeforeMerge, merged?.page, await grid(tp)]))
    await tp.waitForFunction(() => Boolean(document.querySelector('.leafer-text-editor')))
    const putsAtMerge = puts.length
    await settle()
    await waitSave(tp, putsAtMerge)
    check('the note saved after the merge has the agent\'s text, the typed text and the grown page', savedDoc().page.rows === 2 && savedDoc().objects.some((o) => o.id === 'AGT') && savedDoc().objects.some((o) => o.type === 'text' && o.content.includes('merge line 0')), JSON.stringify(savedDoc().page))
    check('the grown page stays after the session', (await grid(tp)).rows === 2 && (await doc(tp)).page.rows === 2)
    await tp.evaluate(() => window.__personalNote.leaferEdits.undo())
    await tp.evaluate(() => window.__personalNote.leaferEdits.undo()) // (the merge is not a step; a second undo changes nothing more of the text)
    td = await doc(tp)
    check('undo takes the typed text and its page away; the agent\'s text stays', td.page.rows === 1 && !td.objects.some((o) => o.type === 'text' && o.content.includes('merge line')) && Boolean(objectOf(td, 'AGT')), JSON.stringify(td.page))

    // words typed past the edge and then deleted: the page stays while the session is open (no fold mid-typing), and goes when it ends
    const stepsMid = await steps(tp)
    await scene(tp, 'createText', { x: 100, y: 800 })
    await tp.waitForSelector('.leafer-text-editor')
    for (let i = 0; i < 30 && (await grid(tp)).rows === 1; i += 1) await tp.keyboard.type(`gone ${i}\n`)
    await tp.waitForTimeout(900) // the draft is committed with the page
    await tp.keyboard.press('Control+A')
    await tp.keyboard.press('Backspace')
    await tp.keyboard.type('x')
    await tp.waitForTimeout(900)
    check('deleting the words does not fold the page mid-typing', (await grid(tp)).rows === 2 && (await doc(tp)).page.rows === 2, JSON.stringify([await grid(tp), (await doc(tp)).page]))
    await settle()
    td = await doc(tp)
    check('when the session ends the page the words no longer need folds back', td.page.rows === 1 && (await grid(tp)).rows === 1 && td.objects.some((o) => o.type === 'text' && o.content === 'x'), JSON.stringify([td.page, await grid(tp)]))
    check('the whole session is one undo step', (await steps(tp)) === stepsMid + 1, `${stepsMid} -> ${await steps(tp)}`)
    await tp.evaluate(() => window.__personalNote.leaferEdits.undo())
    check('undo removes it', !(await doc(tp)).objects.some((o) => o.type === 'text' && o.content === 'x'))

    // mid input method: a composition near the right edge grows the page, and the composed words come out once
    await scene(tp, 'createText', { x: 640, y: 200 })
    await tp.waitForSelector('.leafer-text-editor')
    const cdp = await typeContext.newCDPSession(tp)
    await cdp.send('Input.imeSetComposition', { text: 'こんにちは世界こんにちは世界こんにちは', selectionStart: 19, selectionEnd: 19 })
    await tp.waitForTimeout(100)
    check('a composition that reaches the right edge adds a page while still composing', (await grid(tp)).columns === 2 && await tp.evaluate(() => document.querySelector('.leafer-text-editor')?.value.length > 0), JSON.stringify(await grid(tp)))
    await cdp.send('Input.insertText', { text: 'こんにちは世界こんにちは世界こんにちは' })
    await tp.waitForTimeout(100)
    await settle()
    td = await doc(tp)
    check('the composed words are in the note once, with the page', td.page.columns === 2 && td.objects.some((o) => o.type === 'text' && o.content === 'こんにちは世界こんにちは世界こんにちは'), JSON.stringify([td.page, td.objects.filter((o) => o.type === 'text').map((o) => o.content)]))
    await cdp.detach()
    await tp.evaluate(() => window.__personalNote.leaferEdits.undo())

    // a sticky grows as it is typed and the page grows with it
    await scene(tp, 'createSticky', { x: 300, y: 820 })
    await tp.waitForSelector('.leafer-text-editor')
    let tall = false
    for (let i = 0; i < 30 && !tall; i += 1) { await tp.keyboard.type('a line in a sticky\n'); tall = (await grid(tp)).rows === 2 }
    check('a sticky that grows toward the bottom adds a page while typing', tall, JSON.stringify(await grid(tp)))
    for (let i = 0; i < 4; i += 1) await tp.keyboard.type('more words\n') // on past the edge: the page stays when the session ends
    await settle()
    td = await doc(tp)
    check('the sticky and its page are in the document', td.page.rows === 2 && td.objects.some((o) => o.type === 'sticky'))
    await tp.evaluate(() => window.__personalNote.leaferEdits.undo())
    check('one undo takes the sticky and the page away', (await doc(tp)).page.rows === 1 && !(await doc(tp)).objects.some((o) => o.type === 'sticky'))
    check('typing: no page errors', typeErrors.length === 0, typeErrors.join(' | '))
    await typeContext.close()
  }

  // ---------------------------------------------------------------- a phone: the connect button, a finger draws an arrow, a drag past the edge grows the page
  {
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
    const small = await phone.newPage()
    const phoneErrors = []
    small.on('pageerror', (error) => phoneErrors.push(error.message))
    const note = { content: store(baseDoc()), pageState: { columns: 1, rows: 1 }, revision: 1 }
    await mock(small, () => note)
    await open(small)
    const touch = await phone.newCDPSession(small)
    const connectors = async () => (await doc(small)).objects.filter((o) => o.type === 'connector')
    const before = (await connectors()).length
    check('phone: the connect button is live (not dimmed, not inert)', await small.evaluate(() => { const button = document.querySelector('#mobile-connect'); const style = getComputedStyle(button); return style.pointerEvents !== 'none' && Number(style.opacity) > 0.9 }))
    await small.click('#mobile-connect')
    check('phone: tapping it turns the connect tool on', await small.evaluate(() => window.__personalNote.state.tool === 'connect' && document.querySelector('#mobile-connect').getAttribute('aria-pressed') === 'true'))
    const a = await centre(small, 'B')
    const b = await centre(small, 'C')
    const point = (p) => ({ x: p.x, y: p.y, id: 0, force: 0.5 })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(a)] })
    for (let i = 1; i <= 8; i += 1) { await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point({ x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 })] }); await nextFrame(small) }
    await shot(small, 'phone-connect')
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await nextFrame(small)
    await small.waitForTimeout(150)
    check('phone: a finger drawn from one object to another makes an arrow', (await connectors()).length === before + 1 && (await doc(small)).objects.some((o) => o.type === 'connector' && o.fromId === 'B' && o.toId === 'C'), JSON.stringify((await connectors()).map((o) => [o.fromId, o.toId])))
    await phone.close()
    // the same width with a mouse (a phone's touch rules for moving objects are F-035): a drag past the edge lifts the object and grows the page
    const narrow = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 })
    const small2 = await narrow.newPage()
    small2.on('pageerror', (error) => phoneErrors.push(error.message))
    await mock(small2, () => ({ content: store(baseDoc()), pageState: { columns: 1, rows: 1 }, revision: 1 }))
    await open(small2)
    const sb = await centre(small2, 'B')
    const g = objectOf(await doc(small2), 'B').geometry
    const edge = await screenOf(small2, W + 8 - g.width / 2, g.y + g.height / 2) // its right edge just past the page edge, still on screen
    await small2.mouse.click(sb.x, sb.y)
    await small2.mouse.move(sb.x, sb.y)
    await small2.mouse.down()
    for (let i = 1; i <= 10; i += 1) { await small2.mouse.move(sb.x + ((edge.x - sb.x) * i) / 10, sb.y); await nextFrame(small2) }
    await small2.waitForTimeout(100)
    const state = await dragState(small2)
    check('phone width: a drag past the edge lifts the object and grows the page', state.lifted.join() === 'B' && (await small2.evaluate(() => window.__personalNote.state.pages.columns)) === 2, JSON.stringify(state))
    await shot(small2, 'phone-grown')
    await small2.mouse.up()
    await nextFrame(small2)
    check('phone width: after the drop the page stays and the lift is gone', (await doc(small2)).page.columns === 2 && (await dragState(small2)).lifted.length === 0)
    await narrow.close()
    check('phone: no page errors', phoneErrors.length === 0, phoneErrors.join(' | '))
  }
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
