// F-028 checks, in the real app (Vite dev server on port 4741, mocked in-memory /api that keeps what the app saves and serves it back
// on reload, headless Chromium): select (click, shift-click, marquee), move, resize, turn, delete, bring forward / back, lock / unlock
// and arrow-key nudge on the Leafer canvas; the saved JSON Canvas reflects each one; a reload shows the same; locked objects do not
// move, resize or go; nothing fires while typing; geometry matches the model oracle (src/core/document/placement.js) within 0.5 px.
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-edit.mjs
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { readJsonCanvas } from '../src/core/document/jsoncanvas.js'
import { placedPoints } from '../src/core/document/placement.js'

const PORT = 4741
const now = new Date().toISOString()
const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/documents/app-all-tools.json', import.meta.url), 'utf8'))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

const textbox = { ...structuredClone(fixture.content.objects[1]), type: 'Textbox', semanticId: 'res_00000000000040008000000000000099', text: 'A text box that wraps its words onto several lines when it is narrow', left: 700, top: 110, width: 220, height: 100 }
fixture.content.objects.push(textbox)
let stored = { content: fixture.content, pageState: fixture.pageState, revision: 1 }
const puts = []

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4749' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

async function mock(page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    const summary = { id: 1, resourceId: 'r1', revision: stored.revision, noteType: 'canvas', title: 'Edit', notebookId: 1, createdAt: now, updatedAt: now }
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    const second = { ...summary, id: 2, resourceId: 'r2', title: 'Other', revision: 1 }
    if (p === '/notes' && req.method() === 'GET') return json([summary, second])
    if (p === '/notes/2' && req.method() === 'GET') { await new Promise((resolve) => setTimeout(resolve, 1200)); return json({ ...second, content: { version: '7.4.0', objects: [] }, pageState: { columns: 1, rows: 1 } }) }
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

const call = (page, name, ...args) => page.evaluate(([n, a]) => window.__personalNote.leaferCanvas()[n](...a), [name, args])
async function open(page) {
  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(400)
}
async function centre(page, id) {
  const { box, host, scale } = await page.evaluate((target) => {
    const scene = window.__personalNote.leaferCanvas()
    const rect = document.querySelector('#leafer-host').getBoundingClientRect()
    return { box: scene.screenBox(target), host: { x: rect.left, y: rect.top }, scale: window.__personalNote.getCanvasScale() }
  }, id)
  return { x: host.x + box.x + box.width / 2, y: host.y + box.y + box.height / 2, left: host.x + box.x, top: host.y + box.y, right: host.x + box.x + box.width, bottom: host.y + box.y + box.height, scale }
}
// a point on the page (page pixels) -> where it is on screen
async function pagePoint(page, x, y) {
  const v = await page.evaluate(() => {
    const world = window.__personalNote.leaferCanvas().leafer.children[1]
    const rect = document.querySelector('#leafer-host').getBoundingClientRect()
    return { x: rect.left + world.x, y: rect.top + world.y, scale: world.scaleX }
  })
  return { x: v.x + x * v.scale, y: v.y + y * v.scale }
}
const savedDoc = () => readJsonCanvas(puts.at(-1).content)
const objectOf = (doc, id) => doc.objects.find((object) => object.id === id)
const waitForSave = async (page, before) => { for (let i = 0; i < 40 && puts.length <= before; i += 1) await page.waitForTimeout(150); await page.waitForTimeout(100); return puts.length > before }
const near = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance
// where the model puts an object's box corners, by the documented formula, for the saved document
const oracleCorners = (doc, id) => { const o = objectOf(doc, id); const g = o.geometry; return placedPoints([{ ...o, type: 'shape', geometry: { ...g } }]).slice(0, 8) }
const liveCorners = async (page, id) => (await call(page, 'pageCorners', id)).flatMap((p) => [p.x, p.y])
const samePoints = (a, b, tolerance = 0.5) => a.length === b.length && a.every((value, i) => near(value, b[i], tolerance))

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await mock(page)
  await open(page)

  const ids = await page.evaluate(() => window.__personalNote.leaferEdits.doc.objects.map((o) => `${o.type}:${o.id}`))
  const idOf = (type, nth = 0) => ids.filter((entry) => entry.startsWith(`${type}:`))[nth].split(':')[1]
  const A = idOf('sticky', 0)
  const B = idOf('sticky', 1)
  const R = idOf('shape', 0)
  const T = idOf('text', 0)

  const scale = (await centre(page, A)).scale
  const live = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 10 })
    await page.mouse.up()
  }
  const act = async (fn) => { const n = puts.length; await fn(); return await waitForSave(page, n) }
  const emptySpot = await pagePoint(page, 820, 20)
  const deselect = async () => { await page.mouse.click(emptySpot.x, emptySpot.y); await page.waitForTimeout(80) }
  const selectOnly = async (id) => { await deselect(); const p = await centre(page, id); await page.mouse.click(p.x, p.y); await page.waitForTimeout(80) }
  const sameGeometryAsOracle = async (id, label) => check(`${label}: the scene and the model oracle put ${id.slice(-3)} in the same place (within 0.5px)`, samePoints(oracleCorners(savedDoc(), id), await liveCorners(page, id)), `${JSON.stringify(oracleCorners(savedDoc(), id))} vs ${JSON.stringify(await liveCorners(page, id))}`)

  // ---- select
  let c = await centre(page, A)
  await page.mouse.click(c.x, c.y)
  check('a click selects the object under it', JSON.stringify(await call(page, 'selection')) === JSON.stringify([A]), JSON.stringify(await call(page, 'selection')))
  check('the selection bar shows while something is selected', await page.evaluate(() => !document.querySelector('#selection-bar').hidden))
  const cb = await centre(page, B)
  await page.keyboard.down('Shift')
  await page.mouse.click(cb.x, cb.y)
  await page.keyboard.up('Shift')
  check('shift-click adds to the selection', (await call(page, 'selection')).length === 2, JSON.stringify(await call(page, 'selection')))
  await deselect()
  check('a click on empty space clears the selection', (await call(page, 'selection')).length === 0)
  const cr = await centre(page, R)
  await page.mouse.move(cr.left - 8, cr.top - 8)
  await page.mouse.down()
  await page.mouse.move(cr.right + 8, cr.bottom + 8, { steps: 8 })
  await page.mouse.up()
  check('a marquee selects what it encloses', (await call(page, 'selection')).includes(R), JSON.stringify(await call(page, 'selection')))
  await page.screenshot({ path: '/var/tmp/f028/selected.png' })
  await deselect()
  check('selecting alone saves nothing', puts.length === 0, `${puts.length} saves`)

  // a thin pen line can be picked by clicking near it
  const stroke = (await live()).objects.find((o) => o.type === 'ink' && o.kind === 'stroke')
  const onStroke = await pagePoint(page, stroke.geometry.x + stroke.path[0][1] + 1, stroke.geometry.y + stroke.path[0][2] + 1)
  await page.mouse.click(onStroke.x, onStroke.y)
  check('a click on a pen line picks it', (await call(page, 'selection')).includes(stroke.id), JSON.stringify(await call(page, 'selection')))
  await deselect()

  // ---- move
  let before = await live()
  await selectOnly(A)
  c = await centre(page, A)
  check('a move is saved', await act(() => drag(c, { x: c.x + 60, y: c.y + 40 })))
  let now = savedDoc()
  check('move: the saved box moved by the drag (60, 40 screen px)', near(objectOf(now, A).geometry.x, objectOf(before, A).geometry.x + 60 / scale) && near(objectOf(now, A).geometry.y, objectOf(before, A).geometry.y + 40 / scale), `${JSON.stringify(objectOf(now, A).geometry)} from ${JSON.stringify(objectOf(before, A).geometry)}`)
  await sameGeometryAsOracle(A, 'move')
  check('move: nothing else moved', before.objects.filter((o) => o.id !== A && o.geometry).every((o) => JSON.stringify(objectOf(now, o.id).geometry) === JSON.stringify(o.geometry)))

  // ---- resize: the bottom-right corner of the rectangle
  before = await live()
  await selectOnly(R)
  c = await centre(page, R)
  check('a resize is saved', await act(() => drag({ x: c.right, y: c.bottom }, { x: c.right + 70, y: c.bottom + 40 })))
  now = savedDoc()
  let g0 = objectOf(before, R).geometry
  let g1 = objectOf(now, R).geometry
  check('resize: width and height grew by the drag, scale stays 1', near(g1.width, g0.width + 70 / scale) && near(g1.height, g0.height + 40 / scale) && g1.scaleX === 1 && g1.scaleY === 1, `${JSON.stringify(g1)} from ${JSON.stringify(g0)}`)
  check('resize: the top-left corner stayed', near(g1.x, g0.x) && near(g1.y, g0.y), `${g1.x},${g1.y} vs ${g0.x},${g0.y}`)
  await sameGeometryAsOracle(R, 'resize')

  // ---- text box: wider box, same letters
  const TB = (await live()).objects.find((o) => o.type === 'text' && o.mode === 'box')?.id
  check('the note has a text box to resize', Boolean(TB))
  if (TB) {
    before = await live()
    await selectOnly(TB)
    c = await centre(page, TB)
    check('a text box resize is saved', await act(() => drag({ x: c.right, y: c.bottom }, { x: c.right + 90, y: c.bottom + 10 })))
    now = savedDoc()
    g0 = objectOf(before, TB).geometry
    g1 = objectOf(now, TB).geometry
    check('text box: the box is wider, the letters are not stretched', near(g1.width, g0.width + 90 / scale) && g1.scaleX === 1 && g1.scaleY === 1 && objectOf(now, TB).style.fontSize === objectOf(before, TB).style.fontSize, `${JSON.stringify(g1)} font ${objectOf(now, TB).style?.fontSize}`)
    await sameGeometryAsOracle(TB, 'text box resize')
  }

  // ---- turn
  before = await live()
  await selectOnly(R)
  c = await centre(page, R)
  const middle = { x: (c.left + c.right) / 2, y: (c.top + c.bottom) / 2 }
  const start = { x: c.right + 9, y: c.bottom + 9 }
  const angle = Math.PI / 4
  const dxs = start.x - middle.x
  const dys = start.y - middle.y
  const end = { x: middle.x + dxs * Math.cos(angle) - dys * Math.sin(angle), y: middle.y + dxs * Math.sin(angle) + dys * Math.cos(angle) }
  check('a turn is saved', await act(() => drag(start, end)))
  now = savedDoc()
  const turned = objectOf(now, R).geometry.rotation
  check('turn: the saved rotation is about 45 degrees', Math.abs(turned - 45) < 3, `rotation ${turned}`)
  await sameGeometryAsOracle(R, 'turn')
  const boxBefore = objectOf(before, R).geometry
  const boxAfter = objectOf(now, R).geometry
  check('turn: size and centre are unchanged', near(boxAfter.width, boxBefore.width) && near(boxAfter.height, boxBefore.height) && near(boxAfter.x + boxAfter.width / 2, boxBefore.x + boxBefore.width / 2, 1) && near(boxAfter.y + boxAfter.height / 2, boxBefore.y + boxBefore.height / 2, 1), `${JSON.stringify(boxAfter)} from ${JSON.stringify(boxBefore)}`)

  // ---- nudge
  before = await live()
  await selectOnly(A)
  check('arrow keys nudge and save', await act(async () => { await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown') }))
  now = savedDoc()
  check('nudge: 1 px per arrow, 10 px with shift', near(objectOf(now, A).geometry.x, objectOf(before, A).geometry.x + 2, 0.01) && near(objectOf(now, A).geometry.y, objectOf(before, A).geometry.y + 10, 0.01), `${JSON.stringify(objectOf(now, A).geometry)} from ${JSON.stringify(objectOf(before, A).geometry)}`)
  await sameGeometryAsOracle(A, 'nudge')

  // ---- typing: no key fires into the canvas
  before = await live()
  await page.focus('#note-title')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Control+Shift+L')
  await page.waitForTimeout(900)
  check('typing in a field moves, deletes and locks nothing', JSON.stringify((await live()).objects) === JSON.stringify(before.objects), 'the document changed')
  await page.evaluate(() => document.activeElement?.blur())

  // ---- z-order
  before = await live()
  const orderBefore = await call(page, 'nodeOrder')
  await selectOnly(A)
  check('bring forward is saved', await act(() => page.keyboard.press('Control+BracketRight')))
  now = savedDoc()
  const savedOrder = now.objects.map((o) => o.id)
  const sceneOrder = await call(page, 'nodeOrder')
  check('forward: A moved up one place among the objects, in the saved note and on screen', savedOrder.indexOf(A) > before.objects.map((o) => o.id).indexOf(A) && sceneOrder.indexOf(A) === orderBefore.indexOf(A) + 1, `${savedOrder.indexOf(A)} / ${sceneOrder.indexOf(A)} from ${orderBefore.indexOf(A)}`)
  check('the saved order and the on-screen order agree', JSON.stringify(sceneOrder.filter((id) => savedOrder.includes(id))) === JSON.stringify(savedOrder.filter((id) => sceneOrder.includes(id))))
  check('to front: A is last', await act(() => page.keyboard.press('Control+Shift+BracketRight')) && (await call(page, 'nodeOrder')).at(-1) === A && savedDoc().objects.filter((o) => o.type !== 'connector').at(-1).id === A)
  check('to back: A is first', await act(() => page.keyboard.press('Control+Shift+BracketLeft')) && (await call(page, 'nodeOrder'))[0] === A && savedDoc().objects[0].id === A)
  check('backward at the very back changes nothing', !(await act(() => page.keyboard.press('Control+BracketLeft'))))

  // ---- lock
  before = await live()
  await selectOnly(T)
  check('lock is saved', await act(() => page.keyboard.press('Control+Shift+L')))
  check('lock: the saved object is marked locked', objectOf(savedDoc(), T).locked === true)
  c = await centre(page, T)
  const lockedAt = JSON.stringify(objectOf(await live(), T).geometry)
  await drag(c, { x: c.x + 50, y: c.y + 50 })
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(900)
  check('a locked object does not move, nudge or delete', JSON.stringify(objectOf(await live(), T)?.geometry) === lockedAt && (await call(page, 'hasNode', T)), `${lockedAt}`)
  check('a locked object can still be selected (to unlock it)', (await call(page, 'selection')).includes(T))
  check('the bar offers Unlock', (await page.textContent('[data-selection-action="lock"]')) === 'Unlock')
  check('unlock is saved', await act(() => page.keyboard.press('Control+Shift+L')))
  check('unlock: the object is not locked any more', objectOf(savedDoc(), T).locked === undefined)
  c = await centre(page, T)
  check('an unlocked object moves again', await act(() => drag(c, { x: c.x + 40, y: c.y + 20 })) && !near(objectOf(savedDoc(), T).geometry.x, objectOf(before, T).geometry.x, 1))
  await page.keyboard.press('Control+Shift+L') // lock it again so the reload below shows a lock
  await page.waitForTimeout(900)

  // ---- hand: the Fabric layer pans, nothing is moved
  before = await live()
  await page.keyboard.press('h')
  c = await centre(page, A)
  await drag(c, { x: c.x + 50, y: c.y })
  await page.waitForTimeout(500)
  check('with the hand tool a drag does not move the object', JSON.stringify(objectOf(await live(), A).geometry) === JSON.stringify(objectOf(before, A).geometry))
  await page.keyboard.press('v')
  await page.waitForTimeout(100)

  // ---- delete: the object and its connectors go
  const doc0 = await live()
  const attached = doc0.objects.filter((o) => o.type === 'connector' && (o.fromId === B || o.toId === B)).map((o) => o.id)
  check('the sticky has connectors to lose', attached.length > 0)
  await selectOnly(B)
  check('delete is saved', await act(() => page.keyboard.press('Delete')))
  now = savedDoc()
  check('delete: the object and its connectors are gone from the saved note', !objectOf(now, B) && attached.every((id) => !objectOf(now, id)))
  check('delete: and from the screen', !(await call(page, 'hasNode', B)) && (await call(page, 'selection')).length === 0)
  check('delete: other objects stay', doc0.objects.filter((o) => o.id !== B && !attached.includes(o.id)).every((o) => objectOf(now, o.id)))

  // ---- undo and redo (F-030's history) take the edits back
  check('Ctrl+Z brings the deleted sticky and its connectors back', await act(() => page.keyboard.press('Control+z')) && Boolean(objectOf(savedDoc(), B)) && attached.every((id) => objectOf(savedDoc(), id)) && await call(page, 'hasNode', B))
  check('Ctrl+Shift+Z deletes them again', await act(() => page.keyboard.press('Control+Shift+z')) && !objectOf(savedDoc(), B) && !(await call(page, 'hasNode', B)))
  before = await live()
  await selectOnly(A)
  c = await centre(page, A)
  await act(() => drag(c, { x: c.x + 30, y: c.y + 30 }))
  check('a drag is one undo step', await act(() => page.keyboard.press('Control+z')) && JSON.stringify(objectOf(savedDoc(), A).geometry) === JSON.stringify(objectOf(before, A).geometry), JSON.stringify(objectOf(savedDoc(), A).geometry))
  await sameGeometryAsOracle(A, 'undo of a move')
  check('undo selects what it restored', (await call(page, 'selection')).includes(A))

  // ---- a switch to another note has started: the old note takes no more input
  await page.waitForTimeout(1000) // earlier edits are saved
  await selectOnly(A)
  const beforeSwitch = await live()
  const putsAtSwitch = puts.length
  await page.evaluate(() => document.querySelector('[data-note-id="2"]').click())
  await page.waitForTimeout(200)
  check('a note switch clears the selection', (await call(page, 'selection')).length === 0)
  c = await centre(page, A)
  await drag(c, { x: c.x + 50, y: c.y + 50 })
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Delete')
  await page.waitForFunction(() => window.__personalNote.state.activeNoteId === 2, null, { timeout: 5000 })
  await page.evaluate(() => document.querySelector('[data-note-id="1"]').click())
  await page.waitForFunction(() => window.__personalNote.state.activeNoteId === 1, null, { timeout: 5000 })
  await page.waitForTimeout(600)
  check('the old note comes back exactly as it was and nothing was saved meanwhile', puts.length === putsAtSwitch && JSON.stringify(objectOf(await live(), A).geometry) === JSON.stringify(objectOf(beforeSwitch, A).geometry) && JSON.stringify((await live()).objects.map((o) => o.id)) === JSON.stringify(beforeSwitch.objects.map((o) => o.id)), `puts ${puts.length - putsAtSwitch}`)

  // ---- reload shows the same result
  const all = (await live()).objects.filter((o) => o.type !== 'unknown').map((o) => o.id)
  const allInOrder = (await live()).objects.sort((a, b) => a.z - b.z).map((o) => o.id)
  const cornersBefore = Object.fromEntries(await Promise.all(all.map(async (id) => [id, await liveCorners(page, id)])))
  const lockedBefore = (await live()).objects.filter((o) => o.locked).map((o) => o.id)
  const putsAtReload = puts.length
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(700)
  const after = await live()
  check('reload: the same objects, in the same order', JSON.stringify(after.objects.map((o) => o.id)) === JSON.stringify(allInOrder), `${after.objects.map((o) => o.id.slice(-3)).join()} vs ${all.map((i) => i.slice(-3)).join()}`)
  let worst = 0
  for (const id of all) { const corners = await liveCorners(page, id); corners.forEach((value, i) => { worst = Math.max(worst, Math.abs(value - cornersBefore[id][i])) }) }
  check(`reload: every object is where it was (worst ${worst.toFixed(3)} px)`, worst <= 0.5)
  check('reload: locks are kept', JSON.stringify(after.objects.filter((o) => o.locked).map((o) => o.id)) === JSON.stringify(lockedBefore), `${after.objects.filter((o) => o.locked).map((o) => o.id.slice(-3))} vs ${lockedBefore.map((i) => i.slice(-3))}`)
  check('reload: opening the note saves nothing', puts.length === putsAtReload, `${puts.length - putsAtReload} saves`)

  console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors')
} finally {
  await browser.close()
  await server.close()
}
process.exit(results.every(Boolean) ? 0 : 1)
