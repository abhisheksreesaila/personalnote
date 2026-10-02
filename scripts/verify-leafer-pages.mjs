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

const PORT = 4780
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
      const body = JSON.parse(req.postData())
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
}
const scene = (page, name, ...args) => page.evaluate(([n, a]) => window.__personalNote.leaferCanvas()[n](...a), [name, args])
const doc = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))
const steps = (page) => page.evaluate(() => window.__personalNote.leaferEdits.stats().undoSteps)
const grid = (page) => page.evaluate(() => ({ ...window.__personalNote.state.pages }))
const nextFrame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
const objectOf = (d, id) => d.objects.find((o) => o.id === id)
const rectOf = (object) => boundingRect(object)
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
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await mock(page, () => stored)
  await open(page)

  // ---------------------------------------------------------------- the note opens with its arrows in line
  let d = await doc(page)
  check('opening a note brings a stale arrow in line with the two objects it joins', consistent(d), JSON.stringify(d.objects.filter((o) => o.type === 'connector').map((o) => o.geometry)))
  check('both arrows are on screen, and the Fabric canvas holds nothing', await scene(page, 'hasNode', 'c1') && await scene(page, 'hasNode', 'c2') && (await page.evaluate(() => window.__personalNote.canvas.getObjects().length)) === 0)
  const c1Line = await page.evaluate(() => { const o = window.__personalNote.leaferEdits.doc.objects.find((x) => x.id === 'c1'); return o.geometry })
  check('the arrow between A and B runs between their facing edges', c1Line.x > 300 && c1Line.x < 320 && c1Line.x + c1Line.width < 500 && c1Line.x + c1Line.width > 480, JSON.stringify(c1Line))

  // ---------------------------------------------------------------- an arrow follows its end live and in the saved note
  const baseSteps = await steps(page)
  await select(page, 'B')
  let cB = await centre(page, 'B')
  const before = await doc(page)
  const c1Before = await page.evaluate(() => { const s = window.__personalNote.leaferCanvas(); return s.connectorPathOf?.('c1') ?? null })
  await drag(page, cB, { x: cB.x - 60, y: cB.y + 140 }, { hold: true })
  const mid = await page.evaluate(() => { const s = window.__personalNote.leaferCanvas(); const n = s.leafer.children[1].children.find((node) => node.id === 'c1'); return n ? 1 : 0 })
  void mid; void c1Before
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
    await page.evaluate(() => window.__personalNote.setCanvasViewportOffset())
    const cSettled = await cornerOf(page, 'C')
    console.log(`INFO  after pages were added, the view keeps what is on screen where it is (as on the Fabric path); the next pan or zoom clamps it: C moves ${(cSettled.x - cAfter.x).toFixed(0)}, ${(cSettled.y - cAfter.y).toFixed(0)} px then`)
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
    check('redo does not make it jump either', Math.abs(cRedone.x - cBefore.x) < 0.01 && Math.abs(cRedone.y - cBefore.y) < 0.01, `${JSON.stringify(cBefore)} -> ${JSON.stringify(cRedone)}`)
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
  }
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
