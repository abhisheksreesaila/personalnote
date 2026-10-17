// F-077 New note keeps the words typed a moment before it (they were dropped while the old note was set aside), in the real app: Vite dev server on PN_VERIFY_PORT (default 4870) with a real API on the next port over a scratch
// database, headless Chromium, real keyboard and mouse. Run one at a time; it stops everything it starts and removes only its own scratch folder.
//   PN_VERIFY_PORT=4880 node scripts/verify-new-note.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4870)
const API_PORT = UI_PORT + 1
await assertPortsFree([UI_PORT, API_PORT])
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-omnibar-'))
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], { env: { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db') }, stdio: 'ignore' })
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

  const a = (await call('POST', '/api/notes', { title: 'Alpha', notebookId: null, noteType: 'page' })).body
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId && !window.__personalNote.state.loading, null, { timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.evaluate((id) => window.__personalNote.selectNote(id), a.id)
  await page.waitForFunction((id) => window.__personalNote.state.activeNoteId === id && !window.__personalNote.state.loading, a.id)
  await page.waitForTimeout(1500)
  // type into Alpha, then at once make a new note
  await page.locator('.ProseMirror, [contenteditable=true]').first().click()
  await page.keyboard.type('alpha words')
  await page.evaluate(() => { void window.__personalNote.createNote(undefined, 'page', 'Beta') }) // not awaited: the next action comes at once
  await page.waitForFunction(() => window.__personalNote.state.activeNoteId && window.__personalNote.state.notes.find((n) => n.id === window.__personalNote.state.activeNoteId)?.title === 'Beta' && !window.__personalNote.state.loading, null, { timeout: 15000 })
  await page.keyboard.type('beta words')
  await page.waitForFunction(() => !window.__personalNote.state.loading && !window.__personalNote.state.creatingNote, null, { timeout: 15000 })
  await page.waitForTimeout(3000)
  const stored = async (title) => { const n = (await call('GET', '/api/notes')).body.find((item) => item.title === title); return n ? (await call('GET', `/api/notes/${n.id}`)).body.content?.markdown : undefined }
  check('words typed just before New note are saved on the note they were typed in', (await stored('Alpha')) === 'alpha words', String(await stored('Alpha')))
  check('words typed once the new note is open land on the new note', (await stored('Beta')) === 'beta words', String(await stored('Beta')))
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch {}
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
