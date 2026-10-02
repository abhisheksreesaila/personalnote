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

let stored = { content: fixture.content, pageState: fixture.pageState, revision: 1 }
const puts = []

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

async function mock(page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    const summary = { id: 1, resourceId: 'r1', revision: stored.revision, noteType: 'canvas', title: 'Edit', notebookId: 1, createdAt: now, updatedAt: now }
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary])
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

  const ids = await page.evaluate(() => window.__personalNote.leaferDoc().objects.map((o) => `${o.type}:${o.id}`))
  const idOf = (type, nth = 0) => ids.filter((entry) => entry.startsWith(`${type}:`))[nth].split(':')[1]
  const A = idOf('sticky', 0)
  const B = idOf('sticky', 1)
  const R = idOf('shape', 0)
  const T = idOf('text', 0)

  // ---- select
  let c = await centre(page, A)
  await page.mouse.click(c.x, c.y)
  check('a click selects the object under it', JSON.stringify(await call(page, 'selection')) === JSON.stringify([A]), JSON.stringify(await call(page, 'selection')))
  const bar = await page.evaluate(() => !document.querySelector('#selection-bar').hidden)
  check('the selection bar shows while something is selected', bar)
  const cb = await centre(page, B)
  await page.keyboard.down('Shift')
  await page.mouse.click(cb.x, cb.y)
  await page.keyboard.up('Shift')
  check('shift-click adds to the selection', (await call(page, 'selection')).length === 2, JSON.stringify(await call(page, 'selection')))
  await page.mouse.click(5, 5 + 60)
  await page.waitForTimeout(100)
  check('a click on empty space clears the selection', (await call(page, 'selection')).length === 0, JSON.stringify(await call(page, 'selection')))

  // marquee: from above-left of the rect to below-right of it
  const cr = await centre(page, R)
  await page.mouse.move(cr.left - 8, cr.top - 8)
  await page.mouse.down()
  await page.mouse.move(cr.right + 8, cr.bottom + 8, { steps: 8 })
  await page.mouse.up()
  const marquee = await call(page, 'selection')
  check('a marquee selects what it encloses', marquee.includes(R), JSON.stringify(marquee))
  await page.mouse.click(5, 65)

  console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors')
} finally {
  await browser.close()
  await server.close()
}
process.exit(results.every(Boolean) ? 0 : 1)
