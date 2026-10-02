// F-034: the speed test in the real app (Vite dev server on port 4806, mocked in-memory /api, headless Chromium), opened the way `npm run speedtest`
// opens it (?speedtest=1):
//   - it makes a stress note of 5,000+ objects in a note of its own, runs every scenario (open, pan, zoom, drag, undo and redo, pen, typing)
//     and shows the results; each scenario has p50, p95 and max
//   - the person's own notes are not touched (no save of them), the test note is removed at the end and the person's note is open again
//   - the report can be copied as text, and was saved through the app's /speedtest/report route
//
//   TMPDIR=/var/tmp/x node scripts/verify-speedtest.mjs
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const now = new Date().toISOString()
const load = (name) => JSON.parse(fs.readFileSync(new URL(`../tests/fixtures/documents/${name}.json`, import.meta.url), 'utf8'))
const mine = load('app-all-tools')
const notesDb = { 1: { id: 1, resourceId: 'r1', revision: 1, noteType: 'canvas', title: 'My note', notebookId: 1, createdAt: now, updatedAt: now, content: mine.content, pageState: mine.pageState } }
const calls = []
let report = null
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

const server = await createServer({ server: { port: 4806, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4809' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4806' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const summaries = () => Object.values(notesDb).map(({ content, pageState, ...summary }) => summary)
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: Object.keys(notesDb).length }])
    if (p === '/notes' && req.method() === 'GET') return json(summaries())
    if (p === '/notes' && req.method() === 'POST') {
      const body = JSON.parse(req.postData())
      const id = Math.max(...Object.keys(notesDb).map(Number)) + 1
      notesDb[id] = { id, resourceId: `r${id}`, revision: 1, noteType: body.noteType, title: body.title, notebookId: body.notebookId, createdAt: now, updatedAt: now, content: { objects: [] }, pageState: { columns: 1, rows: 1 } }
      calls.push(['POST', '/notes', id])
      const { content, pageState, ...summary } = notesDb[id]
      return json(summary, 201)
    }
    if (p === '/speedtest/report') { report = JSON.parse(req.postData()); calls.push(['POST', p]); return json({ path: '/tmp/speedtest-example.txt', jsonPath: '/tmp/speedtest-example.json' }, 201) }
    const m = /^\/notes\/(\d+)$/.exec(p)
    if (m) {
      const id = Number(m[1])
      if (req.method() === 'GET') return notesDb[id] ? json(notesDb[id]) : json({ error: 'not found' }, 404)
      if (req.method() === 'PUT') {
        const body = JSON.parse(req.postData())
        calls.push(['PUT', id, body.content?.nodes?.length])
        Object.assign(notesDb[id], { title: body.title, content: body.content, pageState: body.pageState, revision: notesDb[id].revision + 1 })
        return json({ revision: notesDb[id].revision, resourceId: notesDb[id].resourceId })
      }
      if (req.method() === 'DELETE') { calls.push(['DELETE', id]); delete notesDb[id]; return route.fulfill({ status: 204 }) }
    }
    return json({})
  })
  await page.goto('http://127.0.0.1:4806/notes?speedtest=1')
  await page.waitForFunction(() => document.documentElement.dataset.speedtestDone, null, { timeout: 420000 })
  const text = await page.evaluate(() => document.querySelector('.speedtest-panel').innerText)
  const rows = await page.evaluate(() => [...document.querySelectorAll('.speedtest-panel tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)))
  const names = rows.map((row) => row[0])
  for (const expected of ['Open the note', 'Pan (opening view)', 'Zoom', 'Pan (100%)', 'Drag one object', 'Drag 40 objects', 'Undo (the call', 'Redo (to the next frame', 'Pen (frames)', 'Pen (input to frame)', 'Typing (frames)', 'Typing (key to frame)']) {
    check(`the results have a row for "${expected}"`, names.some((name) => name.startsWith(expected)), JSON.stringify(names))
  }
  const numeric = rows.filter((row) => !row[0].startsWith('Open'))
  check('every row has p50, p95 and max as numbers, p50 <= p95 <= max', numeric.every((row) => { const [p50, p95, max] = row.slice(1, 4).map(Number); return Number.isFinite(p50) && Number.isFinite(p95) && Number.isFinite(max) && p50 <= p95 && p95 <= max }), JSON.stringify(numeric))
  check('the panel says what it ran on', /Chromium on .*cores/.test(text) && /5\d{3} objects/.test(text), text.slice(0, 400))
  check('the stress note had more than 5,000 objects', report?.data?.note?.objects >= 5000, JSON.stringify(report?.data?.note))
  check('nothing could not be measured', !report?.data?.failed?.length, JSON.stringify(report?.data?.failed))
  check('the report was saved through the app and its path is shown', Boolean(report?.text?.includes('Personal Note speed test')) && text.includes('/tmp/speedtest-example.txt'))
  check('the person\'s own note was never saved', !calls.some((call) => call[0] === 'PUT' && call[1] === 1), JSON.stringify(calls))
  check('the test note was made, filled once, and removed at the end', calls.filter((call) => call[0] === 'POST' && call[1] === '/notes').length === 1 && calls.filter((call) => call[0] === 'PUT').length === 1 && calls.some((call) => call[0] === 'DELETE') && Object.keys(notesDb).length === 1, JSON.stringify(calls))
  const back = await page.evaluate(() => window.__personalNote.state.activeNoteId)
  check('the person\'s note is open again', back === 1, String(back))
  const copied = await page.evaluate(async () => { document.querySelector('[data-act="copy"]').click(); await new Promise((r) => setTimeout(r, 200)); return navigator.clipboard.readText() })
  check('Copy results puts the report text on the clipboard', copied === report.text, copied.slice(0, 80))
  console.log(report.text)
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
