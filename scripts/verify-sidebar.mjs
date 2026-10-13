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
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage()
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
  const inboxCount = () => page.evaluate(() => Number(document.querySelector('[data-inbox-toggle] .notebook-count')?.textContent))
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

  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED')
process.exit(results.every(Boolean) ? 0 : 1)
