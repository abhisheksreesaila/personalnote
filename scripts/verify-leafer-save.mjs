// F-034: leaving a note sends nothing when nothing changed since it was loaded (Vite dev server on port 4804, mocked in-memory /api, headless Chromium).
//   - opening a note and switching to another one, with no edit, sends no save for the first
//   - the same when the page is hidden or closed (pagehide, visibility hidden)
//   - an edit followed by a switch sends exactly one save of the first note, and that save holds the edit
//   - after that save, switching away and back and away again sends nothing more
//   - the same for a mind map: opened and left unchanged, nothing is sent
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-save.mjs
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const now = new Date().toISOString()
const load = (name) => JSON.parse(fs.readFileSync(new URL(`../tests/fixtures/documents/${name}.json`, import.meta.url), 'utf8'))
const first = load('app-all-tools')
const second = load('app-objects')
const note = (id, fixture, title) => ({ id, resourceId: `r${id}`, revision: 1, noteType: 'canvas', title, notebookId: 1, createdAt: now, updatedAt: now, content: fixture.content, pageState: fixture.pageState })
const notesDb = { 1: note(1, first, 'One'), 2: note(2, second, 'Two'), 3: { ...note(3, { content: null, pageState: {} }, 'Map'), noteType: 'mindmap' } }
const puts = []
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

const server = await createServer({ server: { port: 4804, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4809' } }, logLevel: 'error' })
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
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 3 }])
    if (p === '/notes' && req.method() === 'GET') return json(Object.values(notesDb).map(({ content, pageState, ...summary }) => summary))
    const m = /^\/notes\/(\d+)$/.exec(p)
    if (m && req.method() === 'GET') return json(notesDb[m[1]])
    if (m && req.method() === 'PUT') {
      const body = JSON.parse(req.postData())
      puts.push({ id: Number(m[1]), body })
      const stored = notesDb[m[1]]
      stored.revision += 1
      stored.content = body.content
      return json({ revision: stored.revision, resourceId: stored.resourceId })
    }
    return json({})
  })
  await page.goto('http://127.0.0.1:4804/notes')
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(1500)
  const putsFor = (id) => puts.filter((entry) => entry.id === id).length
  const select = async (id) => { await page.evaluate((target) => window.__personalNote.selectNote(target), id); await page.waitForTimeout(1800) }
  const active = () => page.evaluate(() => window.__personalNote.state.activeNoteId)
  const openId = await active()
  check('a note is open', openId === 1 || openId === 2, String(openId))
  await select(1 === openId ? 2 : 1)
  await select(openId)
  check('opening notes and switching between them with no edit sends no save', puts.length === 0, JSON.stringify(puts.map((entry) => entry.id)))

  // hidden and closed pages
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')) })
  await page.waitForTimeout(500)
  check('a page that is closed with no edit sends nothing', puts.length === 0)
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForTimeout(500)
  await page.evaluate(() => { delete document.visibilityState })
  check('a page that is hidden with no edit sends nothing', puts.length === 0)

  // an edit, then a switch: one save, with the edit in it
  const current = await active()
  const other = current === 1 ? 2 : 1
  const target = await page.evaluate(() => window.__personalNote.leaferEdits.doc.objects.find((object) => object.type !== 'connector' && object.geometry)?.id)
  await page.evaluate((id) => { const scene = window.__personalNote.leaferCanvas(); scene.select([id]); scene.nudge(7, 3) }, target)
  const movedTo = await page.evaluate((id) => window.__personalNote.leaferEdits.doc.objects.find((object) => object.id === id).geometry.x, target)
  await select(other)
  check('an edit followed by a switch sends exactly one save of that note', putsFor(current) === 1 && puts.length === 1, JSON.stringify(puts.map((entry) => entry.id)))
  const sentX = puts[0] && JSON.parse(JSON.stringify(puts[0].body.content)).nodes.find((node) => node.id === target)?.x
  check('and the save holds the edit', Math.round(movedTo) === sentX, `${movedTo} vs ${sentX}`)
  await select(current)
  await select(other)
  await select(current)
  check('after that save, going away and back sends nothing more', puts.length === 1, JSON.stringify(puts.map((entry) => entry.id)))
  const before = puts.length
  await select(3)
  await select(current)
  check('a mind map opened and left unchanged sends nothing', puts.length === before, JSON.stringify(puts.map((entry) => entry.id)))
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
