// F-027 read-only checks, in the real app (Vite dev server on port 4535, mocked in-memory /api, headless Chromium):
//   - renaming a note saves that note's own content and page state back untouched, to its own id
//   - a brand-new note holds no Fabric object (no ghost text box), typing saves no text, and the next note switch is clean
//   - a save is refused when the content on hand belongs to another note
//   - Print is off (preview does not open, a short notice shows)
//   - refreshText re-places text that was measured before fonts loaded
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-readonly.mjs
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const now = new Date().toISOString()
const load = (name) => JSON.parse(fs.readFileSync(new URL(`../tests/fixtures/documents/${name}.json`, import.meta.url), 'utf8'))
const one = load('app-all-tools')
const two = load('cli-appended')
const notesDb = {
  1: { id: 1, resourceId: 'r1', revision: 1, noteType: 'canvas', title: 'One', notebookId: 1, createdAt: now, updatedAt: now, content: one.content, pageState: one.pageState },
  2: { id: 2, resourceId: 'r2', revision: 1, noteType: 'canvas', title: 'Two', notebookId: 1, createdAt: now, updatedAt: now, content: two.content, pageState: two.pageState },
}
const originals = { 1: one, 2: two }
let nextId = 3
const puts = []
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

const server = await createServer({ server: { port: 4535, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
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
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 2 }])
    if (p === '/notes' && req.method() === 'GET') return json(Object.values(notesDb).map(({ content, pageState, ...summary }) => summary))
    if (p === '/notes' && req.method() === 'POST') {
      const id = nextId++
      notesDb[id] = { id, resourceId: `r${id}`, revision: 1, noteType: 'canvas', title: 'Untitled note', notebookId: 1, createdAt: now, updatedAt: now, content: { version: '7.4.0', objects: [] }, pageState: { columns: 1, rows: 1 } }
      const { content, pageState, ...summary } = notesDb[id]
      return json(summary)
    }
    const m = /^\/notes\/(\d+)$/.exec(p)
    if (m && req.method() === 'GET') return json(notesDb[m[1]])
    if (m && req.method() === 'PUT') {
      const body = JSON.parse(req.postData())
      puts.push({ id: Number(m[1]), body })
      const note = notesDb[m[1]]
      note.revision += 1
      return json({ revision: note.revision, resourceId: note.resourceId })
    }
    return json({})
  })
  await page.goto('http://127.0.0.1:4535/notes')
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  const active = await page.evaluate(() => window.__personalNote.state.activeNoteId)

  // 1. rename: the note's own content comes back untouched, to its own id
  await page.fill('#note-title', 'Renamed')
  await page.waitForTimeout(1500)
  const rename = puts.filter((put) => put.id === active)
  check('renaming saves once to the open note', rename.length >= 1, JSON.stringify(puts.map((p) => p.id)))
  const original = originals[active]
  check('the save carries the note content and page state exactly as loaded', rename.length > 0 && JSON.stringify(rename.at(-1).body.content) === JSON.stringify(original.content) && JSON.stringify(rename.at(-1).body.pageState) === JSON.stringify(original.pageState))
  check('the saved title is the new one', rename.at(-1)?.body.title === 'Renamed')
  puts.length = 0

  // 2. a save is refused when the content on hand belongs to another note
  await page.evaluate(() => window.__personalNote.setLeaferSourceNoteId(999))
  await page.fill('#note-title', 'Renamed again')
  await page.waitForTimeout(1500)
  check('a save whose content belongs to another note is refused', puts.length === 0, JSON.stringify(puts.map((p) => [p.id, Object.keys(p.body)])))
  await page.evaluate(() => document.querySelector('[data-note-id="2"]')?.click())
  await page.waitForTimeout(2500)
  check('after a refused save, switching notes still works', await page.evaluate(() => window.__personalNote.state.activeNoteId) === 2)
  await page.evaluate(() => document.querySelector('[data-note-id="1"]')?.click())
  await page.waitForTimeout(2000)
  puts.length = 0

  // 3. a new note: no Fabric object, typing saves no text
  await page.evaluate(() => window.__personalNote.createNote())
  await page.waitForTimeout(1200)
  const fresh = await page.evaluate(() => ({ active: window.__personalNote.state.activeNoteId, fabric: window.__personalNote.canvas.getObjects().map((o) => `${o.type}:${o.isEditing ? 'editing' : ''}`) }))
  check('a new note opens with no Fabric object over Leafer', fresh.fabric.length === 0, JSON.stringify(fresh))
  await page.keyboard.type('hello typed')
  await page.mouse.click(600, 400)
  await page.keyboard.type('more typed')
  await page.waitForTimeout(1500)
  const typedFabric = await page.evaluate(() => window.__personalNote.canvas.getObjects().length)
  const textSaved = puts.some((put) => JSON.stringify(put.body.content ?? '').includes('typed'))
  check('typing on a new note creates and saves nothing', typedFabric === 0 && !textSaved, JSON.stringify({ typedFabric, textSaved }))
  puts.length = 0

  // 4. switching back leaves Fabric empty and Leafer drawing note one
  await page.evaluate(() => document.querySelector('[data-note-id="1"]')?.click())
  await page.waitForTimeout(1500)
  const back = await page.evaluate(() => ({ active: window.__personalNote.state.activeNoteId, fabric: window.__personalNote.canvas.getObjects().length, accounted: (({ drawn, skipped, unknown }) => drawn + skipped + unknown)(window.__personalNote.leaferCanvas().stats()) }))
  check('switching notes leaves the Fabric canvas empty and Leafer drawing the note', back.active === 1 && back.fabric === 0 && back.accounted === one.content.objects.length, JSON.stringify(back))
  check('every save made meanwhile carries its own note content and nothing else', puts.every((put) => JSON.stringify(put.body.content) === JSON.stringify(notesDb[put.id].content)), JSON.stringify(puts.map((p) => p.id)))

  // 5. Print is off
  await page.keyboard.press('Control+KeyP')
  await page.waitForTimeout(300)
  const printHidden = await page.evaluate(() => document.querySelector('#print-preview').hidden)
  const notice = await page.evaluate(() => document.querySelector('#toast')?.textContent || '')
  check('Print does not open in Leafer mode and says it returns soon', printHidden && /Print returns soon/i.test(notice), notice)
  await page.evaluate(() => document.querySelector('#share-print')?.click())
  await page.waitForTimeout(300)
  check('the Share menu Print entry is inert too', await page.evaluate(() => document.querySelector('#print-preview').hidden))

  // 6. fonts finishing late: text without a stored size is measured again and placed again
  await page.evaluate(() => document.querySelector('[data-note-id="2"]')?.click())
  await page.waitForTimeout(1500)
  const replaced = await page.evaluate(() => {
    const leafer = window.__personalNote.leaferCanvas()
    const world = leafer.leafer.children[1]
    const texts = world.children.map((holder) => holder.children?.[0]).filter((node) => node?.tag === 'Text')
    const before = JSON.stringify(leafer.boxes())
    texts.forEach((text) => { text.fontSize *= 2 }) // stands in for a font that arrived late and measures bigger
    leafer.refreshText()
    return { texts: texts.length, changed: JSON.stringify(leafer.boxes()) !== before }
  })
  check('refreshText places no-height text again and its box follows', replaced.texts > 0 && replaced.changed, JSON.stringify(replaced))
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
if (results.some((ok) => !ok)) process.exitCode = 1
