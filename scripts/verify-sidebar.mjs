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
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4890)
const API_PORT = UI_PORT + 1
await assertPortsFree([UI_PORT, API_PORT])
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-sidebar-'))
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], {
  env: { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db') }, stdio: 'ignore',
})
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
// The breadcrumb left the top bar (F-075). What is on screen now: the open note's row, and the group of the notes panel it sits in ("Inbox" or "Notes in <notebook>").
const GROUP_OF_OPEN_NOTE = "document.querySelector('.note-list-item.active')?.closest('[role=group]')?.getAttribute('aria-label') ?? null"
const IN = (name) => (name === 'Inbox' ? 'Inbox' : `Notes in ${name}`)
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
  await page.addInitScript(() => localStorage.setItem('pn.notesPanelOpen', '1')) // (F-074: the notes panel is closed by default; this check works inside it)
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
  const inboxTitles = () => page.evaluate(() => [...document.querySelectorAll('[aria-label="Inbox"] .note-list-item')].map((row) => row.querySelector('span').textContent.trim()))

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
  check('the open note sits in the Inbox group of the notes panel', (await page.evaluate(GROUP_OF_OPEN_NOTE)) === IN('Inbox'))

  await page.click(`[data-new-note-in="${garden.id}"]`, { force: true })
  await page.waitForFunction(() => !window.__personalNote.state.creatingNote)
  await settle()
  const afterPlus = await call('GET', '/notes')
  const made = afterPlus.find((note) => note.notebookId === garden.id)
  check("a note made from a notebook's + goes into that notebook, and the Inbox count stays", Boolean(made) && (await inboxCount()) === 2, JSON.stringify(afterPlus.map((n) => n.notebookId)))
  check('the open note sits in the Garden group of the notes panel', (await page.evaluate(GROUP_OF_OPEN_NOTE)) === IN('Garden'))

  // The notebook picker can file an Inbox note, and can send it back
  await page.evaluate((id) => window.__personalNote.selectNote(id), afterQuick.find((note) => note.notebookId === null).id)
  await settle(400)
  await page.click('#share-button') // (Settings now sits in the ... menu)
  await page.click('#share-props') // the picker lives in the note's properties popover (F-102)
  await settle(300)
  check('the picker shows Inbox for an unfiled note', (await page.textContent('#notebook-picker')).trim() === 'Inbox')
  await page.click('#notebook-picker')
  const pickerItems = await page.$$eval('#notebook-picker-menu [data-move-to-notebook]', (items) => items.map((item) => item.textContent.trim()))
  check('the picker lists Inbox and every notebook', pickerItems[0] === 'Inbox' && pickerItems.includes('Garden') && pickerItems.includes('House'), JSON.stringify(pickerItems))
  await page.click(`#notebook-picker-menu [data-move-to-notebook="${house.id}"]`)
  await settle(400)
  check('picking a notebook files the Inbox note there (Inbox count drops)', (await inboxCount()) === 1 && (await page.evaluate(GROUP_OF_OPEN_NOTE)) === IN('House'), String(await inboxCount()))
  await page.click('#notebook-picker')
  await page.click('#notebook-picker-menu [data-move-to-notebook="inbox"]')
  await settle(400)
  await page.keyboard.press('Escape')
  await page.click('#share-button') // (Settings now sits in the ... menu)
  await page.click('#top-properties')
  check('picking Inbox in the picker unfiles it', (await inboxCount()) === 2 && (await page.evaluate(GROUP_OF_OPEN_NOTE)) === IN('Inbox'))
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
  // The ring and the lid answer a dragenter/dragover: look for them for up to a second rather than once.
  const eventually = async (read, ms = 1500) => { let value; for (let waited = 0; waited < ms; waited += 50) { value = await read(); if (value) return value; await page.waitForTimeout(50) } return value }
  // a click on a notebook row toggles it (F-068), so "show its notes" means: click only if it is folded
  const ensureOpen = async (id) => { if (!(await page.evaluate((nb) => document.querySelector(`[data-nbk="${nb}"]`).classList.contains('open'), id))) await page.click(`[data-notebook-select="${id}"]`) }
  const sectionHead = (id) => rowOf(`[data-sec="${id}"] [data-fold]`)
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
      const mid = await eventually(() => page.evaluate(() => {
        const state = { ghost: Boolean(document.querySelector('.drag-ghost')), lifting: document.querySelectorAll('.lifting').length, ringed: document.querySelectorAll('.drop-target').length }
        return state.ghost && state.lifting === 1 && state.ringed === 1 ? state : null
      }))
      check('mid-drag: a ghost follows the pointer, the row lifts and the target is ringed', Boolean(mid), JSON.stringify(mid))
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
  await ensureOpen(house.id)
  await settle(300)
  await mouseDrag(page.locator(`[data-note-id="${receipt.id}"]`).first(), rowOf(`[data-notebook-drop="${garden.id}"]`))
  check('a note dragged from a notebook into another notebook moves', (await serverNote(receipt.id)).notebookId === garden.id)

  // a notebook onto Archive: the lid opens while hovering, the notebook changes section
  await mouseDrag(rowOf(`[data-notebook-drag="${old.id}"]`), sectionHead('archive'), {
    during: async () => {
      const lid = await eventually(() => page.evaluate(() => {
        const state = { open: document.querySelector('.sec-box').classList.contains('open'), ringed: Boolean(document.querySelector('[data-sec="archive"] .sec-head.drop-target')) }
        return state.open && state.ringed ? state : null
      }))
      check('hovering a notebook over Archive opens the lid and rings the section', Boolean(lid), JSON.stringify(lid))
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

  check('the Archive shelf shows how many notebooks it holds', (await page.textContent('[data-sec="archive"] .sec-head .notebook-count')).trim() === '1', await page.textContent('[data-sec="archive"] .sec-head'))

  // a note dragged onto the Inbox shelf is unfiled again
  const filed = batch.find((note) => note.title === 'Idea')
  await open()
  await ensureOpen(garden.id)
  await settle(300)
  const beforeInbox = await inboxCount()
  await mouseDrag(page.locator(`[data-note-id="${filed.id}"]`).first(), sectionHead('inbox'), {
    during: async () => {
      const ring = await eventually(() => page.evaluate(() => Boolean(document.querySelector('[data-sec="inbox"] .sec-head.drop-target'))))
      check('hovering a filed note over the Inbox shelf rings it', ring)
    },
  })
  check('dropping a filed note on the Inbox shelf unfiles it', (await serverNote(filed.id)).notebookId === null && (await inboxCount()) === beforeInbox + 1, JSON.stringify([await serverNote(filed.id), beforeInbox, await inboxCount()]))

  // a secure note keeps its lock in the Inbox and is filed by drag like any other note
  const vault = await call('POST', '/notes', { title: 'Vault note' })
  const sealed = await call('POST', `/notes/${vault.id}/secure`, { revision: vault.revision, passphrase: 'correct horse battery' })
  await open()
  check('a secure note in the Inbox shows its lock', sealed.error === undefined && await page.evaluate(() => Boolean(document.querySelector('[aria-label="Inbox"] .note-list-item.is-secure svg.lucide-lock'))), JSON.stringify(sealed).slice(0, 120))
  await mouseDrag(noteRow('Vault note'), rowOf(`[data-notebook-drop="${house.id}"]`))
  const moved = await serverNote(vault.id)
  check('dragging a secure note onto a notebook files it and it stays secure', moved.notebookId === house.id && moved.secure === true, JSON.stringify(moved))

  // a stale revision is refused, the row goes back, and the retry works because the revision was refreshed
  const stale = await call('POST', '/notes', { title: 'Stale one' })
  await call('PATCH', `/notes/${stale.id}/notebook`, { notebookId: null, revision: stale.revision }) // the server moves on to revision 2
  await open()
  await call('PATCH', `/notes/${stale.id}/notebook`, { notebookId: null, revision: stale.revision + 1 }) // ...and 3, behind the page's back
  await mouseDrag(noteRow('Stale one'), rowOf(`[data-notebook-drop="${house.id}"]`))
  check('a stale revision puts the note back with the toast', (await serverNote(stale.id)).notebookId === null && (await inboxTitles()).includes('Stale one') && (await toast()).includes("Couldn't move it"))
  await mouseDrag(noteRow('Stale one'), rowOf(`[data-notebook-drop="${house.id}"]`))
  check('and trying again works', (await serverNote(stale.id)).notebookId === house.id)
  const staleBook = await call('POST', '/notebooks', { name: 'Stale book', category: 'projects' })
  await open()
  await call('PUT', `/notebooks/${staleBook.id}`, { name: 'Stale book 2', revision: 1 })
  await mouseDrag(rowOf(`[data-notebook-drag="${staleBook.id}"]`), sectionHead('areas'))
  check('a stale notebook revision puts it back with the toast', (await serverNotebook(staleBook.id)).category === 'projects' && (await inSection('projects', staleBook.id)))
  await mouseDrag(rowOf(`[data-notebook-drag="${staleBook.id}"]`), sectionHead('areas'))
  check('and trying again works', (await serverNotebook(staleBook.id)).category === 'areas')

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
  await page.focus('[data-sec="areas"] [data-fold]')
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

  // remembered on this machine (Resources: no note of the newest is in it, so opening a note does not unfold it again)
  await clickHead('areas')
  await page.click('[data-fold="inbox"]')
  await settle(260)
  await open()
  check('folded sections are remembered after a reload (Inbox and Areas folded, Resources open)', !(await fold('inbox')).open && !(await fold('areas')).open && (await fold('resources')).open, JSON.stringify([await fold('inbox'), await fold('areas'), await fold('resources')]))
  await page.click('[data-fold="inbox"]')
  await clickHead('areas')
  await open()
  check('unfolding is remembered too', (await fold('inbox')).open && (await fold('areas')).open)

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
  await blocked.click('#toggle-sidebar') // (the panel is closed by default)
  await blocked.waitForTimeout(300)
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

  // the + is a real button: Tab to it and Enter (or Space) starts naming
  await open()
  await settle(900) // the editor takes the focus when a note opens; let it, then move the focus to the +
  await page.focus('[data-new-notebook="resources"]')
  await page.keyboard.press('Enter')
  await settle(200)
  check('Enter on the focused + starts naming (a real button, not a span)', await page.evaluate(() => document.querySelector('[data-new-notebook="resources"]').tagName === 'BUTTON' && document.activeElement?.classList.contains('namer-input')))
  await page.keyboard.press('Escape')
  await page.focus('[data-new-notebook="resources"]')
  await page.keyboard.press('Space')
  await settle(200)
  check('Space on the focused + starts naming too', await page.evaluate(() => document.activeElement?.classList.contains('namer-input')))
  // the colour dot hands the typed name to the full dialog (works by touch)
  await page.keyboard.type('Pick a colour')
  await page.click('.namer-dot')
  await settle(300)
  const handed = await page.evaluate(() => ({ open: document.querySelector('#notebook-dialog').open, name: document.querySelector('#notebook-name').value, row: Boolean(document.querySelector('.namer')), category: document.querySelector('[name="notebook-category"]:checked')?.value }))
  check('the row\'s colour dot opens the dialog with the typed name and the section', handed.open && handed.name === 'Pick a colour' && !handed.row && handed.category === 'resources', JSON.stringify(handed))
  check('and making nothing yet', !(await notebookNames()).includes('Pick a colour'))
  await page.keyboard.press('Escape')
  await settle(200)
  check('the + tooltip says how to reach the dialog', (await plusOf('areas').getAttribute('title')).includes('Shift'))
  // a re-render while the colour dot has the focus gives the focus back to the dot
  await startNaming('resources')
  await page.keyboard.type('Keep my dot')
  await page.keyboard.press('Shift+Tab')
  await page.evaluate(() => window.__personalNote.refreshWorkspaceLists()) // re-renders the sidebar
  await settle(300)
  check('a re-render while the colour dot has the focus gives the focus back to the dot, with the name kept', await page.evaluate(() => document.activeElement?.classList.contains('namer-dot') && document.querySelector('.namer-input').value === 'Keep my dot'))
  await page.keyboard.press('Escape')
  await settle(200)
  // a press on the colour dot that slides away and lets go elsewhere does not strand the row (empty: dropped; typed: kept)
  const slideOffDot = async () => {
    const box = await page.locator('.namer-dot').boundingBox()
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    // the press must land on the real dot: it is on the sidebar, not clipped away or covered
    const under = await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.className, at)
    check('the inline row\'s colour dot is on screen and is what is under the pointer', under === 'notebook-dot namer-dot' && box.x > 12, JSON.stringify([under, box]))
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(700, 500, { steps: 6 })
    await page.mouse.up()
    await settle(300)
    // Chromium gives a pressed button the focus, so the row waits there; clicking away is what settles it (engines that do not focus a button settle at pointerup)
    await page.click('.brand-name')
    await settle(500)
  }
  await startNaming('resources')
  await slideOffDot()
  check('pressing the colour dot, sliding away and releasing drops an empty row', !(await page.evaluate(() => document.querySelector('.namer'))) && !(await page.evaluate(() => document.querySelector('#notebook-dialog').open)))
  await startNaming('resources')
  await page.keyboard.type('Slid away')
  await slideOffDot()
  check('and keeps a typed name', (await notebookNames()).includes('Slid away') && !(await page.evaluate(() => document.querySelector('.namer'))))
  // focus on the colour dot (Shift+Tab from the field), then away: the row is settled when focus leaves the whole row
  await startNaming('resources')
  await page.keyboard.press('Shift+Tab')
  check('Shift+Tab moves from the field to the colour dot', await page.evaluate(() => document.activeElement?.classList.contains('namer-dot')))
  await settle(300)
  check('and the row stays while focus is on the dot', await page.evaluate(() => Boolean(document.querySelector('.namer'))))
  await page.click('.brand-name')
  await settle(500)
  check('clicking away from the dot drops an empty row', !(await page.evaluate(() => document.querySelector('.namer'))))
  await startNaming('resources')
  await page.keyboard.type('Left by tab')
  await page.keyboard.press('Shift+Tab')
  await settle(300) // focus is on the dot; the field's own blur has long been settled
  check('with a name typed the row still stays while focus is on the dot', await page.evaluate(() => Boolean(document.querySelector('.namer')) && document.activeElement?.classList.contains('namer-dot')))
  await page.click('.brand-name')
  await settle(600)
  check('and keeps a typed name', (await notebookNames()).includes('Left by tab'))

  // ---- F-068: a notebook folds its own notes ----
  const shelfA = await call('POST', '/notebooks', { name: 'Shelf A', category: 'projects' })
  const shelfB = await call('POST', '/notebooks', { name: 'Shelf B', category: 'projects' })
  const notesA = []
  for (const title of ['Alpha one', 'Alpha two', 'Alpha three']) notesA.push(await call('POST', '/notes', { title, notebookId: shelfA.id }))
  const noteB = await call('POST', '/notes', { title: 'Beta one', notebookId: shelfB.id })
  await open()
  const nbOpen = (id) => page.evaluate((nb) => document.querySelector(`[data-nbk="${nb}"]`).classList.contains('open'), id)
  const aria = (id) => page.getAttribute(`[data-notebook-select="${id}"]`, 'aria-expanded')
  const notesShown = (id) => page.evaluate((nb) => { const list = document.querySelector(`[data-nbk="${nb}"] > .fold`); return Boolean(list.querySelector('.nav-notes')) && list.getBoundingClientRect().height > 4 }, id)
  const tab = (id) => page.locator(`[data-notebook-select="${id}"]`)
  const storedOpen = () => page.evaluate(() => JSON.parse(localStorage.getItem('personal-note-open-notebooks') || '{}'))
  // bring both to a known state: A open, B folded
  if (!(await nbOpen(shelfA.id))) { await tab(shelfA.id).click(); await settle(300) }
  if (await nbOpen(shelfB.id)) { await tab(shelfB.id).click(); await settle(300) }
  check('an open notebook shows its notes and says so (aria-expanded)', (await nbOpen(shelfA.id)) && (await aria(shelfA.id)) === 'true' && (await notesShown(shelfA.id)))
  await page.evaluate((id) => { document.querySelector(`[data-nbk="${id}"]`).dataset.mark = 'same' }, shelfA.id)
  await tab(shelfA.id).click()
  await settle(350)
  check('clicking an open notebook folds its notes (hidden, not reachable, aria-expanded false)', !(await nbOpen(shelfA.id)) && (await aria(shelfA.id)) === 'false' && !(await notesShown(shelfA.id)) && await page.evaluate((id) => document.querySelector(`[data-nbk="${id}"] > .fold`).hasAttribute('inert'), shelfA.id))
  check('the fold re-renders nothing (the same element, marked before the click)', await page.evaluate((id) => document.querySelector(`[data-nbk="${id}"]`).dataset.mark === 'same', shelfA.id))
  check('a folded notebook still shows its count and its chevron', (await countOf(shelfA.id)) === 3 && await page.evaluate((id) => Boolean(document.querySelector(`[data-nbk="${id}"] .notebook-tab .sec-chev`)), shelfA.id))
  await tab(shelfA.id).click()
  await settle(350)
  check('clicking it again opens the notes', (await nbOpen(shelfA.id)) && (await notesShown(shelfA.id)))
  await tab(shelfB.id).click()
  await settle(350)
  check('several notebooks can be open at once', (await nbOpen(shelfA.id)) && (await nbOpen(shelfB.id)) && (await notesShown(shelfA.id)) && (await notesShown(shelfB.id)))
  // keyboard
  await tab(shelfA.id).focus()
  await page.keyboard.press('Enter')
  await settle(350)
  check('Enter on a focused notebook folds it', !(await nbOpen(shelfA.id)) && (await aria(shelfA.id)) === 'false')
  await page.keyboard.press('Space')
  await settle(350)
  check('Space opens it again', (await nbOpen(shelfA.id)) && (await notesShown(shelfA.id)))
  // the + and the ... still work on a row
  await page.click(`[data-edit-notebook="${shelfA.id}"]`, { force: true })
  await settle(250)
  check('the ... still opens the notebook dialog and does not fold', await page.evaluate(() => document.querySelector('#notebook-dialog').open) && (await nbOpen(shelfA.id)))
  await page.keyboard.press('Escape')
  await settle(200)
  // remembered after a reload
  await tab(shelfA.id).click() // fold A
  await settle(350)
  check('the choice is remembered on this machine (storage)', (await storedOpen())[shelfA.id] === false && (await storedOpen())[shelfB.id] === true, JSON.stringify(await storedOpen()))
  await open()
  const selectedAfterReload = await page.evaluate(() => window.__personalNote.state.selectedNotebookId)
  const remembered = selectedAfterReload === shelfA.id ? shelfB : shelfA
  const rememberedOpen = remembered === shelfB
  check('after a reload a folded notebook is still folded and an open one still open', (await nbOpen(remembered.id)) === rememberedOpen && (selectedAfterReload === shelfA.id || !(await nbOpen(shelfA.id))), JSON.stringify([selectedAfterReload, await nbOpen(shelfA.id), await nbOpen(shelfB.id)]))
  // opening a note from search opens its folded notebook
  if (await nbOpen(shelfA.id)) { await tab(shelfA.id).click(); await settle(350) }
  check('(setup) Shelf A is folded before the search', !(await nbOpen(shelfA.id)))
  await page.keyboard.press('Control+k')
  await settle(300)
  await page.fill('#search-input', 'Alpha two')
  await page.waitForSelector('[data-search-note-id]', { timeout: 10000 })
  await page.click(`[data-search-note-id="${notesA[1].id}"]`)
  await settle(600)
  check('opening a note from search opens its folded notebook and shows the note', (await nbOpen(shelfA.id)) && await page.evaluate((id) => document.querySelector(`[data-note-id="${id}"]`)?.classList.contains('active'), notesA[1].id))
  // a new note from the + of a folded notebook opens that notebook
  await tab(shelfB.id).click()
  if (await nbOpen(shelfB.id)) await tab(shelfB.id).click()
  await settle(350)
  check('(setup) Shelf B is folded', !(await nbOpen(shelfB.id)))
  // drag onto a folded notebook still files
  const dropperOne = await call('POST', '/notes', { title: 'Moth' })
  const dropperTwo = await call('POST', '/notes', { title: 'Zebra' })
  await open()
  // drag one that is not the open note (dragging the open note itself moves the view with it, which opens its notebook)
  const dropper = (await page.evaluate(() => window.__personalNote.state.activeNoteId)) === dropperOne.id ? dropperTwo : dropperOne
  if (await nbOpen(shelfB.id)) { await tab(shelfB.id).click(); await settle(350) }
  const bBefore = await countOf(shelfB.id)
  await mouseDrag(noteRow(dropper.title), tab(shelfB.id).first())
  check('dragging a note onto a folded notebook files it, bumps its count and leaves it folded', (await serverNote(dropper.id)).notebookId === shelfB.id && (await countOf(shelfB.id)) === bBefore + 1 && !(await nbOpen(shelfB.id)), JSON.stringify([await serverNote(dropper.id), bBefore, await countOf(shelfB.id), await nbOpen(shelfB.id)]))
  // the + on a folded notebook opens it with the new note
  await page.click(`[data-new-note-in="${shelfB.id}"]`, { force: true })
  await page.waitForFunction(() => !window.__personalNote.state.creatingNote)
  await settle(600)
  check('a new note from a folded notebook opens that notebook', (await nbOpen(shelfB.id)) && (await notesShown(shelfB.id)))
  // reduced motion: the fold still works (instantly)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await tab(shelfB.id).click()
  await settle(300)
  check('with reduced motion the fold still works', !(await nbOpen(shelfB.id)) && (await eventually(async () => !(await notesShown(shelfB.id)))))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await shot('notebook-fold')

  // ---- F-068 review: a fold click only folds; opening or creating a note always opens its own notebook; stale ids are pruned ----
  await open()
  await page.evaluate((id) => window.__personalNote.selectNote(id), notesA[0].id)
  await settle(500)
  await ensureOpen(shelfA.id)
  await ensureOpen(shelfB.id)
  await settle(300)
  const picked = () => page.evaluate(() => ({ selected: window.__personalNote.state.selectedNotebookId, crumb: document.querySelector('.note-list-item.active')?.closest('[role=group]')?.getAttribute('aria-label') ?? null, marked: [...document.querySelectorAll('.nav-row.active')].map((row) => row.parentElement.dataset.nbk) }))
  const pickedBefore = await picked()
  await tab(shelfB.id).click()
  await settle(350)
  const pickedAfter = await picked()
  check('folding another notebook leaves the selected notebook, its row and the breadcrumb alone', JSON.stringify(pickedBefore) === JSON.stringify(pickedAfter) && pickedAfter.selected === shelfA.id && pickedAfter.crumb === 'Notes in Shelf A', JSON.stringify([pickedBefore, pickedAfter]))
  await tab(shelfA.id).click() // fold the open note's own notebook
  await settle(350)
  check("(setup) the open note's own notebook is folded", !(await nbOpen(shelfA.id)))
  await page.keyboard.press('Control+k')
  await settle(300)
  await page.fill('#search-input', 'Alpha three')
  await page.waitForSelector('[data-search-note-id]', { timeout: 10000 })
  await page.click(`[data-search-note-id="${notesA[2].id}"]`)
  await settle(600)
  check('opening a sibling from search opens the folded notebook of the note that was already open', (await nbOpen(shelfA.id)) && (await notesShown(shelfA.id)) && !(await page.evaluate((id) => document.querySelector(`[data-nbk="${id}"] > .fold`).hasAttribute('inert'), shelfA.id)))
  await tab(shelfA.id).click()
  await settle(350)
  await page.click(`[data-new-note-in="${shelfA.id}"]`, { force: true })
  await page.waitForFunction(() => !window.__personalNote.state.creatingNote)
  await settle(600)
  check('a new note from the + of the folded notebook the open note is in opens it', (await nbOpen(shelfA.id)) && (await notesShown(shelfA.id)))
  // ids of notebooks that no longer exist are dropped from the remembered record
  await page.evaluate(() => { const record = JSON.parse(localStorage.getItem('personal-note-open-notebooks') || '{}'); record[987654] = true; localStorage.setItem('personal-note-open-notebooks', JSON.stringify(record)) })
  await open()
  check('ids of notebooks that are gone are pruned from the remembered record', await page.evaluate(() => !('987654' in JSON.parse(localStorage.getItem('personal-note-open-notebooks') || '{}'))))
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED')
process.exit(results.every(Boolean) ? 0 : 1)
