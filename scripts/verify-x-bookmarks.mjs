// F-088 X bookmarks, in the real app against a fake X: Vite dev server on PN_VERIFY_PORT (default 4920), the real API on the next port
// (scripts/verify_x_server.py: the app wired to the fake X from tests/test_x_bookmarks.py), the fake X's control on +2 and the sign-in callback on +3.
// Headless Chromium (PN_VERIFY_BROWSER=webkit for the Mac app's engine); real mouse and keyboard. PN_PYTHON names the Python with the app's requirements.
// Checks: Settings shows Not connected, Connect X signs in (the "browser" follows the authorize link itself) and imports; the X bookmarks notebook with the
// X icon and a note per bookmark appears; one opens; one is archived by dragging its row into an Archive notebook; Sync now adds only the new one; a restart
// syncs on start without signing in again; Disconnect keeps the notes; no token or client id reaches the database.
// It stops the processes it starts, never uses port 3137 or a real database, and deletes only the scratch folder it made.
//   PN_SHOT=/path/x.png node scripts/verify-x-bookmarks.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium, webkit } from 'playwright'
import { showSection } from './lib/settings.mjs'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4920)
const API_PORT = UI_PORT + 1
const CONTROL_PORT = UI_PORT + 2
const CALLBACK_PORT = UI_PORT + 3
await assertPortsFree([UI_PORT, API_PORT, CONTROL_PORT, CALLBACK_PORT])
if ([UI_PORT, API_PORT, CONTROL_PORT, CALLBACK_PORT].includes(3137)) throw new Error('never the real app port')
const API = `http://127.0.0.1:${API_PORT}`
const CLIENT_ID = 'client-abc' // the id the fake X from tests/test_x_bookmarks.py accepts
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-x-'))
const python = process.env.PN_PYTHON || (fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3')
const dbPath = path.join(scratch, 'verify.db')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let apiProcess = null
const startApi = async (firstDelay) => {
  apiProcess = spawn(python, ['scripts/verify_x_server.py'], {
    env: { ...process.env, PERSONAL_NOTE_DB: dbPath, PN_X_FOLDER: scratch, PN_X_API_PORT: String(API_PORT), PN_X_CONTROL_PORT: String(CONTROL_PORT), PN_X_CALLBACK_PORT: String(CALLBACK_PORT), PN_X_POSTS: '5', PN_X_FIRST_DELAY: String(firstDelay) },
    stdio: 'ignore',
  })
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${API}/api/x/status`)).ok) return } catch {} await sleep(150) }
  throw new Error('API did not start')
}
const stopApi = async () => {
  if (!apiProcess) return
  const exited = new Promise((resolve) => apiProcess.once('exit', resolve))
  apiProcess.kill('SIGTERM')
  await Promise.race([exited, sleep(15000)])
  apiProcess = null
}
const call = async (method, url, body) => {
  const response = await fetch(`${API}/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return response.status === 204 ? null : response.json()
}
const addBookmark = (text) => fetch(`http://127.0.0.1:${CONTROL_PORT}/add?text=${encodeURIComponent(text)}`, { method: 'POST' })
const xNotes = async () => (await call('GET', '/notes')).filter((note) => note.title.startsWith('@ada: '))
const waitFor = async (what, test, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(200) } return false }

