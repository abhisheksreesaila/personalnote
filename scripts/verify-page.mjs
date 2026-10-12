// Milestone 1 page notes, in the real app: Vite dev server on port 4830 with a real API on 4831 over a scratch database, headless
// Chromium. Run one at a time; it stops everything it starts.
//   node scripts/verify-page.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-page-'))
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '4831'], {
  env: { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db') }, stdio: 'ignore',
})
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:4831/api/notebooks')).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const server = await createServer({ server: { port: 4830, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4831' } }, logLevel: 'error' })
let browser
try {
  await apiUp()
  await server.listen()
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:4830/notes')
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  const pn = (fn, arg) => page.evaluate(fn, arg)

  // F-040: New note is a page; typing saves; reload brings it back
  await pn(() => window.__personalNote.createNote())
  await page.waitForSelector('.page-host:not([hidden]) .cm-content', { timeout: 20000 })
  check('New note opens a page note', await pn(() => window.__personalNote.state.activeNoteType) === 'page')
  const pageId = await pn(() => window.__personalNote.state.activeNoteId)
  await page.click('.page-host .cm-content')
  await page.keyboard.type('# Lisbon\n\nThe harbour walk at dusk.')
  await page.waitForTimeout(1500)
  const stored = await (await fetch(`http://127.0.0.1:4831/api/notes/${pageId}`)).json()
  check('typing saves the Markdown', stored.content.markdown === '# Lisbon\n\nThe harbour walk at dusk.', JSON.stringify(stored.content.markdown))
  await page.reload()
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await pn((id) => window.__personalNote.selectNote(id), pageId)
  await page.waitForSelector('.page-host:not([hidden]) .cm-content')
  check('after a reload the page shows the same text', (await page.textContent('.page-host .cm-content')).includes('The harbour walk at dusk.'))
  const hits = await (await fetch('http://127.0.0.1:4831/api/search?q=harbour')).json()
  check('search finds the page', hits.some((hit) => hit.id === pageId))
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  if (process.env.PN_SHOT) { await page.keyboard.type('\n\nSome **bold** words, a list:\n\n- one\n- two\n\n## A second heading\n\nMore text to see how a long paragraph wraps across the column of the page, roomy and calm.'); await page.waitForTimeout(400); await page.screenshot({ path: process.env.PN_SHOT }) }
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
