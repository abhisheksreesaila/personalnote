// F-034: the speed test in the real app (Vite dev server on port 4830, mocked in-memory /api, headless Chromium), opened the way `npm run speedtest`
// opens it (?speedtest=1):
//   - in the app itself (not the speed-test instance) Settings > Run… only asks for a separate instance and ?speedtest=1 does nothing
//   - in the speed-test instance it asks to start (Compare render modes is ticked), makes a stress note of 5,000+ objects in a note of its own, runs every scenario
//     (open, pan, zoom, drag, undo and redo, pen, typing) and shows the results; each scenario has p50, p95 and max
//   - Compare render modes then runs a quick version of the scenarios under every mode on the stress note and on a 600-object note, and shows them side by side
//   - Settings > Performance > Advanced > Render mode switches the canvas's render strategy and is remembered
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
let instance = true // what /speedtest/status says: only the separate speed-test instance runs the test
let report = null
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

const server = await createServer({ server: { port: 4830, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4839' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4830' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const apiHandler = async (route) => {
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
    if (p === '/speedtest/status') return json({ instance, canLaunch: !instance })
    if (p === '/speedtest/launch') { calls.push(['POST', p]); return json({ started: true }, 202) }
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
   }
  await context.route('**/api/**', apiHandler)
  await page.goto('http://127.0.0.1:4830/notes?speedtest=1')
  await page.waitForSelector('.speedtest-panel [data-act="start"]', { timeout: 60000 })
  check('the panel offers Compare render modes, ticked', await page.evaluate(() => document.querySelector('#speedtest-compare')?.checked === true))
  const started = Date.now()
  await page.click('.speedtest-panel [data-act="start"]')
  await page.waitForFunction(() => document.documentElement.dataset.speedtestDone, null, { timeout: 1500000 })
  console.log(`the whole run took ${Math.round((Date.now() - started) / 1000)} s`)
  const text = await page.evaluate(() => document.querySelector('.speedtest-panel').innerText)
  const rows = await page.evaluate(() => [...document.querySelectorAll('.speedtest-panel table:not(.speedtest-compare) tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)))
  const names = rows.map((row) => row[0])
  for (const expected of ['Open the note', 'Pan (whole desk, zoomed out)', 'Zoom', 'Pan (100%)', 'Drag one object', 'Drag 40 objects', 'Undo (the call', 'Redo (to the next frame', 'Pen (frames)', 'Pen (input to frame)', 'Typing (frames)', 'Typing (key to frame)']) {
    check(`the results have a row for "${expected}"`, names.some((name) => name.startsWith(expected)), JSON.stringify(names))
  }
  const numeric = rows.filter((row) => !row[0].startsWith('Open'))
  check('every row has p50, p95 and max as numbers, p50 <= p95 <= max', numeric.every((row) => { const [p50, p95, max] = row.slice(1, 4).map(Number); return Number.isFinite(p50) && Number.isFinite(p95) && Number.isFinite(max) && p50 <= p95 && p95 <= max }), JSON.stringify(numeric))
  check('the panel says what it ran on', /Chromium on .*cores/.test(text) && /5\d{3} objects/.test(text), text.slice(0, 400))
  check('the stress note had more than 5,000 objects', report?.data?.note?.objects >= 5000, JSON.stringify(report?.data?.note))
  check('nothing could not be measured', !report?.data?.failed?.length, JSON.stringify(report?.data?.failed))
  check('the report was saved through the app and its path is shown', Boolean(report?.text?.includes('Personal Note speed test')) && text.includes('/tmp/speedtest-example.txt'))
  check('the person\'s own note was never saved', !calls.some((call) => call[0] === 'PUT' && call[1] === 1), JSON.stringify(calls))
  check('the stress note and the realistic note were each made, filled once, and both removed at the end', calls.filter((call) => call[0] === 'POST' && call[1] === '/notes').length === 2 && calls.filter((call) => call[0] === 'PUT').length === 2 && calls.filter((call) => call[0] === 'DELETE').length === 2 && Object.keys(notesDb).length === 1, JSON.stringify(calls))
  // Compare render modes: every mode ran on both notes and the table is on screen and in the saved report
  const comparison = report?.data?.comparison
  const modeIds = ['default', 'bitmaps', 'dpr1', 'noShadow', 'fullRender']
  check('the comparison ran every mode on both notes', JSON.stringify(comparison?.modes?.map((mode) => mode.id)) === JSON.stringify(modeIds) && comparison.notes.length === 2 && comparison.notes.every((note) => modeIds.every((id) => Object.keys(note.results[id]?.rows ?? {}).length >= 7 && note.results[id].rows['Pan (100%)'].n > 20)), JSON.stringify(comparison?.notes?.map((note) => Object.keys(note.results))))
  check('every run of every mode began with the note\'s own objects (edits are put back)', comparison?.notes?.every((note) => modeIds.every((id) => note.starts?.[id]?.length === 2 && note.starts[id].every((count) => count === note.objects))), JSON.stringify(comparison?.notes?.map((note) => note.starts)))
  check('the second note is the 600-object one', comparison?.notes?.[1]?.objects >= 500 && comparison.notes[1].objects <= 700, JSON.stringify(comparison?.notes?.map((note) => note.objects)))
  check('no mode could not be measured', comparison?.notes?.every((note) => modeIds.every((id) => !note.results[id].failed.length)), JSON.stringify(comparison?.notes?.map((note) => modeIds.map((id) => note.results[id].failed))))
  const tables = await page.evaluate(() => [...document.querySelectorAll('.speedtest-compare')].map((table) => ({ heads: [...table.querySelectorAll('th')].map((th) => th.textContent), rows: [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)) })))
  check('the results panel has a side-by-side table per note, a column per mode, p50/p95/max in every cell', tables.length === 2 && tables.every((table) => table.heads.length === 6 && table.rows.length >= 7 && table.rows.every((row) => row.slice(1).every((cell) => /^[\d.]+\/[\d.]+\/[\d.]+( noisy)?$/.test(cell)))), JSON.stringify(tables[0]))
  check('the saved text has the comparison too', /Render modes on the stress note/.test(report?.text) && /Render modes on a realistic note/.test(report.text) && /Bitmaps always\s+DPR 1\s+Shadows off\s+Full redraw/.test(report.text))
  const finalPerf = await page.evaluate(() => JSON.stringify(window.__pnPerf ?? {}))
  check('the render mode is back to the saved one (default) afterwards', finalPerf === '{}', finalPerf)
  const back = await page.evaluate(() => window.__personalNote.state.activeNoteId)
  check('the person\'s note is open again', back === 1, String(back))
  const copied = await page.evaluate(async () => { document.querySelector('[data-act="copy"]').click(); await new Promise((r) => setTimeout(r, 200)); return navigator.clipboard.readText() })
  check('Copy results puts the report text on the clipboard', copied === report.text, copied.slice(0, 80))
  console.log(report.text)

  // Stop works during the run (only the rest of the panel is inert) and the panel is a corner box that does not cover the middle of the note
  await page.evaluate(() => { delete document.documentElement.dataset.speedtestDone })
  report = null
  await page.click('[data-act="again"]')
  await page.click('.speedtest-panel [data-act="start"]')
  await page.waitForSelector('.speedtest-panel [data-act="stop"]', { timeout: 60000 })
  await page.waitForTimeout(6000)
  const panelBox = await page.evaluate(() => { const r = document.querySelector('.speedtest-panel').getBoundingClientRect(); return { right: r.right, left: r.left, width: innerWidth } })
  check('while it runs the panel is in the corner (the middle of the note is free)', panelBox.left > panelBox.width / 2, JSON.stringify(panelBox))
  // Stop pressed in the middle of the comparison (not only in the first run) ends it and is not lost
  await page.waitForFunction(() => /Comparing render modes: a realistic note/.test(document.querySelector('.speedtest-step')?.textContent ?? ''), null, { timeout: 1500000 })
  await page.waitForTimeout(2500)
  await page.click('.speedtest-panel [data-act="stop"]')
  await page.waitForFunction(() => document.documentElement.dataset.speedtestDone, null, { timeout: 120000 })
  check('Stop pressed during the comparison ends the run, keeps the main results, and the results say so', Boolean(report?.data?.failed?.some((entry) => /comparison stopped/.test(entry))) && report.data.results.length > 5, JSON.stringify(report?.data?.failed))
  check('and the comparison got no further than the realistic note', report?.data?.comparison?.notes?.length === 2 && !report.data.comparison.notes[1].results.fullRender)
  check('and the test note was removed again', Object.keys(notesDb).length === 1)

  // the person's own app: nothing runs here, a separate instance is asked for
  instance = false
  calls.length = 0
  const own = await context.newPage()
  await own.goto('http://127.0.0.1:4830/notes?speedtest=1')
  await own.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await own.waitForTimeout(2500)
  check('?speedtest=1 in the person\'s own app does not run the test', !await own.evaluate(() => document.querySelector('.speedtest-panel')) && !calls.some((call) => call[0] === 'POST' && call[1] === '/notes'), JSON.stringify(calls))
  await own.evaluate(() => document.querySelector('#settings-speed-test').click())
  await own.waitForTimeout(1000)
  check('Settings > Run… asks for a separate instance and makes no note here', calls.some((call) => call[1] === '/speedtest/launch') && !calls.some((call) => call[1] === '/notes') && Object.keys(notesDb).length === 1, JSON.stringify(calls))
  check('and tells the person where the results will show', /window of its own/.test(await own.evaluate(() => document.body.innerText)))
  // Settings > Performance > Advanced > Render mode, on a 2x screen: default is unchanged, a choice goes into the canvas and is remembered
  const retina = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  await retina.route('**/api/**', apiHandler)
  const mac = await retina.newPage()
  mac.on('pageerror', (error) => errors.push(error.message))
  const ratio = () => mac.evaluate(() => Math.max(...[...document.querySelectorAll('#leafer-host canvas')].map((canvas) => canvas.width / canvas.getBoundingClientRect().width)))
  const choose = async (value) => { await mac.evaluate((v) => { const select = document.querySelector('#settings-render-mode'); select.value = v; select.dispatchEvent(new Event('change', { bubbles: true })) }, value); await mac.waitForTimeout(1000) }
  await mac.goto('http://127.0.0.1:4830/notes')
  await mac.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  check('Render mode starts at Default and draws at the screen\'s 2x', await mac.evaluate(() => document.querySelector('#settings-render-mode').value === 'default' && !window.__pnPerf?.pageBitmaps) && Math.abs(await ratio() - 2) < 0.05, String(await ratio()))
  await choose('bitmaps')
  check('choosing page bitmaps always sets the switches and keeps the note drawn', await mac.evaluate(() => window.__pnPerf?.pageBitmaps === 'always' && window.__pnPerf.lodZoom > 1 && window.__personalNote.state.activeNoteId === 1 && document.querySelectorAll('#leafer-host canvas').length > 0))
  await mac.reload()
  await mac.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  check('the choice is remembered after a reload', await mac.evaluate(() => window.__pnPerf?.pageBitmaps === 'always' && document.querySelector('#settings-render-mode').value === 'bitmaps'))
  await choose('dpr1')
  check('DPR 1 makes the live canvas draw at 1x', Math.abs(await ratio() - 1) < 0.05, String(await ratio()))
  await choose('default')
  check('and Default puts it back to 2x', Math.abs(await ratio() - 2) < 0.05, String(await ratio()))
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
