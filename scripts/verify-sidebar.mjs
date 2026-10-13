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

  check('on a fresh start the Archive is folded and every other section is open', await page.evaluate(() => ['inbox', 'projects', 'areas', 'resources'].every((id) => document.querySelector(`[data-sec="${id}"]`).classList.contains('open')) && !document.querySelector('[data-sec="archive"]').classList.contains('open')))

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

  // ---- F-066: sections fold smoothly ----
  await open()
  const fold = (id) => page.evaluate((section) => {
    const element = document.querySelector(`[data-sec="${section}"]`)
    return { open: element.classList.contains('open'), expanded: element.querySelector('[data-fold]').getAttribute('aria-expanded'), rows: getComputedStyle(element.querySelector('.fold')).gridTemplateRows }
  }, id)
  const clickHead = async (id) => { await sectionHead(id).click({ position: { x: 40, y: 12 } }); await settle(260) }
  await page.evaluate(() => { document.querySelector('[data-sec="inbox"]').__same = true })
  await page.click('[data-fold="inbox"]')
  await settle(60)
  const midFold = await fold('inbox')
  await settle(300)
  const folded = await fold('inbox')
  check('the Inbox folds when its head is clicked (class and aria-expanded)', !folded.open && folded.expanded === 'false', JSON.stringify(folded))
  check('it folds by animating the row height, not by re-rendering', (await page.evaluate(() => document.querySelector('[data-sec="inbox"]').__same === true)) && midFold.rows !== folded.rows, JSON.stringify([midFold, folded]))
  check('the fold takes 180 ms', await page.evaluate(() => getComputedStyle(document.querySelector('[data-sec="inbox"] .fold')).transitionDuration === '0.18s'))
  await page.click('[data-fold="inbox"]')
  await settle(260)
  for (const id of ['projects', 'areas', 'resources', 'archive']) {
    const start = await fold(id)
    await clickHead(id)
    check(`${id} folds or unfolds with its head`, (await fold(id)).open !== start.open)
    await clickHead(id)
    check(`${id} comes back`, (await fold(id)).open === start.open)
  }
  // keyboard: a section head folds on Enter and on Space
  await page.focus('[data-sec="areas"] > [data-fold]')
  await page.keyboard.press('Enter')
  await settle(260)
  check('Enter on a focused section head folds it', !(await fold('areas')).open)
  await page.keyboard.press('Space')
  await settle(260)
  check('Space unfolds it', (await fold('areas')).open)
  await page.click('[data-fold="inbox"]')
  await settle(260)
  check('a folded section is not reachable by keyboard (inert)', await page.evaluate(() => document.querySelector('[data-sec="inbox"] .fold').inert))
  await page.click('[data-fold="inbox"]')
  await settle(260)

  // remembered on this machine
  await clickHead('projects')
  await page.click('[data-fold="inbox"]')
  await settle(260)
  await open()
  check('folded sections are remembered after a reload (Inbox and Projects folded, Areas open)', !(await fold('inbox')).open && !(await fold('projects')).open && (await fold('areas')).open, JSON.stringify([await fold('inbox'), await fold('projects'), await fold('areas')]))
  await page.click('[data-fold="inbox"]')
  await clickHead('projects')
  await open()
  check('unfolding is remembered too', (await fold('inbox')).open && (await fold('projects')).open)

  // spring open: hold a dragged note over a folded section's head
  await clickHead('resources')
  const grab = async (title) => {
    const at = await centreOf(noteRow(title))
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 6, at.y + 6, { steps: 3 })
    return at
  }
  const origin = await grab('Recipe')
  const headAt = await centreOf(sectionHead('resources'))
  await page.mouse.move(headAt.x, headAt.y, { steps: 12 })
  await page.waitForTimeout(250)
  check('a section does not spring open after a short hover', !(await fold('resources')).open)
  await page.waitForTimeout(450)
  check('a folded section springs open after about half a second of hovering while dragging', (await fold('resources')).open)
  await page.mouse.up()
  await settle(500)
  // passing over a folded section and leaving before the time never opens it
  await clickHead('areas')
  const passFrom = await grab('Quote')
  const areasAt = await centreOf(sectionHead('areas'))
  await page.mouse.move(areasAt.x, areasAt.y, { steps: 8 })
  await page.waitForTimeout(150)
  await page.mouse.move(passFrom.x, passFrom.y, { steps: 8 })
  await page.waitForTimeout(700)
  check('passing over a folded section and leaving does not open it', !(await fold('areas')).open)
  await page.mouse.up()
  await settle(400)
  await clickHead('areas')

  // reduced motion: no animation at all
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-sec="inbox"] .fold')).transitionDuration))
  check('prefers-reduced-motion: the fold does not animate', reduced < 0.001, String(reduced))
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // storage that is missing or throws must not break the sidebar
  const blockedContext = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const blocked = await blockedContext.newPage()
  const blockedErrors = []
  blocked.on('pageerror', (error) => blockedErrors.push(error.message))
  await blocked.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked') } }) })
  await blocked.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await blocked.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await blocked.click('[data-fold="inbox"]')
  await blocked.waitForTimeout(300)
  check('with browser storage blocked the sidebar still loads and folds', blockedErrors.length === 0 && (await blocked.evaluate(() => !document.querySelector('[data-sec="inbox"]').classList.contains('open'))), blockedErrors.join(' | '))
  await blockedContext.close()

  // ---- F-067: name a notebook in place ----
  await open()
  const plusOf = (id) => page.locator(`[data-new-notebook="${id}"]`)
  const notebookNames = async () => (await call('GET', '/notebooks')).map((notebook) => notebook.name)
  const initial = (await notebookNames()).length
  const startNaming = async (section) => { await sectionHead(section).hover(); await plusOf(section).click(); await settle(150) }
  await startNaming('areas')
  const naming = await page.evaluate(() => ({ input: Boolean(document.querySelector('.namer-input')), focused: document.activeElement?.classList.contains('namer-input'), dialog: document.querySelector('#notebook-dialog').open, hint: document.querySelector('.namer-hint')?.textContent }))
  check('the section + adds an input row with focus, and no dialog', naming.input && naming.focused && !naming.dialog, JSON.stringify(naming))
  check('the hint reads Enter to keep, Esc to drop', naming.hint === 'Enter to keep · Esc to drop', naming.hint)
  await shot('naming')
  await page.keyboard.type('Orchard')
  await page.keyboard.press('Enter')
  await settle(500)
  const orchard = (await call('GET', '/notebooks')).find((notebook) => notebook.name === 'Orchard')
  check('Enter creates the notebook in that section (POST /notebooks with its category)', orchard?.category === 'areas', JSON.stringify(orchard))
  check('the row is in the list and the input is gone', (await inSection('areas', orchard.id)) && !(await page.evaluate(() => document.querySelector('.namer-input'))))
  await startNaming('resources')
  await page.keyboard.type('Never kept')
  await page.keyboard.press('Escape')
  await settle(300)
  check('Esc drops the row and makes nothing', !(await page.evaluate(() => document.querySelector('.namer-input'))) && (await notebookNames()).length === initial + 1 && !(await notebookNames()).includes('Never kept'))
  check('Esc in the input does not open or close any dialog', !(await page.evaluate(() => document.querySelector('#notebook-dialog').open)))
  await startNaming('resources')
  await page.click('.brand-name')
  await settle(500)
  check('an empty name is dropped when you click away, and makes nothing', !(await page.evaluate(() => document.querySelector('.namer-input'))) && (await notebookNames()).length === initial + 1)
  await startNaming('projects')
  await page.keyboard.type('Kept by blur')
  await page.click('.brand-name')
  await settle(600)
  check('a typed name is kept when you click away', (await notebookNames()).includes('Kept by blur'))
  await startNaming('projects')
  await page.keyboard.press('Enter')
  await settle(400)
  check('Enter on an empty name makes nothing', (await notebookNames()).length === initial + 2 && !(await page.evaluate(() => document.querySelector('.namer-input'))))
  // the dialog is still there for colour and editing
  await sectionHead('areas').hover()
  await plusOf('areas').click({ modifiers: ['Shift'] })
  await settle(250)
  check('Shift+click on the + opens the full dialog (colour)', await page.evaluate(() => document.querySelector('#notebook-dialog').open && !document.querySelector('.namer-input')))
  await page.keyboard.press('Escape')
  await settle(200)
  await page.click(`[data-edit-notebook="${orchard.id}"]`, { force: true })
  await settle(250)
  check("a notebook's ... button still opens the dialog for editing", await page.evaluate(() => document.querySelector('#notebook-dialog').open && document.querySelector('#notebook-name').value === 'Orchard'))
  await page.keyboard.press('Escape')

  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED')
process.exit(results.every(Boolean) ? 0 : 1)
