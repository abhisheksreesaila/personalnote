// F-058 secure notes, in the real app: Vite dev server on PN_VERIFY_PORT (default 4860) with a real API on the next port over a scratch
// database (quiet time 6 s so auto-lock can be waited for), headless Chromium, the Linux path (a passphrase). Run one at a time; it stops
// everything it starts. Touch ID, hiding the window from screen sharing and sleep can only be tried on a Mac.
//   node scripts/verify-secure-notes.mjs          (PN_SHOT=/path/shot.png also saves pictures)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const UI_PORT = Number(process.env.PN_VERIFY_PORT || 4860)
const API_PORT = UI_PORT + 1
const API = `http://127.0.0.1:${API_PORT}`
const QUIET_SECONDS = 6
const SECRET = 'ZEBRA-CARD-4111-1111 quokkaphrase'
const PASSPHRASE = 'correct horse battery'
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-secure-'))
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], {
  env: { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db'), PERSONAL_NOTE_SECURE_IDLE_SECONDS: String(QUIET_SECONDS) }, stdio: 'ignore',
})
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
const headers = { 'content-type': 'application/json', 'x-personal-note': '1' }
const call = async (method, url, body) => {
  const response = await fetch(`${API}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}
let browser
try {
  await apiUp()
  await server.listen()
  const notebook = (await call('GET', '/api/notebooks')).body[0]
  const makeNote = async (title, markdown) => {
    const created = (await call('POST', '/api/notes', { title, notebookId: notebook.id, noteType: 'page' })).body
    const saved = (await call('PUT', `/api/notes/${created.id}`, { title, notebookId: notebook.id, revision: created.revision, pageState: { columns: 1, rows: 1 }, content: { markdown } })).body
    return { id: created.id, revision: saved.revision }
  }
  const cards = await makeNote('Cards', `Card ${SECRET}`)
  const plain = await makeNote('Shopping', 'Milk and eggs')

  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage()
  const errors = []
  const puts = []
  page.on('pageerror', (error) => errors.push(error.message))
  if (process.env.PN_DEBUG) { page.on('response', async (r) => { if (r.request().method() !== 'GET') console.log('  >', r.request().method(), r.url().replace(/^.*\/api/, ''), r.status(), (r.request().postData() ?? '').slice(0, 160)) }); page.on('console', (m) => console.log('  console:', m.text().slice(0, 200))) }
  page.on('request', (request) => { if (request.method() === 'PUT' && /\/api\/notes\/\d+$/.test(request.url())) puts.push({ url: request.url(), at: Date.now() }) })
  await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await page.waitForFunction(() => !window.__personalNote.state.loading, null, { timeout: 30000 })
  const pn = (fn, arg) => page.evaluate(fn, arg)
  const select = async (id) => { await pn((noteId) => window.__personalNote.selectNote(noteId), id); await page.waitForFunction((noteId) => window.__personalNote.state.activeNoteId === noteId && !window.__personalNote.state.loading, id, { timeout: 30000 }); await page.waitForTimeout(500) }
  const shot = async (name) => { if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${name}.png`) }) }
  const serverStatus = async () => (await call('GET', '/api/secure/status')).body
  const bodyHasSecret = () => pn((secret) => {
    const everything = document.documentElement.outerHTML + document.body.innerText + [...document.querySelectorAll('input, textarea')].map((field) => field.value).join(' ')
    return everything.includes(secret) || everything.includes('4111')
  }, 'ZEBRA')
  const cover = () => page.locator('.secure-cover')
  const pill = () => page.locator('.secure-pill')

  // ---- make a note secure: choose a passphrase, then the one-time recovery key ----
  await select(cards.id)
  check('an ordinary note starts without the cover or the pill', (await cover().count()) === 0 && (await pill().count()) === 0)
  await page.click('#top-properties')
  await page.waitForTimeout(300)
  check('the note menu offers "Make secure"', (await page.locator('#secure-note span').textContent()) === 'Make secure')
  await page.click('#secure-note')
  await page.waitForSelector('.secure-sheet')
  check('the first time asks for a passphrase for this computer', /Choose a passphrase/.test(await page.locator('.secure-sheet h3').textContent()))
  await page.fill('.secure-sheet input[name=passphrase]', 'short')
  await page.fill('.secure-sheet input[name=again]', 'short')
  await page.click('.secure-sheet .primary')
  check('a too-short passphrase is turned back with a message', /at least 8/.test((await page.locator('.secure-sheet-error').textContent()) ?? ''))
  await page.fill('.secure-sheet input[name=passphrase]', PASSPHRASE)
  await page.fill('.secure-sheet input[name=again]', 'something else entirely')
  await page.click('.secure-sheet .primary')
  check('two different passphrases are turned back', /don't match/.test((await page.locator('.secure-sheet-error').textContent()) ?? ''))
  await page.fill('.secure-sheet input[name=again]', PASSPHRASE)
  await page.click('.secure-sheet .primary')
  await page.waitForSelector('[data-recovery-key]', { timeout: 20000 })
  const key = (await page.locator('[data-recovery-key]').textContent()).replace(/\s+/g, '-')
  check('the recovery key is shown once as eight groups of four', /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(key), key)
  check('with the warning that it is shown once', /shown once/.test(await page.locator('.secure-warn').textContent()))
  check('Done waits for "I saved it somewhere safe"', await page.locator('[data-done]').isDisabled())
  await shot('recovery-key')
  await page.click('[data-saved]')
  check('and opens when that is ticked', await page.locator('[data-done]').isEnabled())
  await page.click('[data-done]')
  await page.waitForSelector('.secure-pill')
  check('the sheet is gone and the note stays open, unlocked', (await page.locator('.secure-sheet-back').count()) === 0 && (await serverStatus()).unlocked)
  const pillText = await pill().textContent()
  check('the pill counts down and offers Lock', /locks in \d:\d\d/.test(pillText) && (await pill().locator('.secure-lock').count()) === 1, pillText)
  check('without a Mac bridge the pill does not claim the window is hidden', !/Hidden from screen sharing/.test(pillText), pillText)
  check('the open secure note has its top edge in the secure colour', (await page.locator('.secure-edge').count()) === 1)
  check('the menu now offers "Make ordinary"', (await page.locator('#secure-note span').textContent()) === 'Make ordinary')
  await shot('open')

  // ---- the sidebar list ----
  const row = page.locator(`.note-list-item[data-note-id="${cards.id}"]`)
  await page.evaluate(() => document.querySelector('#sidebar')?.scrollTo?.(0, 0))
  check('a secure note shows the lock in the secure colour in the note list', (await row.count()) === 1 && (await row.evaluate((element) => element.classList.contains('is-secure') && Boolean(element.querySelector('svg.lucide-lock')))))
  const rowColor = await row.evaluate((element) => getComputedStyle(element).color)
  const secureColor = await pn(() => { const probe = document.createElement('i'); probe.style.color = 'var(--sk-secure)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color })
  check('in the skin\'s secure colour', rowColor === secureColor, `${rowColor} vs ${secureColor}`)
  check('an ordinary note\'s row keeps its own icon', await page.locator(`.note-list-item[data-note-id="${plain.id}"]`).evaluate((element) => !element.classList.contains('is-secure') && !element.querySelector('svg.lucide-lock')))

  // ---- editing it, and saving it (the words come back, not the cover) ----
  check('an unlocked secure note shows its words', (await pn(() => document.body.innerText)).includes('quokkaphrase'))
  await pn(() => document.querySelector('#page-host .cm-content').focus())
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' plus a new PIN 9090')
  await page.waitForTimeout(1500)
  if (process.env.PN_DEBUG) console.log('  editor:', JSON.stringify(await pn(() => document.querySelector('#page-host .cm-content')?.innerText)), await pn(() => JSON.stringify({ active: document.activeElement?.className, loading: window.__personalNote.state.loading, locked: window.__personalNote.state.noteLocked, type: window.__personalNote.state.activeNoteType })))
  const stored = (await call('GET', `/api/notes/${cards.id}`)).body
  check('an edit in an unlocked secure note is saved (readable only through the unlocked app)', stored.content?.markdown?.includes('9090'), JSON.stringify(stored.content))
  const raw = fs.readdirSync(scratch).filter((name) => name.startsWith('verify.db')).map((name) => fs.readFileSync(path.join(scratch, name))).map((buffer) => buffer.toString('latin1')).join('')
  check('and the file holds neither the old words nor the new ones', !raw.includes('quokkaphrase') && !raw.includes('9090'))

  // ---- it locks when another note opens ----
  await select(plain.id)
  check('opening another note locks the secure notes and takes the pill away', !(await serverStatus()).unlocked && (await pill().count()) === 0 && (await page.locator('.secure-edge').count()) === 0)
  check('the other note opens as an ordinary note (no cover)', (await cover().count()) === 0 && (await pn(() => document.body.innerText)).includes('Milk'))

  // ---- it opens locked: the cover, no words anywhere ----
  puts.length = 0
  await select(cards.id)
  await cover().waitFor({ timeout: 10000 })
  check('a secure note opens locked, with its title and the passphrase field', (await cover().textContent()).includes('Cards') && (await cover().locator('input[name=passphrase]').count()) === 1)
  check('and no word of it is anywhere on the page', !(await bodyHasSecret()))
  check('the cover says it is a secure note and does not claim sharing protection off the Mac', /Secure note · locked/.test(await cover().textContent()))
  check('the title field cannot be edited while it is locked', await pn(() => document.querySelector('#note-title').readOnly))
  await shot('cover')
  await page.keyboard.type('stray typing')
  await page.mouse.click(600, 500)
  await page.waitForTimeout(2200)
  check('nothing is saved from a locked note (no PUT while the cover is up)', puts.length === 0, JSON.stringify(puts))
  check('the server still holds the old words', ((await call('POST', '/api/secure/unlock', { passphrase: PASSPHRASE })).body.unlocked === true) && (await call('GET', `/api/notes/${cards.id}`)).body.content.markdown.includes('9090'))
  await call('POST', '/api/secure/lock')

  // ---- search ----
  await page.keyboard.press('Control+k')
  await page.fill('#search-input', 'quokkaphrase')
  await page.waitForTimeout(800)
  check('search never finds a secure note by its words', (await page.locator('.search-result').count()) === 0)
  await page.fill('#search-input', 'Cards')
  await page.waitForTimeout(800)
  const hit = page.locator('.search-result.is-secure')
  check('search finds it by title, with the lock and no excerpt', (await hit.count()) === 1 && (await hit.locator('svg.lucide-lock').count()) === 1 && (await hit.locator('small').count()) === 0)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // ---- unlocking: wrong, then right ----
  await page.fill('.secure-cover input[name=passphrase]', 'not the passphrase')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => /Not opened/.test(document.querySelector('.secure-msg')?.textContent ?? ''), null, { timeout: 15000 })
  check('a wrong passphrase says "Not opened. Try again." and stays locked', (await cover().count()) === 1 && !(await serverStatus()).unlocked)
  await page.fill('.secure-cover input[name=passphrase]', PASSPHRASE)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.secure-pill', { timeout: 20000 })
  await page.waitForTimeout(800)
  check('the right passphrase opens it: the words are back and the cover is gone', (await cover().count()) === 0 && (await pn(() => document.body.innerText)).includes('9090'))
  await pn((id) => window.__personalNote.state.notes.find((n) => n.id === id)?.revision, cards.id)
  puts.length = 0
  await pn(() => document.querySelector('#page-host .cm-content').focus())
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' and more')
  await page.waitForTimeout(1500)
  const reread = (await call('GET', `/api/notes/${cards.id}`)).body
  check('after unlocking the note is reloaded before it is saved: an edit keeps all the words', reread.content?.markdown?.includes('quokkaphrase') && reread.content.markdown.includes('9090') && reread.content.markdown.includes('and more'), JSON.stringify(reread.content))

  // ---- auto-lock after the quiet time ----
  const started = Date.now()
  await cover().waitFor({ timeout: (QUIET_SECONDS + 12) * 1000 })
  const waited = (Date.now() - started) / 1000
  check(`it locks again by itself after the quiet time (${QUIET_SECONDS} s here), cover back, pill gone`, (await pill().count()) === 0 && !(await serverStatus()).unlocked && waited < QUIET_SECONDS + 4, String(waited))
  check('and the words left the page', !(await bodyHasSecret()))

  // ---- the Lock button ----
  await page.fill('.secure-cover input[name=passphrase]', PASSPHRASE)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.secure-pill', { timeout: 20000 })
  await page.waitForTimeout(500)
  await page.click('.secure-lock')
  await cover().waitFor({ timeout: 10000 })
  check('the Lock button locks it at once', (await pill().count()) === 0 && !(await serverStatus()).unlocked && !(await bodyHasSecret()))

  // ---- reload shows it locked, even with the keys still held on the server ----
  await call('POST', '/api/secure/unlock', { passphrase: PASSPHRASE })
  await page.reload()
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId && !window.__personalNote.state.loading, null, { timeout: 60000 })
  check('after a reload the secure notes are locked again', !(await serverStatus()).unlocked)
  await select(cards.id)
  check('and the note opens on the cover', (await cover().count()) === 1 && !(await bodyHasSecret()))

  // ---- the recovery key, and a passphrase for this computer ----
  await page.click('[data-use-key]')
  await page.fill('input[name=key]', 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => /doesn't match/.test(document.querySelector('.secure-msg')?.textContent ?? ''), null, { timeout: 15000 })
  check('a wrong recovery key says "That key doesn\'t match. Check the groups and try again."', (await cover().count()) === 1 && !(await serverStatus()).unlocked)
  await page.fill('input[name=key]', key.toLowerCase().replaceAll('-', ' '))
  await page.keyboard.press('Enter')
  await page.waitForSelector('.secure-sheet', { timeout: 20000 })
  check('after a recovery key unlock on Linux it asks for a passphrase for this computer', /Passphrase for this computer/.test(await page.locator('.secure-sheet h3').textContent()))
  const newPassphrase = 'a brand new passphrase'
  await page.fill('.secure-sheet input[name=passphrase]', newPassphrase)
  await page.fill('.secure-sheet input[name=again]', newPassphrase)
  await page.click('.secure-sheet .primary')
  await page.waitForSelector('.secure-pill', { timeout: 20000 })
  await page.waitForTimeout(500)
  check('and then opens the note', (await cover().count()) === 0 && (await pn(() => document.body.innerText)).includes('quokkaphrase'))
  await call('POST', '/api/secure/lock')
  check('the new passphrase now unlocks (the old one is replaced)', (await call('POST', '/api/secure/unlock', { passphrase: newPassphrase })).status === 200)

  // ---- back to ordinary ----
  await page.waitForSelector('.secure-pill')
  await page.click('#top-properties')
  await page.waitForTimeout(300)
  check('Make ordinary is offered while it is open', (await page.locator('#secure-note span').textContent()) === 'Make ordinary')
  await page.click('#secure-note')
  await page.waitForFunction((id) => !window.__personalNote.state.notes.find((n) => n.id === id)?.secure, cards.id, { timeout: 20000 })
  await page.waitForTimeout(500)
  check('Make ordinary takes the lock off: no pill, no lock in the list, readable again', (await pill().count()) === 0 && (await page.locator(`.note-list-item[data-note-id="${cards.id}"].is-secure`).count()) === 0 && (await call('GET', `/api/notes/${cards.id}`)).body.secure === false)
  const found = (await call('GET', '/api/search?q=quokkaphrase')).body
  check('and search finds its words again', found.length === 1)

  check('no errors on the page', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  fs.rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exitCode = failed ? 1 : 0
