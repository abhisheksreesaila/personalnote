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
  // F-042: marks on words
  const stored2 = async () => (await (await fetch(`http://127.0.0.1:4831/api/notes/${pageId}`)).json()).content
  const wordBox = (word) => pn((w) => {
    const view = document.querySelector('.page-host .cm-content').cmView?.view ?? null
    const range = document.createRange()
    const walker = document.createTreeWalker(document.querySelector('.page-host .cm-content'), NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf(w)
      if (at >= 0) { range.setStart(node, at); range.setEnd(node, at + w.length); const r = range.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
    }
    return null
  }, word)
  const drag = async (points, { alt = false } = {}) => {
    if (alt) await page.keyboard.down('Alt')
    await page.mouse.move(points[0][0], points[0][1]); await page.mouse.down()
    for (const [x, y] of points.slice(1)) await page.mouse.move(x, y)
    await page.mouse.up()
    if (alt) await page.keyboard.up('Alt')
    await page.waitForTimeout(150)
  }
  const ellipseAround = (box) => Array.from({ length: 30 }, (_, i) => { const th = (i / 28) * Math.PI * 2; return [box.x + box.w / 2 + Math.cos(th) * (box.w / 2 + 8), box.y + box.h / 2 + Math.sin(th) * (box.h / 2 + 4)] })
  let harbour = await wordBox('harbour')
  await drag(ellipseAround(harbour), { alt: true })
  await page.waitForTimeout(1300)
  let ink = (await stored2()).ink
  check('a circle drawn with Alt over a word becomes a mark anchored to that word', ink.marks.length === 1 && ink.marks[0].anchor.quote.exact === 'harbour', JSON.stringify(ink.marks.map((m) => m.anchor?.quote?.exact)))
  const before = await pn(() => document.querySelector('.page-host g.page-mark').getBoundingClientRect().left)
  await page.click('.page-host .cm-content')
  await pn(() => { const v = window.__pageView; return !!v })
  const lineStart = await wordBox('The harbour')
  await page.mouse.click(lineStart.x + 1, lineStart.y + lineStart.h / 2)
  await page.keyboard.press('Home')
  await page.keyboard.type('Then ')
  await page.waitForTimeout(300)
  const after = await pn(() => document.querySelector('.page-host g.page-mark').getBoundingClientRect().left)
  harbour = await wordBox('harbour')
  check('typing before the word moves the circle with it', after - before > 20 && Math.abs(after - (harbour.x - 8)) < 30, `${before} -> ${after}, word at ${harbour.x}`)
  // a stroke in the left margin, in Write mode, draws (no Alt) and follows its line
  const paperBox = await pn(() => { const r = document.querySelector('.page-host .page-paper').getBoundingClientRect(); return { x: r.left, y: r.top } })
  await drag([[paperBox.x + 50, harbour.y], [paperBox.x + 60, harbour.y + 10], [paperBox.x + 70, harbour.y + 20]])
  await page.waitForTimeout(1300)
  ink = (await stored2()).ink
  check('a stroke in the margin in Write mode is a margin mark', ink.marks.length === 2 && ink.marks[1].margin === true, JSON.stringify(ink.marks.map((m) => m.margin)))
  // the pen tool switches to Draw; Esc goes back to Write
  await page.click('.page-toolbar [data-page-tool="red"]')
  const drawingMode = await pn(() => document.querySelector('.page-host').classList.contains('page-drawing'))
  await page.keyboard.press('Escape')
  const writing = await pn(() => !document.querySelector('.page-host').classList.contains('page-drawing'))
  check('picking a pen switches to Draw and Esc returns to Write', drawingMode && writing)
  // deleting the line deletes its marks; undo brings both back
  const count = () => pn(() => document.querySelectorAll('.page-host g.page-mark').length)
  await page.mouse.click(harbour.x + 2, harbour.y + harbour.h / 2)
  await page.keyboard.press('Home'); await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  const gone = await count()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await page.waitForTimeout(300)
  check('deleting the words deletes their marks, and undo brings both back', gone === 0 && await count() === 2, `after delete ${gone}, after undo ${await count()}`)
  await page.waitForTimeout(1300)
  await page.reload()
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await pn((id) => window.__personalNote.selectNote(id), pageId)
  await page.waitForSelector('.page-host:not([hidden]) .cm-content')
  await page.waitForTimeout(500)
  check('marks come back after a reload', await count() === 2, String(await count()))
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
