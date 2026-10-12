// F-048 Markdown text on the canvas, in the real app: Vite dev server on PN_VERIFY_PORT (default 4840) with a real API on the next port
// over a scratch database, headless Chromium. Run one at a time; it stops everything it starts.
//   node scripts/verify-markdown-text.mjs          (PN_SHOT=/path/shot.png also saves a picture)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const UI_PORT = Number(process.env.PN_VERIFY_PORT || 4840)
const API_PORT = UI_PORT + 1
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-md-'))
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], {
  env: { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db') }, stdio: 'ignore',
})
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
const SOURCE = '# Lisbon trip\nThe **harbour** walk at *dusk*, with `code` and ~~old~~ [a link](https://e.com).\n- bread\n- [x] wine\n> a quiet quote'
let browser
try {
  await apiUp()
  await server.listen()
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  const pn = (fn, arg) => page.evaluate(fn, arg)

  await pn(() => window.__personalNote.createNote())
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 30000 })
  await page.waitForTimeout(500)
  check('New note opens a canvas with the toolbar, pages and zoom', await pn(() => window.__personalNote.state.activeNoteType === 'canvas'
    && !document.querySelector('#dock-canvas').hidden && !document.querySelector('#page-minimap').hidden && !document.querySelector('#zoom-control').hidden))
  const noteId = await pn(() => window.__personalNote.state.activeNoteId)

  // Text tool, a click near the top-left of the first page, Markdown typed, then Escape ends the edit.
  await pn(() => { window.__personalNote.leaferCanvas().setView({ x: 120, y: 40, scale: 1 }); window.__personalNote.setTool('text') })
  const host = await page.locator('#leafer-host').boundingBox()
  // The bold face loads on first use; a size measured before it arrives is drawn right once it does, and stored right at the next edit.
  await pn(() => Promise.all(['400 24px "Geist Mono"', '600 24px "Geist Mono"'].map((spec) => document.fonts.load(spec, 'Ab'))))
  await page.mouse.click(host.x + 120 + 80, host.y + 40 + 90)
  await page.waitForTimeout(200)
  await page.keyboard.insertText(SOURCE)
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  const doc = await pn(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))
  const text = doc.objects.find((object) => object.type === 'text')
  check('a new text is Markdown, kept exactly as typed', text?.format === 'markdown' && text.content === SOURCE, JSON.stringify(text))
  check('it wraps at the right margin of its page', text?.mode === 'box' && Math.abs(text.geometry.x + text.geometry.width - (860 - 56)) < 2, JSON.stringify(text?.geometry))
  const info = await pn((id) => window.__personalNote.leaferCanvas().markdownInfo(id), text.id)
  const piece = (words) => info.pieces.find((p) => p.text === words)
  check('the heading is drawn bigger and bold, without its #', piece('Lisbon trip')?.fontSize > piece('The')?.fontSize && piece('Lisbon trip')?.fontWeight === '600' && !info.pieces.some((p) => p.text.includes('#')), JSON.stringify(info.pieces.slice(0, 3)))
  check('bold, italic, code, strikethrough and links are styled and their marks hidden', piece('harbour')?.fontWeight === '600' && piece('dusk')?.italic && /mono/.test(piece('code')?.fontFamily ?? '') && piece('old')?.decoration === 'delete' && piece('a link')?.decoration === 'under' && !info.pieces.some((p) => /\*\*|~~|\]\(/.test(p.text)), JSON.stringify(info.pieces))
  check('list bullets, a ticked box, a quote bar and code paper are drawn', ['dot', 'check', 'bar', 'paper'].every((kind) => info.shapes.includes(kind)), JSON.stringify(info.shapes))
  check('the text is shown again after editing, every piece and shape drawn', info.visible && info.drawn >= info.pieces.length + info.shapes.length, JSON.stringify([info.visible, info.drawn, info.pieces.length, info.shapes.length]))
  check('its stored height is the laid-out height', Math.abs(text.geometry.height - info.height) < 1, `${text.geometry.height} vs ${info.height}`)

  // Saved and reloaded
  const stored = await (await fetch(`${API}/api/notes/${noteId}`)).json()
  const node = stored.content.nodes.find((n) => n.type === 'text')
  check('saved as a JSON Canvas text node whose text is the Markdown, format in pn', node?.text === SOURCE && node?.pn?.format === 'markdown', JSON.stringify(node))
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(800)
  const again = await pn((id) => window.__personalNote.leaferCanvas().markdownInfo(id), text.id)
  check('after a reload it is drawn the same', again && again.pieces.map((p) => p.text).join('|') === info.pieces.map((p) => p.text).join('|'))

  // Pages grow as the writing goes down the page, and fold back when it is removed
  await pn(() => window.__personalNote.setTool('text'))
  await page.mouse.click(host.x + 120 + 100, host.y + 40 + 60)
  await page.waitForTimeout(200)
  const rowsBefore = await pn(() => window.__personalNote.state.pages.rows)
  for (let i = 0; i < 6; i += 1) { await page.keyboard.insertText(`Line ${i} of a long day of writing.\n`.repeat(8)); await page.waitForTimeout(80) }
  await page.waitForTimeout(400)
  const rowsTyping = await pn(() => window.__personalNote.state.pages.rows)
  check('writing past the bottom of the page grows the pages', rowsTyping > rowsBefore, `${rowsBefore} -> ${rowsTyping}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z')
  await page.waitForTimeout(800)
  check('undo takes the writing away and the page folds back', await pn(() => window.__personalNote.state.pages.rows) === rowsBefore)

  // An older plain text looks as before: no Markdown styling
  const plainId = 'res_plainplainplainplainplainplain01'
  await pn((id) => window.__personalNote.leaferEdits.apply?.({ label: 'test', changes: [{ id, before: null, after: { id, type: 'text', mode: 'point', z: 90, content: '# not a heading', style: { fontSize: 24 }, geometry: { x: 120, y: 900, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 } } }] }), plainId)
  const plain = await pn((id) => window.__personalNote.leaferCanvas().textInfo(id), plainId)
  if (plain) check('an older plain text keeps its # as typed', plain.rows.join('') === '# not a heading', JSON.stringify(plain))

  // Markdown export carries the Markdown
  const zip = path.join(scratch, 'export.zip')
  fs.writeFileSync(zip, Buffer.from(await (await fetch(`${API}/api/export/markdown`)).arrayBuffer()))
  const exported = spawnSync('unzip', ['-p', zip], { encoding: 'utf8' }).stdout ?? ''
  check('Markdown export writes the Markdown as typed', exported.includes('# Lisbon trip') && exported.includes('**harbour**'), exported.slice(0, 300))

  if (process.env.PN_SHOT) { await pn(() => window.__personalNote.leaferCanvas().setView({ x: 120, y: 40, scale: 1 })); await page.waitForTimeout(600); await page.screenshot({ path: process.env.PN_SHOT }) }
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