const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
const engine = process.env.PN_VERIFY_BROWSER === 'webkit' ? webkit : chromium
let browser
try {
  await startApi(3600)
  await server.listen()
  browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ['--disable-dev-shm-usage'] } : {}) })
  const context = await browser.newContext({ viewport: { width: 1360, height: 1400 } })
  const page = await context.newPage()
  await page.addInitScript(() => localStorage.setItem('pn.notesPanelOpen', '1'))
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const shot = async (name) => { if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${name}.png`) }) }
  const open = async () => {
    await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
    await page.waitForSelector('[data-notebook-select]', { timeout: 60000 })
    await page.waitForTimeout(300)
  }
  const openSettings = async () => {
    if (!(await page.locator('#properties-panel.open').count())) { await page.click('#share-button'); await page.click('#top-properties') }
    await showSection(page, 'x')
    await page.waitForFunction(() => document.querySelector('#x-headline')?.textContent !== 'Checking…', null, { timeout: 10000 })
    await page.waitForTimeout(500)
  }
  const headline = () => page.locator('#x-headline').textContent()

  await open()
  await openSettings()
  check('Settings has an X bookmarks section that starts Not connected', (await headline()) === 'Not connected')
  check('the client id field and Connect X show; Sync now and Disconnect do not', await page.locator('#x-client-id').isVisible() && await page.locator('#x-connect').isVisible() && await page.locator('#x-sync').isHidden() && await page.locator('#x-disconnect').isHidden())
  await shot('not-connected')

  await page.click('#x-connect')
  await page.waitForTimeout(400)
  check('Connect X with no client id says what is missing', /client id/i.test(await page.locator('#x-detail').textContent()), await page.locator('#x-detail').textContent())

  await page.fill('#x-client-id', CLIENT_ID)
  await page.click('#x-connect')
  check('Connect X signs in through the browser link and imports the 5 bookmarks', await waitFor('connected', async () => (await headline()) === '5 bookmarks', 30000), await headline())
  check('Sync now and Disconnect show once connected', await page.locator('#x-sync').isVisible() && await page.locator('#x-disconnect').isVisible() && await page.locator('#x-client-id').isHidden())
  await shot('connected')

  // The notes panel gets the new notebook without a reload (the app polls for changes).
  const xRow = page.locator('.nav-row', { hasText: 'X bookmarks' })
  const appeared = await waitFor('notebook row', async () => (await xRow.count()) > 0, 15000)
  check('the X bookmarks notebook appears in the notes panel', appeared)
  const glyph = await xRow.locator('.nbi').evaluate((node) => ({ svg: !!node.querySelector('svg'), lucide: node.querySelector('svg')?.getAttribute('class') ?? '' }))
  check('and carries the X icon', glyph.svg && !glyph.lucide.includes('lucide'), JSON.stringify(glyph))
  const stored = (await call('GET', '/notebooks')).find((item) => item.name === 'X bookmarks')
  check('the notebook stores icon brand:x with 5 notes', stored?.icon === 'brand:x' && stored?.noteCount === 5, JSON.stringify(stored))

  await xRow.locator('[data-notebook-select]').click()
  await page.waitForSelector('.note-list-item')
  const titles = await page.locator('.nbk.open .note-list-item span').allTextContents()
  check('the notebook lists the bookmarks newest first', titles.join('|') === '@ada: post 5|@ada: post 4|@ada: post 3|@ada: post 2|@ada: post 1', titles.join('|'))
  await shot('notebook')

  // Open one with the mouse.
  await page.locator('.note-list-item', { hasText: '@ada: post 3' }).click()
  await page.waitForFunction(() => document.body.innerText.includes('Open on X'), null, { timeout: 15000 })
  const text = await page.evaluate(() => document.body.innerText)
  check('opening a bookmark shows its text, author, link and picture link', ['post 3', 'Ada Lovelace', '@ada', 'https://x.com/ada/status/1003', 'https://pbs.example/m3.jpg'].every((part) => text.includes(part)), text.slice(0, 300))
  await shot('note')

  // Mark one done: drag its row into a notebook in the Archive (the app archives notebooks; a note is archived by filing it there).
  const archive = await call('POST', '/notebooks', { name: 'Done reading', category: 'archive' })
  await open()
  await page.locator('[data-fold="archive"]').click()
  await page.waitForTimeout(500)
  if (!(await page.locator('.note-list-item', { hasText: '@ada: post 4' }).count())) await xRow.locator('[data-notebook-select]').click()
  const row = page.locator('.note-list-item', { hasText: '@ada: post 4' })
  await row.waitFor()
  const target = page.locator(`[data-notebook-drop="${archive.id}"]`)
  await target.waitFor()
  const from = await row.boundingBox()
  const to = await target.boundingBox()
  await page.mouse.move(from.x + 40, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 60, from.y + from.height / 2 + 10, { steps: 6 })
  await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 25 })
  await page.waitForTimeout(300) // dragover is delivered a moment after the last move
  await page.mouse.up()
  check('dragging a bookmark row into an Archive notebook files it there', await waitFor('archived', async () => (await call('GET', '/notes')).find((note) => note.title === '@ada: post 4')?.notebookId === archive.id, 8000))

  // Sync now with one new bookmark: only that one arrives; the archived one is not imported again.
  await addBookmark('a brand new post')
  await openSettings()
  await page.click('#x-sync')
  check('Sync now adds the one new bookmark', await waitFor('six', async () => (await headline()) === '6 bookmarks', 20000), await headline())
  const afterSync = await xNotes()
  check('six bookmark notes in all, the archived one still in its archive and not duplicated', afterSync.length === 6 && afterSync.filter((note) => note.title === '@ada: post 4').length === 1 && afterSync.find((note) => note.title === '@ada: post 4').notebookId === archive.id, afterSync.map((note) => note.title).join('|'))
  check('the new bookmark is on top of the X bookmarks notebook', (await call('GET', '/notes')).filter((note) => note.notebookId === stored.id)[0]?.title === '@ada: a brand new post')

  // A restart: it syncs on start and is still signed in (no Connect X).
  await addBookmark('posted while the app was closed')
  await stopApi()
  await startApi(1)
  check('after a restart it syncs on its own and is still signed in', await waitFor('restart sync', async () => (await xNotes()).length === 7, 30000))
  await open()
  await openSettings()
  check('Settings shows it connected with 7 bookmarks and no sign-in asked', (await headline()) === '7 bookmarks' && await page.locator('#x-connect').isHidden(), await headline())

  // Disconnect keeps the notes.
  await page.click('#x-disconnect')
  check('Disconnect returns to Not connected', await waitFor('disconnected', async () => (await headline()) === 'Not connected', 10000))
  check('and keeps every imported note', (await xNotes()).length === 7)
  check('the client id is saved but never shown: no field, "Client ID saved", a Replace button', await page.locator('#x-client-id').isHidden() && /Client ID saved/.test(await page.locator('#x-detail').textContent()) && await page.locator('#x-replace').isVisible())
  const inPage = await page.evaluate((id) => document.documentElement.outerHTML.includes(id) || [...document.querySelectorAll('input,textarea')].some((field) => field.value.includes(id)), CLIENT_ID)
  check('the client id is nowhere in the page (markup, fields) or in the status the page gets', !inPage && !JSON.stringify(await call('GET', '/x/status')).includes(CLIENT_ID))
  await page.click('#x-replace')
  const field = await page.locator('#x-client-id').evaluate((node) => ({ value: node.value, height: node.getBoundingClientRect().height, size: getComputedStyle(node).fontSize }))
  check('Replace opens an empty field, 44px tall with 16px text', field.value === '' && field.height >= 44 && field.size === '16px', JSON.stringify(field))

  // Phone width: the section is reachable.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 780 } })).newPage()
  phone.on('pageerror', (error) => errors.push(error.message))
  await phone.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await phone.waitForSelector('[data-notebook-select]', { timeout: 60000 })
  await phone.click('#share-button')
  await phone.click('#top-properties')
  await phone.waitForSelector('#x-headline', { state: 'attached' })
  await showSection(phone, 'x')
  await phone.waitForTimeout(800) // the sheet slides in
  const box = await phone.locator('#settings-x-section').boundingBox()
  check('[phone] the X bookmarks section fits the width', box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box))

  // Nothing secret in the database.
  const databaseBytes = ['', '-wal'].map((suffix) => { try { return fs.readFileSync(dbPath + suffix) } catch { return Buffer.alloc(0) } })
  const dump = Buffer.concat(databaseBytes).toString('latin1')
  check('no token and no client id in the notes database', !dump.includes(CLIENT_ID) && !dump.includes('refresh-') && !dump.includes('access-'))
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  await stopApi()
  fs.rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nAll ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
