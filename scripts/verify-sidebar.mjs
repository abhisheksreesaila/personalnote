// F-064..F-067 the PARA sidebar, in the real app: Vite dev server on PN_VERIFY_PORT (default 4890) with a real API on the next port over,
// on a scratch database; headless Chromium (PN_VERIFY_BROWSER=webkit for the Mac app's engine, if it launches here).
// Run one at a time; it stops everything it starts and never touches port 3137 or the real database.
//   node scripts/verify-sidebar.mjs          (PN_SHOT=/path/shot.png also saves pictures)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium, webkit } from 'playwright'

const UI_PORT = Number(process.env.PN_VERIFY_PORT || 4890)
const API_PORT = UI_PORT + 1
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-sidebar-'))
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], {
  env: { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db') }, stdio: 'ignore',
})
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const call = async (method, url, body) => {
  const response = await fetch(`${API}/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return response.status === 204 ? null : response.json()
}
const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
const engine = process.env.PN_VERIFY_BROWSER === 'webkit' ? webkit : chromium
let browser
try {
  await apiUp()
  await server.listen()
  browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ['--disable-dev-shm-usage'] } : {}) })
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1400 } })).newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const shot = async (name) => { if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${name}.png`) }) }
  const open = async () => {
    await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
    await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
    await page.waitForFunction(() => !window.__personalNote.state.creatingNote)
    await page.waitForTimeout(300)
  }
  const settle = (ms = 250) => page.waitForTimeout(ms)
  const inboxCount = () => page.evaluate(() => Number(document.querySelector('#inbox-badge')?.textContent))
  const inboxTitles = () => page.evaluate(() => [...document.querySelectorAll('[aria-label="Inbox"] .note-list-item')].map((row) => row.textContent.trim()))

  // ---- F-064: a real Inbox ----
  await open()
  const first = (await call('GET', '/notes'))[0]
  check('the very first note lands in the Inbox (no notebook)', first.notebookId === null, JSON.stringify(first))
  check('the Inbox counts it and lists it', (await inboxCount()) === 1 && (await inboxTitles()).length === 1, JSON.stringify([await inboxCount(), await inboxTitles()]))

  const garden = await call('POST', '/notebooks', { name: 'Garden', category: 'areas' })
  const house = await call('POST', '/notebooks', { name: 'House', category: 'projects' })
  await open()
  await page.evaluate(() => window.__personalNote.createNote())
  await page.waitForFunction(() => !window.__personalNote.state.creatingNote)
  await settle()
  const afterQuick = await call('GET', '/notes')
  check('a quick note lands in the Inbox too', afterQuick.filter((note) => note.notebookId === null).length === 2 && (await inboxCount()) === 2, JSON.stringify(afterQuick.map((n) => n.notebookId)))
  check('the breadcrumb says the note is in the Inbox', (await page.textContent('#crumb-notebook')) === 'Inbox')

  await page.click(`[data-new-note-in="${garden.id}"]`, { force: true })
  await page.waitForFunction(() => !window.__personalNote.state.creatingNote)
  await settle()
  const afterPlus = await call('GET', '/notes')
  const made = afterPlus.find((note) => note.notebookId === garden.id)
  check("a note made from a notebook's + goes into that notebook, and the Inbox count stays", Boolean(made) && (await inboxCount()) === 2, JSON.stringify(afterPlus.map((n) => n.notebookId)))
  check('the breadcrumb shows that notebook', (await page.textContent('#crumb-notebook')) === 'Garden')

  // The notebook picker can file an Inbox note, and can send it back
  await page.evaluate((id) => window.__personalNote.selectNote(id), afterQuick.find((note) => note.notebookId === null).id)
  await settle(400)
  await page.click('#top-properties') // the picker lives in the settings and properties panel
  await settle(300)
  check('the picker shows Inbox for an unfiled note', (await page.textContent('#notebook-picker')).trim() === 'Inbox')
  await page.click('#notebook-picker')
  const pickerItems = await page.$$eval('#notebook-picker-menu [data-move-to-notebook]', (items) => items.map((item) => item.textContent.trim()))
  check('the picker lists Inbox and every notebook', pickerItems[0] === 'Inbox' && pickerItems.includes('Garden') && pickerItems.includes('House'), JSON.stringify(pickerItems))
  await page.click(`#notebook-picker-menu [data-move-to-notebook="${house.id}"]`)
  await settle(400)
  check('picking a notebook files the Inbox note there (Inbox count drops)', (await inboxCount()) === 1 && (await page.textContent('#crumb-notebook')) === 'House', String(await inboxCount()))
  await page.click('#notebook-picker')
  await page.click('#notebook-picker-menu [data-move-to-notebook="inbox"]')
  await settle(400)
  await page.keyboard.press('Escape')
  await page.click('#top-properties')
  check('picking Inbox in the picker unfiles it', (await inboxCount()) === 2 && (await page.textContent('#crumb-notebook')) === 'Inbox')
  const stored = await call('GET', '/notes')
  check('and the server agrees', stored.filter((note) => note.notebookId === null).length === 2, JSON.stringify(stored.map((n) => n.notebookId)))

  // Deleting a notebook sends its notes to the Inbox
  const doomed = await call('POST', '/notebooks', { name: 'Doomed', category: 'resources' })
  await call('POST', '/notes', { title: 'Lonely', notebookId: doomed.id })
  await open()
  await page.click(`[data-edit-notebook="${doomed.id}"]`, { force: true })
  await page.waitForSelector('#notebook-dialog[open]')
  await page.click('#delete-notebook')
  await settle(500)
  const lonely = (await call('GET', '/notes')).find((note) => note.title === 'Lonely')
  check('deleting a notebook moves its notes to the Inbox', lonely?.notebookId === null && (await inboxTitles()).includes('Lonely'), JSON.stringify(lonely))
  await shot('inbox')


  // ---- shared helpers for the sidebar checks ----
  const rowOf = (selector) => page.locator(selector).first()
  const centreOf = async (locator) => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 } }
  // A real mouse drag: press, a small move so the engine starts the drag, travel to the target, optionally look around mid-drag, release.
  const mouseDrag = async (from, to, { during = null, hover = 0 } = {}) => {
    const start = await centreOf(from)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 6, start.y + 6, { steps: 3 })
    const end = await centreOf(to)
    await page.mouse.move(end.x, end.y, { steps: 14 })
    await page.waitForTimeout(Math.max(hover, 150)) // dragover is delivered a moment after the last move
    if (during) await during()
    await page.mouse.up()
    await settle(500)
  }
  const countOf = (notebookId) => page.evaluate((id) => Number(document.querySelector(`[data-notebook-select="${id}"] .notebook-count`)?.textContent), notebookId)
  const noteRow = (title) => page.locator('[aria-label="Inbox"] .note-list-item', { hasText: title }).first()
  const toast = () => page.evaluate(() => { const t = document.querySelector('#toast'); return t.hidden ? '' : t.textContent })
  const serverNote = async (id) => (await call('GET', '/notes')).find((note) => note.id === id)
  const serverNotebook = async (id) => (await call('GET', '/notebooks')).find((notebook) => notebook.id === id)
  const sectionHead = (id) => rowOf(`[data-sec="${id}"] > [data-fold]`)
  const inSection = (section, notebookId) => page.evaluate(([name, id]) => document.querySelector(`[data-sec="${name}"] [data-notebook-select="${id}"]`) !== null, [section, notebookId])


  // ---- F-065: file by drag ----
  const old = await call('POST', '/notebooks', { name: 'Old taxes', category: 'projects' })
  const batch = []
  for (const title of ['Receipt', 'Idea', 'Quote', 'Recipe']) batch.push(await call('POST', '/notes', { title }))
  await open()
  const filedBefore = await inboxCount()
  const houseBefore = await countOf(house.id)

  // mouse down/move/up, the plainest gesture: an Inbox note onto a notebook
  await mouseDrag(noteRow('Receipt'), rowOf(`[data-notebook-drop="${house.id}"]`), {
    during: async () => {
      const mid = await page.evaluate(() => ({
        ghost: Boolean(document.querySelector('.drag-ghost')),
        lifting: document.querySelectorAll('.lifting').length,
        ringed: document.querySelectorAll('.drop-target').length,
      }))
      check('mid-drag: a ghost follows the pointer, the row lifts and the target is ringed', mid.ghost && mid.lifting === 1 && mid.ringed === 1, JSON.stringify(mid))
    },
  })
  check('dropping an Inbox note on a notebook: the Inbox count drops and the notebook count rises', (await inboxCount()) === filedBefore - 1 && (await countOf(house.id)) === houseBefore + 1, JSON.stringify([filedBefore, await inboxCount(), houseBefore, await countOf(house.id)]))
  check('the ghost, the lift and the ring are gone afterwards', await page.evaluate(() => !document.querySelector('.drag-ghost') && !document.querySelector('.drop-target') && !document.querySelector('.lifting')))
  const receipt = batch.find((note) => note.title === 'Receipt')
  check('the note is filed on the server', (await serverNote(receipt.id)).notebookId === house.id, JSON.stringify(await serverNote(receipt.id)))
  await open()
  check('and after a reload it is still filed, not in the Inbox', (await inboxTitles()).every((title) => title !== 'Receipt') && (await countOf(house.id)) === houseBefore + 1)

  // the HTML5 gesture Playwright offers (dragTo) does the same thing
  await noteRow('Idea').dragTo(rowOf(`[data-notebook-drop="${garden.id}"]`))
  await settle(500)
  check('dragTo: an Inbox note onto another notebook files it', (await serverNote(batch.find((note) => note.title === 'Idea').id)).notebookId === garden.id)

  // a note can also be dragged out of one notebook into another (open House first: its notes show)
  await page.click(`[data-notebook-select="${house.id}"]`)
  await settle(300)
  await mouseDrag(page.locator(`[data-note-id="${receipt.id}"]`).first(), rowOf(`[data-notebook-drop="${garden.id}"]`))
  check('a note dragged from a notebook into another notebook moves', (await serverNote(receipt.id)).notebookId === garden.id)

  // a notebook onto Archive: the lid opens while hovering, the notebook changes section
  await mouseDrag(rowOf(`[data-notebook-drag="${old.id}"]`), sectionHead('archive'), {
    during: async () => {
      const lid = await page.evaluate(() => ({
        open: document.querySelector('.sec-box').classList.contains('open'),
        ringed: Boolean(document.querySelector('[data-sec="archive"] > .sec-head.drop-target')),
      }))
      check('hovering a notebook over Archive opens the lid and rings the section', lid.open && lid.ringed, JSON.stringify(lid))
    },
    hover: 150,
  })
  check('the notebook is now in Archive', (await serverNotebook(old.id)).category === 'archive', JSON.stringify(await serverNotebook(old.id)))
  check('the lid closed again', await page.evaluate(() => !document.querySelector('.sec-box').classList.contains('open')))
  await shot('archive')

  // a notebook onto another section from the dragTo gesture
  await rowOf(`[data-notebook-drag="${garden.id}"]`).dragTo(sectionHead('resources'))
  await settle(500)
  check('dragTo: a notebook onto Resources changes its section', (await serverNotebook(garden.id)).category === 'resources')
  await open()
  check('and after a reload it is still there', await inSection('resources', garden.id))

  // dropping on something that is not a notebook changes nothing
  const stray = await call('POST', '/notes', { title: 'Stay put' })
  await open()
  await mouseDrag(noteRow('Stay put'), page.locator('#rail-new-note'))
  check('dropping on something that is not a notebook leaves the note in the Inbox', (await serverNote(stray.id)).notebookId === null)

  // a failed move puts everything back and shows the toast
  await page.route('**/api/notes/*/notebook', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no"}' }))
  const inboxNow = await inboxCount()
  await mouseDrag(noteRow('Stay put'), rowOf(`[data-notebook-drop="${house.id}"]`))
  check('a failed move puts the note back in the Inbox', (await inboxCount()) === inboxNow && (await inboxTitles()).includes('Stay put'), JSON.stringify(await inboxTitles()))
  check('and shows the toast', (await toast()).includes("Couldn't move it"), await toast())
  await page.unroute('**/api/notes/*/notebook')
  await page.route('**/api/notebooks/*', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no"}' }) : route.continue()))
  await mouseDrag(rowOf(`[data-notebook-drag="${house.id}"]`), sectionHead('areas'))
  check('a failed notebook move puts it back in its section, with the toast', (await inSection('projects', house.id)) && (await toast()).includes("Couldn't move it"))
  await page.unroute('**/api/notebooks/*')



  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED')
process.exit(results.every(Boolean) ? 0 : 1)
