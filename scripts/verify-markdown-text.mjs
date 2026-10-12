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

  // F-049: editing a Markdown text keeps it formatted, and the words do not move when the editor opens
  await pn(() => window.__personalNote.leaferCanvas().setView({ x: 120, y: 40, scale: 1 }))
  await page.waitForTimeout(1200) // (the editor loads a moment after the canvas)
  const screenOf = (word) => ({ x: host.x + 120 + text.geometry.x + word.x, y: host.y + 40 + text.geometry.y + word.y, w: word.width, h: word.height })
  const drawnWord = (exact) => { const at = SOURCE.indexOf(exact); return screenOf(again.words.find((word) => word.from === at)) }
  const walk = drawnWord('walk')
  await pn(() => window.__personalNote.setTool('select'))
  await page.mouse.dblclick(walk.x + walk.w / 2, walk.y + walk.h / 2)
  await page.waitForSelector('.md-editor .cm-content', { timeout: 5000 }).catch(() => {})
  check('a Markdown text opens in the formatting editor', await pn(() => Boolean(document.querySelector('.md-editor .cm-content'))))
  const lines = await pn(() => [...document.querySelectorAll('.md-editor .cm-line')].map((line) => line.textContent))
  check('lines without the caret hide their Markdown marks; the caret line shows them', lines[0] === 'Lisbon trip' && lines[1].includes('**harbour**') && lines[2] === 'bread', JSON.stringify(lines))
  const edited = await pn((exact) => {
    const walker = document.createTreeWalker(document.querySelector('.md-editor .cm-content'), NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(exact)
      if (at === -1) continue
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + exact.length)
      const r = range.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }
    }
    return null
  }, 'Lisbon')
  const lisbon = drawnWord('Lisbon')
  // (the caret's own line shows its marks and can take more room, moving the lines below it, as any live Markdown editor does)
  check('a word in the editor is where the canvas drew it (within 1 px)', edited && Math.abs(edited.x - lisbon.x) <= 1 && Math.abs(edited.y - lisbon.y) <= 1 && Math.abs(edited.w - lisbon.w) <= 1, JSON.stringify({ edited, lisbon }))
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n## New part\nsome *more*')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: '世界', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '世界' })
  await page.waitForTimeout(200)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(900)
  const typed = (await pn(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))).objects.find((object) => object.id === text.id)
  check('what is typed is kept as Markdown, composed words once', typed.content === `${SOURCE}\n## New part\nsome *more*世界`, JSON.stringify(typed.content))
  const afterEdit = await pn((id) => window.__personalNote.leaferCanvas().markdownInfo(id), text.id)
  check('the new heading is drawn as a heading once the edit ends', afterEdit.pieces.some((p) => p.text === 'New part' && p.fontWeight === '600' && p.fontSize > 24) && afterEdit.visible, JSON.stringify(afterEdit.pieces.slice(-3)))
  check('the editor is gone', await pn(() => !document.querySelector('.md-editor')))
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(600)
  check('one undo takes the whole typing session back', (await pn(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))).objects.find((object) => object.id === text.id)?.content === SOURCE)
  if (process.env.PN_SHOT) { await page.mouse.dblclick(walk.x + walk.w / 2, walk.y + walk.h / 2); await page.waitForTimeout(400); await page.screenshot({ path: process.env.PN_SHOT.replace('.png', '-editing.png') }); await page.keyboard.press('Escape'); await page.waitForTimeout(400) }

  // F-050: ink on words
  const objectsNow = async () => (await pn(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))).objects
  const textNow = async () => (await objectsNow()).find((object) => object.id === text.id)
  const infoNow = () => pn((id) => window.__personalNote.leaferCanvas().markdownInfo(id), text.id)
  const stroke = async (points) => {
    await page.mouse.move(points[0].x, points[0].y)
    await page.mouse.down()
    for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 3 })
    await page.mouse.up()
    await page.waitForTimeout(250)
  }
  const ring = (box) => Array.from({ length: 25 }, (_, i) => ({ x: box.x + box.w / 2 + Math.cos((i / 24) * Math.PI * 2) * (box.w / 2 + 8), y: box.y + box.h / 2 + Math.sin((i / 24) * Math.PI * 2) * (box.h / 2 + 6) }))
  let info2 = await infoNow()
  const wordBox = (info, exact) => { const content = info.source; const at = content.indexOf(exact); return screenOf(info.words.find((word) => word.from === at)) }
  await pn(() => window.__personalNote.setTool('pen'))
  const inkBefore = (await objectsNow()).filter((object) => object.type === 'ink').length
  await stroke(ring(wordBox(info2, 'harbour')))
  let marked = await textNow()
  check('a pen stroke around a word becomes a mark of that word, not loose ink', marked.marks?.length === 1 && marked.marks[0].anchor.quote.exact === 'harbour' && (await objectsNow()).filter((object) => object.type === 'ink').length === inkBefore, JSON.stringify(marked.marks?.map((mark) => mark.anchor)))
  await stroke([{ x: host.x + 300, y: host.y + 700 }, { x: host.x + 380, y: host.y + 720 }, { x: host.x + 420, y: host.y + 690 }])
  check('a stroke away from the words stays ordinary ink', (await objectsNow()).filter((object) => object.type === 'ink').length === inkBefore + 1)
  info2 = await infoNow()
  const markBefore = info2.placed[0]
  // typing before the word moves the mark with it
  await pn(() => window.__personalNote.setTool('select'))
  const the = wordBox(info2, 'The')
  await page.mouse.dblclick(the.x + 2, the.y + the.h / 2)
  await page.waitForTimeout(300)
  const editingMark = async () => pn(() => { const path = document.querySelector('.md-editor .md-marks path'); if (!path) return null; const r = path.getBoundingClientRect(); return { x: r.left, y: r.top } })
  // (the caret's line shows its ** now, so the word, and its mark with it, sit a little further right than on the canvas)
  const harbourDrawn = info2.words.find((word) => word.from === info2.source.indexOf('harbour'))
  const harbourEdited = await pn(() => { const walker = document.createTreeWalker(document.querySelector('.md-editor .cm-content'), NodeFilter.SHOW_TEXT); for (let node = walker.nextNode(); node; node = walker.nextNode()) { const at = node.data.indexOf('harbour'); if (at === -1) continue; const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 7); const r = range.getBoundingClientRect(); return { x: r.left, y: r.top } } return null })
  await page.waitForTimeout(100)
  const shown = await editingMark()
  const expected = harbourEdited && { x: harbourEdited.x + markBefore.x - harbourDrawn.x, y: harbourEdited.y + markBefore.y - harbourDrawn.y }
  check('while the text is edited its marks stay on the words', shown && expected && Math.abs(shown.x - expected.x) < 4 && Math.abs(shown.y - expected.y) < 4, JSON.stringify([shown, expected]))
  await page.keyboard.press('Home')
  await page.keyboard.type('Then ')
  await page.waitForTimeout(100)
  const moved = await editingMark()
  check('and move with their word as it is typed before', moved && moved.x > shown.x + 30, JSON.stringify([shown, moved]))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(900)
  info2 = await infoNow()
  marked = await textNow()
  check('typing before the word moves its mark with it', marked.marks?.[0]?.anchor.quote.exact === 'harbour' && info2.placed[0].x > markBefore.x + 30 && Math.abs(info2.placed[0].y - markBefore.y) < 1, JSON.stringify([markBefore, info2.placed[0]]))
  // a narrower box rewraps the words, and the mark goes where its word went
  // deleting the word deletes the mark; undo brings both back
  const harbour = wordBox(info2, 'harbour')
  await page.mouse.dblclick(harbour.x + harbour.w / 2, harbour.y + harbour.h / 2)
  await page.waitForTimeout(300)
  const at = marked.content.indexOf('**harbour**')
  await pn(([from, to]) => document.querySelector('.leafer-text-editor').setSelectionRange(from, to), [at, at + '**harbour** '.length])
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(900)
  check('deleting the word deletes its mark', (await textNow()).marks?.length === 0, JSON.stringify((await textNow()).content))
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(600)
  check('undo brings the word and its mark back', (await textNow()).marks?.length === 1)
  // the eraser takes a mark in one step
  info2 = await infoNow()
  await pn(() => window.__personalNote.setTool('eraser'))
  const placed = info2.placed[0]
  await stroke([{ x: host.x + 120 + text.geometry.x + placed.x - 10, y: host.y + 40 + text.geometry.y + placed.y + 10 }, { x: host.x + 120 + text.geometry.x + placed.x + 60, y: host.y + 40 + text.geometry.y + placed.y + 10 }, { x: host.x + 120 + text.geometry.x + placed.x + 130, y: host.y + 40 + text.geometry.y + placed.y + 30 }])
  check('the eraser removes the mark', (await textNow()).marks?.length === 0)
  await pn(() => window.__personalNote.setTool('select'))
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(600)
  check('and one undo puts it back', (await textNow()).marks?.length === 1)
  await page.waitForTimeout(1500)
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(800)
  check('marks are saved and come back after a reload', (await infoNow())?.marks === 1)
  if (process.env.PN_SHOT) { await pn(() => window.__personalNote.leaferCanvas().setView({ x: 120, y: 40, scale: 1 })); await page.waitForTimeout(500); await page.screenshot({ path: process.env.PN_SHOT.replace('.png', '-marks.png') }) }

  // F-051: link a drawing to a word, fold it into the word and open it again
  await pn(() => window.__personalNote.leaferCanvas().setView({ x: 120, y: 40, scale: 1 }))
  await page.waitForTimeout(400)
  await pn(() => window.__personalNote.setTool('select'))
  const drawing = (await objectsNow()).find((object) => object.type === 'ink')
  const linkedNow = async () => (await objectsNow()).find((object) => object.id === drawing.id)
  await pn((id) => window.__personalNote.leaferCanvas().select([id]), drawing.id)
  await page.waitForTimeout(200)
  await page.click('[data-selection-action="link"]')
  info2 = await infoNow()
  const quietWord = wordBox(info2, 'quiet')
  await page.mouse.click(quietWord.x + quietWord.w / 2, quietWord.y + quietWord.h / 2)
  await page.waitForTimeout(400)
  let link = (await linkedNow()).link
  check('Link to words, then a click on a word, links the drawing to it', link?.textId === text.id && link.quote.exact === 'quiet', JSON.stringify(link))
  info2 = await infoNow()
  check('the word is drawn teal', info2.pieces.find((p) => p.text === 'quiet')?.color === '#0f8b8d', JSON.stringify(info2.pieces.find((p) => p.text.includes('quiet'))))
  check('the top bar offers Fold all', await pn(() => !document.querySelector('#fold-all').hidden))
  await pn(() => window.__personalNote.leaferCanvas().clearSelection())
  await page.mouse.click(quietWord.x + quietWord.w / 2, quietWord.y + quietWord.h / 2)
  await page.waitForTimeout(300)
  await page.waitForTimeout(700)
  check('a click on the teal word folds the drawing away', (await linkedNow()).folded === true)
  if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', '-folded.png') })
  await page.mouse.click(quietWord.x + quietWord.w / 2, quietWord.y + quietWord.h / 2)
  await page.waitForTimeout(150)
  if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', '-opening.png') })
  await page.waitForTimeout(800)
  check('a second click opens it again', (await linkedNow()).folded === false)
  await pn(() => window.__personalNote.setTool('text'))
  await page.mouse.click(quietWord.x + quietWord.w / 2, quietWord.y + quietWord.h / 2)
  await page.waitForTimeout(900)
  check('with the Text tool too, a click on the teal word folds it (and opens no editor)', (await linkedNow()).folded === true && await pn(() => !window.__personalNote.leaferCanvas().isEditingText()))
  await page.mouse.click(quietWord.x + quietWord.w / 2, quietWord.y + quietWord.h / 2)
  await page.waitForTimeout(900)
  await pn(() => window.__personalNote.setTool('select'))
  await page.click('#fold-all')
  await page.waitForTimeout(900)
  check('Fold all folds every linked object', (await linkedNow()).folded === true)
  await page.click('#fold-all')
  await page.waitForTimeout(900)
  check('and the same button opens them all', (await linkedNow()).folded === false)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(600)
  check('undo folds it back (each fold is one step)', (await linkedNow()).folded === true)
  await page.waitForTimeout(1500)
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(800)
  check('the fold is saved with the note', (await linkedNow()).folded === true && (await linkedNow()).link?.quote.exact === 'quiet')
  // deleting the word unlinks the drawing and shows it
  await pn(() => window.__personalNote.leaferCanvas().setView({ x: 120, y: 40, scale: 1 }))
  await page.waitForTimeout(300)
  info2 = await infoNow()
  const wine = wordBox(info2, 'wine')
  await page.mouse.dblclick(wine.x + wine.w / 2, wine.y + wine.h / 2)
  await page.waitForTimeout(300)
  const content = (await textNow()).content
  await pn(([from, to]) => document.querySelector('.leafer-text-editor').setSelectionRange(from, to), [content.indexOf('quiet'), content.indexOf('quiet') + 'quiet '.length])
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(900)
  const orphan = await linkedNow()
  check('deleting the link word unlinks the drawing and shows it', !orphan.link && orphan.folded === false, JSON.stringify([orphan.link, orphan.folded]))
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(600)
  check('undo brings the word, the link and the fold back', (await linkedNow()).link?.quote.exact === 'quiet' && (await linkedNow()).folded === true)

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

  // An older plain text (no format) looks as before: its # stays as typed, no Markdown styling
  const plainNote = await (await fetch(`${API}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Plain', notebookId: (await (await fetch(`${API}/api/notebooks`)).json())[0].id, noteType: 'canvas' }) })).json()
  const plainGeometry = { x: 120, y: 200, width: 400, height: 60, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
  const plainSaved = await fetch(`${API}/api/notes/${plainNote.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Plain', notebookId: plainNote.notebookId, revision: plainNote.revision, pageState: { columns: 1, rows: 1 }, content: { nodes: [{ id: 'res_plain', type: 'text', x: 120, y: 200, width: 400, height: 60, text: '# not a heading **x**', pn: { type: 'text', mode: 'box', z: 0, geometry: plainGeometry, style: { fontSize: 24 } } }], edges: [] } }) })
  await pn(async (id) => { await window.__personalNote.refreshWorkspaceLists(); await window.__personalNote.selectNote(id) }, plainNote.id)
  await page.waitForTimeout(1500)
  const plain = await pn(() => window.__personalNote.leaferCanvas().textInfo('res_plain'))
  check('an older plain text keeps its # and ** as typed', plainSaved.ok && plain && !plain.markdown && plain.rows.join('') === '# not a heading **x**', JSON.stringify(plain))
  await pn(async (id) => window.__personalNote.selectNote(id), noteId)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 30000 })
  await page.waitForTimeout(800)

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
