// F-034: agent sync and the server's page frame, in the real app (Vite dev server on port 4801, mocked in-memory /api, headless Chromium).
// The race: the user's edit moved the page frame (pages added on the top or left) and its save is out; the server has applied it but the
// response has not come back yet, so the app does not know the server's frame has moved. An agent then writes (in the frame the server holds)
// and that write is merged before the response arrives. The merge must treat the server's copy in the frame the save left it in.
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-sync.mjs
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { readJsonCanvas, writeJsonCanvas } from '../src/core/document/jsoncanvas.js'

const PORT = 4801
const now = new Date().toISOString()
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const near = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance
const UPRIGHT = { rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const rect = (id, x, y, width, height, z) => ({ id, type: 'shape', kind: 'rect', z, geometry: { x, y, width, height, ...UPRIGHT }, fill: '#c9d9ee', stroke: '#4a6fb0', strokeWidth: 2 })
const baseDoc = () => ({ schemaVersion: 1, page: { columns: 1, rows: 1 }, extras: {}, objects: [rect('A', 100, 200, 200, 120, 0), rect('B', 500, 200, 200, 120, 1), rect('C', 300, 600, 200, 120, 2)] })
const store = (doc) => writeJsonCanvas(doc, { derived: 'omit' })

const stored = { content: store(baseDoc()), pageState: { columns: 1, rows: 1 }, revision: 1 }
const puts = []
let changeSeq = 1
let responseGate = null
let hung = false // the server applies a save and never answers
const changePolls = []
const changeLog = []
const holdResponses = () => { let open; responseGate = new Promise((resolve) => { open = () => { responseGate = null; resolve() } }); return open }
const agentWrite = (change) => {
  const doc = readJsonCanvas(stored.content)
  change(doc)
  stored.content = store(doc)
  stored.pageState = { columns: doc.page.columns, rows: doc.page.rows }
  stored.revision += 1
  changeSeq += 1
  changeLog.push({ sequence: changeSeq, resourceKind: 'note', resourceId: 'r1', changeType: 'updated', revision: stored.revision })
}

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4809' } }, logLevel: 'error' })
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
    const summary = { id: 1, resourceId: 'r1', revision: stored.revision, noteType: 'canvas', title: 'Sync', notebookId: 1, createdAt: now, updatedAt: now }
    if (p === '/changes') { changePolls.push(Date.now()); const since = Number(new URL(req.url()).searchParams.get('since') ?? changeSeq); return json({ sequence: changeSeq, changes: changeLog.filter((c) => c.sequence > since), agents: [] }) }
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary])
    if (p === '/notes/1' && req.method() === 'GET') return json({ ...summary, content: stored.content, pageState: stored.pageState })
    if (p === '/notes/1' && req.method() === 'PUT') {
      const body = JSON.parse(req.postData())
      puts.push(body)
      Object.assign(stored, { content: body.content, pageState: body.pageState, revision: stored.revision + 1 })
      const revision = stored.revision
      changeSeq += 1
      changeLog.push({ sequence: changeSeq, resourceKind: 'note', resourceId: 'r1', changeType: 'updated', revision })
      if (hung) await new Promise(() => {})
      if (responseGate) await responseGate // applied on the server; the answer has not come back
      return json({ revision, resourceId: 'r1' })
    }
    return json({})
  })
  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__personalNote.setTool('select')) // a note opens with the Text tool; these checks select and drag
  await page.waitForTimeout(200) // a drag in the first frames after the switch does not lift

  const doc = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))
  const objectOf = (d, id) => d.objects.find((o) => o.id === id)
  const centre = async (id) => {
    const box = await page.evaluate((i) => window.__personalNote.leaferCanvas().screenBox(i), id)
    const host = await page.evaluate(() => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: r.left, y: r.top } })
    return { x: host.x + box.x + box.width / 2, y: host.y + box.y + box.height / 2 }
  }
  const screenOf = (x, y) => page.evaluate(([px, py]) => {
    const view = window.__personalNote.leaferCanvas().view()
    const host = document.querySelector('#leafer-host').getBoundingClientRect()
    return { x: host.left + view.x + px * view.scale, y: host.top + view.y + py * view.scale }
  }, [x, y])
  const nextFrame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))

  const start = await doc()
  const release = holdResponses()
  const away = await screenOf(700, 1000)
  await page.mouse.click(away.x, away.y)
  const from = await centre('A')
  await page.mouse.click(from.x, from.y)
  await page.waitForTimeout(80)
  const to = await screenOf(-40 + 101, -60 + 61) // pages on the top and left: the frame moves
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i += 1) { await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12); await nextFrame() }
  await page.mouse.up()
  await page.waitForTimeout(1500) // the save is out and applied by the server; its answer is held
  const user = readJsonCanvas(puts[0].content) // what the user saved: the frame every later document must be in
  const frame = { x: objectOf(user, 'C').geometry.x - objectOf(start, 'C').geometry.x, y: objectOf(user, 'C').geometry.y - objectOf(start, 'C').geometry.y }
  check('the move added pages on the top or left (the frame moved)', frame.x > 0 || frame.y > 0, JSON.stringify(frame))
  check('the save is out and the server holds the user\'s note', puts.length === 1 && stored.revision === 2, `${puts.length} ${stored.revision}`)

  agentWrite((d) => { const c = objectOf(d, 'C').geometry; d.objects.push({ id: 'AG', type: 'text', mode: 'box', z: 50, content: 'agent text', geometry: { x: c.x + 300, y: c.y, width: 200, height: 60, ...UPRIGHT } }) }) // in the frame the server holds
  await page.waitForTimeout(4500) // the poll sees it while the save's answer is still out
  release()
  for (let i = 0; i < 40 && puts.length < 2; i += 1) await page.waitForTimeout(250)
  await page.waitForTimeout(500)
  const merged = await doc()
  check('the agent\'s text arrives', Boolean(objectOf(merged, 'AG')))
  check('every object stays where the user left it (the server\'s copy was not moved a second time)', ['A', 'B', 'C'].every((id) => near(objectOf(merged, id).geometry.x, objectOf(user, id).geometry.x) && near(objectOf(merged, id).geometry.y, objectOf(user, id).geometry.y)), JSON.stringify(['A', 'B', 'C'].map((id) => [objectOf(merged, id).geometry.x - objectOf(user, id).geometry.x, objectOf(merged, id).geometry.y - objectOf(user, id).geometry.y])))
  check('the agent\'s text is where the agent put it, next to C', Boolean(objectOf(merged, 'AG')) && near(objectOf(merged, 'AG').geometry.x - objectOf(merged, 'C').geometry.x, 300, 1e-6) && near(objectOf(merged, 'AG').geometry.y - objectOf(merged, 'C').geometry.y, 0, 1e-6))
  const final = readJsonCanvas(stored.content)
  check('the server\'s note and the screen agree at the end, in the user\'s frame', ['A', 'B', 'C', 'AG'].every((id) => near(objectOf(final, id).geometry.x, objectOf(merged, id).geometry.x) && near(objectOf(final, id).geometry.y, objectOf(merged, id).geometry.y)) && near(objectOf(final, 'C').geometry.x, objectOf(user, 'C').geometry.x))

  // a save that never gets an answer: the merge is given up after a few seconds and the changes feed carries on
  hung = true
  const a2 = await centre('B')
  await page.mouse.click(a2.x, a2.y)
  const to2 = await screenOf(-40 + 101, -60 + 61)
  await page.mouse.move(a2.x, a2.y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i += 1) { await page.mouse.move(a2.x + ((to2.x - a2.x) * i) / 12, a2.y + ((to2.y - a2.y) * i) / 12); await nextFrame() }
  await page.mouse.up()
  await page.waitForTimeout(1500)
  agentWrite((d) => { d.objects.push({ id: 'AG3', type: 'text', mode: 'box', z: 60, content: 'while hung', geometry: { x: 10, y: 10, width: 200, height: 60, ...UPRIGHT } }) })
  const polledBefore = changePolls.length
  const mark = Date.now()
  await page.waitForTimeout(18000)
  const lastPolls = changePolls.filter((at) => at > mark + 6000).length
  check('with a save that never answers, the changes feed keeps polling (a merge never stalls it)', lastPolls >= 2 && changePolls.length > polledBefore, `${lastPolls} polls in the last 12 s`)
  check('and the page is still usable: the editor answers', await page.evaluate(() => window.__personalNote.leaferEdits.doc.objects.length > 0))
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
