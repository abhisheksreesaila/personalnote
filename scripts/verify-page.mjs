// Milestone 1 page notes, in the real app: Vite dev server on port 4830 with a real API on 4831 over a scratch database, headless
// Chromium. Run one at a time; it stops everything it starts.
//   node scripts/verify-page.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

// PN_VERIFY_PORT moves both servers (UI on it, API on it + 1) so two runs can't collide.
const UI_PORT = basePort(4830)
const API_PORT = UI_PORT + 1
await assertPortsFree([UI_PORT, API_PORT])
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-page-'))
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], {
  env: { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db') }, stdio: 'ignore',
})
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
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

  // F-040: a page note; typing saves; reload brings it back
  await page.waitForFunction(() => !window.__personalNote.state.creatingNote) // (the first note of an empty workspace may still be on its way)
  await pn(() => window.__personalNote.createNote(undefined, 'page'))
  await page.waitForSelector('.page-host:not([hidden]) .cm-content', { timeout: 20000 })
  check('a page note opens', await pn(() => window.__personalNote.state.activeNoteType) === 'page')
  const pageId = await pn(() => window.__personalNote.state.activeNoteId)
  await page.click('.page-host .cm-content')
  await page.keyboard.type('# Lisbon\n\nThe harbour walk at dusk.')
  await page.waitForTimeout(1500)
  const stored = await (await fetch(`${API}/api/notes/${pageId}`)).json()
  check('typing saves the Markdown', stored.content.markdown === '# Lisbon\n\nThe harbour walk at dusk.', JSON.stringify(stored.content.markdown))
  await page.reload()
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await pn((id) => window.__personalNote.selectNote(id), pageId)
  await page.waitForSelector('.page-host:not([hidden]) .cm-content')
  check('after a reload the page shows the same text', (await page.textContent('.page-host .cm-content')).includes('The harbour walk at dusk.'))
  const hits = await (await fetch(`${API}/api/search?q=harbour`)).json()
  check('search finds the page', hits.some((hit) => hit.id === pageId))
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  // F-042: marks on words
  const stored2 = async () => (await (await fetch(`${API}/api/notes/${pageId}`)).json()).content
  const wordBox = (word) => pn((w) => {
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
  const drawingMode = await pn(() => document.querySelector('.page-host').classList.contains('page-drawing-mode'))
  await page.keyboard.press('Escape')
  const writing = await pn(() => !document.querySelector('.page-host').classList.contains('page-drawing-mode'))
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
  // F-043: drawings on empty space, shapes, text objects
  const content = await pn(() => { const r = document.querySelector('.page-host .cm-content').getBoundingClientRect(); return { x: r.left, y: r.bottom, w: r.width } })
  await drag([[content.x + 60, content.y + 80], [content.x + 120, content.y + 120], [content.x + 200, content.y + 100]])
  await page.waitForTimeout(400)
  const drawingBox = () => pn(() => { const d = document.querySelector('.page-host .page-drawing'); if (!d) return null; const r = d.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
  // Drawing near the bottom edge scrolls the page: bring the drawing to the middle and measure it again before each step.
  const freshBox = async () => { await pn(() => document.querySelector('.page-host .page-drawing')?.scrollIntoView({ block: 'center' })); await page.waitForTimeout(100); return drawingBox() }
  let box = await freshBox()
  check('a stroke below the text becomes a drawing of its own', Boolean(box && box.h > 40), JSON.stringify(box))
  await drag([[box.x + 250, box.y + 20], [box.x + 300, box.y + 40], [box.x + 340, box.y + 30]])
  await page.click('.page-toolbar [data-page-tool="rect"]')
  box = await freshBox()
  await drag([[box.x + 380, box.y + 10], [box.x + 440, box.y + 50], [box.x + 470, box.y + 60]])
  await page.click('.page-toolbar [data-page-tool="text"]')
  await page.click('.page-toolbar [data-text-size="xl"]')
  box = await freshBox()
  await page.mouse.click(box.x + 40, box.y + 50)
  await page.waitForSelector('.page-text-edit')
  await page.keyboard.type('Big idea')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1400)
  ink = (await stored2()).ink
  const d0 = ink.drawings[0]
  check('more strokes, a rectangle and a text object join the same drawing', ink.drawings.length === 1 && d0.strokes.length === 2 && d0.items.some((i) => i.kind === 'rect') && d0.items.some((i) => i.kind === 'text' && i.text === 'Big idea' && i.size === 'xl'), JSON.stringify(ink.drawings.map((d) => ({ s: d.strokes.length, i: d.items.map((x) => x.kind + ':' + (x.text ?? '')) }))))
  check('a new drawing is linked to no word', d0.link === null)
  // an empty text object adds nothing at all
  const drawingsBefore = (await stored2()).ink.drawings.length
  await page.click('.page-toolbar [data-page-tool="text"]')
  const blank = await pn(() => { const r = document.querySelector('.page-host .cm-content').getBoundingClientRect(); return { x: r.right - 40, y: Math.min(r.bottom + 40, window.innerHeight - 60) } })
  await page.mouse.click(blank.x, blank.y)
  await page.waitForSelector('.page-text-edit')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1300)
  check('a text object left empty adds no drawing', (await stored2()).ink.drawings.length === drawingsBefore && await pn(() => document.querySelectorAll('.page-host .page-drawing').length) === drawingsBefore)
  // F-044: link to a word, fold behind it, slide out
  await freshBox()
  await page.hover('.page-host .page-drawing')
  await page.click('.page-host .page-drawing [data-drawing-link]')
  harbour = await wordBox('harbour')
  await page.mouse.click(harbour.x + 5, harbour.y + harbour.h / 2)
  await page.waitForTimeout(900)
  ink = (await stored2()).ink
  check('Link to text then a click on a word links the drawing to that word', ink.drawings[0].link?.quote?.exact === 'harbour', JSON.stringify(ink.drawings[0].link))
  check('the linked word turns into a link', await pn(() => document.querySelector('.page-host .page-link-word')?.textContent) === 'harbour')
  await page.keyboard.press('Escape')
  check('Esc after finishing a text object goes back to Write', await pn(() => !document.querySelector('.page-host').classList.contains('page-drawing-mode')))
  const heights = []
  await page.click('.page-host .page-link-word')
  for (let i = 0; i < 6; i++) { heights.push(Math.round((await drawingBox()).h)); await page.waitForTimeout(90) }
  await page.waitForTimeout(500)
  heights.push(Math.round((await drawingBox()).h))
  check('clicking the word folds the drawing smoothly (height glides to 0)', heights[heights.length - 1] === 0 && heights.some((h) => h > 0 && h < heights[0]), heights.join(' '))
  await page.click('.page-host .page-link-word')
  await page.waitForTimeout(800)
  check('clicking it again slides the drawing back out', (await drawingBox()).h > 40)
  await page.click('.page-toolbar [data-fold-all]')
  await page.waitForTimeout(800)
  check('Fold all folds every linked drawing', (await drawingBox()).h === 0 && await pn(() => document.querySelector('[data-fold-all]').textContent) === 'Unfold all drawings')
  await page.waitForTimeout(1300)
  check('the fold is saved with the note', (await stored2()).ink.drawings[0].folded === true)
  await page.reload()
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await pn((id) => window.__personalNote.selectNote(id), pageId)
  await page.waitForSelector('.page-host:not([hidden]) .page-link-word')
  check('after a reload the drawing is still folded behind its word', (await drawingBox()).h === 0)
  harbour = await wordBox('harbour')
  await page.mouse.click(harbour.x + harbour.w + 40, harbour.y + harbour.h / 2)
  await page.keyboard.press('Home'); await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  const goneDrawing = await drawingBox()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await page.waitForTimeout(300)
  check('deleting the link word deletes its drawing; undo brings both back', goneDrawing === null && (await drawingBox()) !== null, JSON.stringify(goneDrawing))
  // F-045: an agent writes to the open page through the CLI
  const agent = (...args) => spawnSync(python, ['personal_note_cli.py', '--database', path.join(scratch, 'verify.db'), 'notes', ...args], { encoding: 'utf8' })
  await page.waitForTimeout(1500) // let the last save land
  let run = agent('write', String(pageId), '--text', '# Lisbon\n\nA new opening line.\n\nThen The harbour walk at dusk.')
  await page.waitForTimeout(3500) // the app polls for agent changes every two seconds
  check('an agent rewrite shows in the open page', (await page.textContent('.page-host .cm-content')).includes('A new opening line.'), run.stderr)
  check('marks on words that are still there follow them', await pn(() => document.querySelectorAll('.page-host g.page-mark').length) === 2 && await pn(() => !document.querySelector('.page-tray:not([hidden])')))
  run = agent('write', String(pageId), '--text', '# Lisbon\n\nA new opening line.\n\nWe walked at dusk.')
  await page.waitForTimeout(3500)
  check('ink whose words the agent removed waits in the loose-ink tray', await pn(() => document.querySelectorAll('.page-tray .page-loose').length) === 2, run.stderr)
  check('a drawing whose link word is gone is unlinked and shown, not hidden', await pn(() => { const d = document.querySelector('.page-host .page-drawing'); return Boolean(d && d.offsetHeight > 40 && !d.classList.contains('linked')) }))
  // typing and an agent append at the same time: both survive
  const end = await wordBox('dusk')
  await page.mouse.click(end.x + end.w + 2, end.y + end.h / 2)
  await page.keyboard.press('End')
  await page.keyboard.type(' Typed here.')
  run = agent('append', String(pageId), '--text', 'Agent paragraph.')
  await page.waitForTimeout(4500)
  const merged = await stored2()
  check('an agent append while typing keeps both the typing and the agent text', merged.markdown.includes('Typed here.') && merged.markdown.includes('Agent paragraph.') && (await page.textContent('.page-host .cm-content')).includes('Agent paragraph.'), JSON.stringify(merged.markdown) + run.stderr)
  if (process.env.PN_SHOT) { await page.click('.page-toolbar [data-fold-all]'); await page.waitForTimeout(900); await pn(() => document.querySelector('.page-host .page-drawing')?.scrollIntoView({ block: 'center' })); await page.mouse.move(5, 5); await page.waitForTimeout(800); await page.screenshot({ path: process.env.PN_SHOT.replace('.png', '-drawing.png') }) }
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
