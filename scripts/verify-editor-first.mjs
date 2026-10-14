// F-059 editor first, in the real app: Vite dev server on PN_VERIFY_PORT (default 4850) with a real API on the next port over a scratch
// database, headless Chromium. Run one at a time; it stops everything it starts.
//   node scripts/verify-editor-first.mjs          (PN_SHOT=/path/shot.png also saves pictures)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const UI_PORT = Number(process.env.PN_VERIFY_PORT || 4850)
const API_PORT = UI_PORT + 1
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-first-'))
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
  await page.waitForFunction(() => !window.__personalNote.state.creatingNote)
  const pn = (fn, arg) => page.evaluate(fn, arg)
  const scale = () => pn(() => window.__personalNote.leaferCanvas().view().scale)
  const editing = () => pn(() => Boolean(document.querySelector('.md-editor .cm-content')) && document.activeElement === document.querySelector('.md-editor .cm-content'))
  const quiet = () => pn(() => ({ quiet: document.querySelector('.app-shell').classList.contains('writing-quiet'), map: getComputedStyle(document.querySelector('#page-minimap')).opacity }))
  const objects = async () => (await pn(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))).objects
  const shot = async (name) => { if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${name}.png`) }) }

  // A new note opens like a document: 100%, the caret in the formatting editor, the page map and zoom quiet
  await pn(() => window.__personalNote.createNote())
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('.md-editor .cm-content'), null, { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(600)
  check('a new note opens at 100% with the caret ready in the formatting editor', (await scale()) === 1 && (await editing()), JSON.stringify([await scale(), await editing()]))
  const q = await quiet()
  check('the page map and zoom are quiet while writing', q.quiet && q.map === '0', JSON.stringify(q))
  await shot('open')
  await page.keyboard.type('# Trip\nThe harbour walk at dusk.')
  await page.waitForTimeout(1200)
  const written = (await objects()).find((object) => object.type === 'text')
  check('what is typed straight away is Markdown text at the top of the first page', written?.format === 'markdown' && written.content === '# Trip\nThe harbour walk at dusk.' && written.geometry.x === 80 && written.geometry.y === 80, JSON.stringify(written))

  // The pen stays at 100% for marks on words; its first drawing on the page opens the page up; Esc comes back to writing at 100%
  await page.click('[data-tool="pen"]')
  await page.waitForTimeout(500)
  check('picking the pen keeps the writing at 100%', (await scale()) === 1, String(await scale()))
  const host = await page.locator('#leafer-host').boundingBox()
  const stroke = async (points) => { await page.mouse.move(points[0].x, points[0].y); await page.mouse.down(); for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 3 }); await page.mouse.up(); await page.waitForTimeout(300) }
  const info = await pn((id) => window.__personalNote.leaferCanvas().markdownInfo(id), written.id)
  const view = await pn(() => window.__personalNote.leaferCanvas().view())
  const word = info.words.find((w) => info.source.slice(w.from, w.to) === 'harbour')
  const under = { x: host.x + view.x + (written.geometry.x + word.x) * view.scale, y: host.y + view.y + (written.geometry.y + word.y + word.height + 6) * view.scale }
  await stroke(Array.from({ length: 9 }, (_, i) => ({ x: under.x + (word.width * view.scale) * i / 8, y: under.y })))
  await page.waitForTimeout(500)
  check('underlining a word stays at 100% (a mark, not a drawing)', (await scale()) === 1 && ((await objects()).find((o) => o.id === written.id)?.marks?.length ?? 0) === 1, String(await scale()))
  await stroke([{ x: host.x + 500, y: host.y + 600 }, { x: host.x + 600, y: host.y + 660 }, { x: host.x + 560, y: host.y + 720 }])
  await page.waitForTimeout(700)
  const drawingScale = await scale()
  check('the first drawing on the page zooms out to show the whole page', drawingScale < 0.9 && drawingScale * 1080 <= 900, String(drawingScale))
  check('and the page map and zoom are back', !(await quiet()).quiet)
  await shot('drawing')
  await pn(() => document.activeElement?.blur())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  check('Esc goes back to writing at 100%', (await scale()) === 1 && (await pn(() => window.__personalNote.state.tool)) === 'text', JSON.stringify([await scale(), await pn(() => window.__personalNote.state.tool)]))

  // Picking a shape (a whiteboard tool) opens the page up at once; opening a text then comes back to 100%
  await pn(() => window.__personalNote.setTool('shape'))
  await page.waitForTimeout(700)
  await pn(() => window.__personalNote.setTool('select'))
  const zoomedOut = await scale()
  check('picking the shape tool zooms out to show the whole page', zoomedOut < 0.9, String(zoomedOut))
  await pn((id) => window.__personalNote.leaferCanvas().editText(id), written.id)
  await page.waitForTimeout(700)
  check('a text opened while zoomed out comes back to 100%', zoomedOut < 0.9 && (await scale()) === 1, JSON.stringify([zoomedOut, await scale()]))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)

  // Opening the note again: 100% at its writing, the caret at the end of the words
  const noteId = await pn(() => window.__personalNote.state.activeNoteId)
  await pn(() => window.__personalNote.createNote())
  await page.waitForTimeout(1500)
  await pn((id) => window.__personalNote.selectNote(id), noteId)
  await page.waitForFunction(() => document.querySelector('.md-editor .cm-content'), null, { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(800)
  const caret = await pn(() => { const c = document.querySelector('.md-editor .cm-content'); return c && [c.selectionStart, c.value.length] })
  check('a note with writing opens at 100% with the caret at the end of its words', (await scale()) === 1 && caret && caret[0] === caret[1] && caret[1] > 0, JSON.stringify([await scale(), caret]))
  const visible = await pn((id) => { const s = window.__personalNote.leaferCanvas(); const v = s.view(); const t = window.__personalNote.leaferEdits.doc.objects.find((o) => o.id === id); return v.y + t.geometry.y * v.scale }, written.id)
  check('its writing sits just under the top bar', visible > 100 && visible < 200, String(visible))

  // A note of drawings opens as before (the page overview, no caret)
  const notebook = (await (await fetch(`${API}/api/notebooks`)).json())[0]
  const drawn = await (await fetch(`${API}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Sketch', notebookId: notebook.id, noteType: 'canvas' }) })).json()
  const geometry = { x: 120, y: 200, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
  await fetch(`${API}/api/notes/${drawn.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Sketch', notebookId: notebook.id, revision: drawn.revision, pageState: { columns: 1, rows: 1 }, content: { nodes: [{ id: 'res_box', type: 'file', x: 120, y: 200, width: 200, height: 120, file: '', pn: { type: 'shape', kind: 'rect', z: 0, geometry, fill: '#ffd60a' } }], edges: [] } }) })
  await pn(async (id) => { await window.__personalNote.refreshWorkspaceLists(); await window.__personalNote.selectNote(id) }, drawn.id)
  await page.waitForTimeout(1800)
  check('a note of drawings opens as before: the whole page, no caret', (await scale()) < 0.9 && !(await pn(() => Boolean(document.querySelector('.md-editor')))), JSON.stringify([await scale()]))
  // Back on the writing note: the pen, then drawing zoomed in stays zoomed in; pen then shape opens the page; placing a sticky stays put
  await pn((id) => window.__personalNote.selectNote(id), noteId)
  await page.waitForFunction(() => document.querySelector('.md-editor .cm-content'), null, { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(800)
  await pn(() => document.activeElement?.blur())
  await page.click('[data-tool="pen"]')
  await page.waitForTimeout(300)
  await stroke([{ x: host.x + 520, y: host.y + 600 }, { x: host.x + 620, y: host.y + 640 }, { x: host.x + 580, y: host.y + 700 }])
  await page.waitForTimeout(700)
  const opened = await scale()
  await page.click('#zoom-value') // back to 100% by hand, to draw a detail
  await page.waitForTimeout(500)
  await stroke([{ x: host.x + 540, y: host.y + 420 }, { x: host.x + 600, y: host.y + 450 }, { x: host.x + 560, y: host.y + 480 }])
  await page.waitForTimeout(700)
  check('once the page is open, drawing zoomed in stays zoomed in', opened < 0.9 && (await scale()) === 1, JSON.stringify([opened, await scale()]))
  await page.click('[data-tool="shape"]')
  await page.waitForTimeout(700)
  const shapeView = await scale()
  check('the pen, then the shape tool from the dock opens the page up', shapeView < 0.9, String(shapeView))
  await page.click('[data-tool="sticky"]')
  await page.waitForTimeout(400)
  await page.mouse.click(host.x + 700, host.y + 500)
  await page.waitForTimeout(800)
  check('placing a sticky leaves the page open (no zoom back in)', Math.abs((await scale()) - shapeView) < 0.01 && (await objects()).some((o) => o.type === 'sticky'), JSON.stringify([shapeView, await scale()]))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // A picture dropped while the writing is merely open goes on the page
  await pn((id) => window.__personalNote.selectNote(id), noteId)
  await page.waitForFunction(() => window.__personalNote.leaferCanvas().isEditingText(), null, { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(1800)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await pn(({ data, at }) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'dot.png', { type: 'image/png' }))
    const target = document.querySelector('.md-editor .cm-content') ?? document.querySelector('.workspace')
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }))
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }))
  }, { data: png, at: { x: host.x + 400, y: host.y + 300 } })
  await page.waitForFunction(() => window.__personalNote.leaferEdits.doc.objects.some((o) => o.type === 'image'), null, { timeout: 8000 }).catch(() => {})
  check('a picture dropped on the open writing goes on the page (not into the words)', (await objects()).some((o) => o.type === 'image') && !(await objects()).some((o) => o.type === 'text' && /dot\.png|PNG/.test(o.content ?? '')))

  // F-069: text wraps at the page edge while it is typed, exactly where it wraps once the typing stops (and after a reload), the pages do
  // not grow sideways, and a faint hairline marks the wrap edge only while the words are written.
  const wrapProbe = () => pn(() => {
    const content = document.querySelector('.md-editor .cm-content')
    const holder = document.querySelector('.md-editor')
    if (!content || !holder) return null
    const edge = holder.getBoundingClientRect().right
    const rows = []
    let top = null
    let current = []
    let inkRight = 0
    const range = document.createRange()
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let i = 0; i < node.data.length; i += 1) {
        range.setStart(node, i); range.setEnd(node, i + 1)
        const box = range.getBoundingClientRect()
        if (!box.width && node.data[i] !== ' ') continue
        if (top !== null && Math.abs(box.top - top) > 4) { rows.push(current.join('')); current = [] }
        top = box.top
        current.push(node.data[i])
        if (node.data[i] !== ' ') inkRight = Math.max(inkRight, box.right)
      }
    }
    rows.push(current.join(''))
    const hair = holder.querySelector('.md-edge')
    const hairBox = hair?.getBoundingClientRect()
    return { rows: rows.map((row) => row.trim().split(/\s+/).join(' ')), over: inkRight - edge, edge, width: holder.getBoundingClientRect().width, columns: window.__personalNote.state.pages.columns,
      hair: hair ? { right: hairBox.right, visible: getComputedStyle(hair).display !== 'none' && hairBox.width > 0 && hairBox.height > 0, parentIsHolder: hair.parentElement === holder } : null }
  })
  const committedRows = (id) => pn((textId) => {
    const info = window.__personalNote.leaferCanvas().markdownInfo(textId)
    const rows = []
    let top = null
    for (const word of info.words) { if (top === null || Math.abs(word.y - top) > 4) { rows.push([]); top = word.y } rows.at(-1).push(info.source.slice(word.from, word.to)) }
    return rows.map((row) => row.join(' '))
  }, id)
  const sentence = 'The quick brown fox jumps over the lazy dog and keeps on running through the whole meadow until the sun goes down behind the hills. '
  await pn(() => window.__personalNote.createNote())
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('.md-editor .cm-content'), null, { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(600)
  const wrapNote = await pn(() => window.__personalNote.state.activeNoteId)
  let widest = -1e9
  let widths = new Set()
  let columnsSeen = new Set()
  for (let chunk = 0; chunk < 6; chunk += 1) {
    await page.keyboard.type(sentence.slice(chunk * 22, chunk * 22 + 22), { delay: 3 })
    const sample = await wrapProbe()
    widest = Math.max(widest, sample.over); widths.add(Math.round(sample.width)); columnsSeen.add(sample.columns)
  }
  await page.keyboard.type(sentence.repeat(2), { delay: 1 })
  const typing = await wrapProbe()
  widest = Math.max(widest, typing.over); widths.add(Math.round(typing.width)); columnsSeen.add(typing.columns)
  check('while typing a long line, no word ever runs past the wrap edge', widest <= 0.5, String(widest))
  check('the editor keeps one width and the pages do not grow sideways while typing', widths.size === 1 && columnsSeen.size === 1 && [...columnsSeen][0] === 1, JSON.stringify([[...widths], [...columnsSeen]]))
  check('a faint hairline marks the wrap edge while writing', Boolean(typing.hair?.visible) && typing.hair.parentIsHolder && Math.abs(typing.hair.right - typing.edge) < 2.5, JSON.stringify(typing.hair))
  await shot('wrap-edge')
  await page.waitForTimeout(1200) // (past the draft save)
  const stillTyping = await wrapProbe()
  check('the line breaks do not change when the typing pauses', JSON.stringify(stillTyping.rows) === JSON.stringify(typing.rows), JSON.stringify([typing.rows, stillTyping.rows]))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const wrapText = (await objects()).find((object) => object.type === 'text')
  const settled = await committedRows(wrapText.id)
  check('the line breaks once the typing stops equal the ones while typing', JSON.stringify(settled) === JSON.stringify(typing.rows), JSON.stringify([typing.rows, settled]))
  check('the hairline is gone when the writing is done', (await pn(() => document.querySelector('.md-edge'))) === null)
  check('the hairline is not saved in the note', !JSON.stringify(await pn(() => window.__personalNote.leaferEdits.doc)).includes('md-edge'))
  await page.reload()
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await pn((id) => window.__personalNote.selectNote(id), wrapNote)
  await page.waitForFunction((id) => window.__personalNote.leaferCanvas?.().markdownInfo?.(id)?.words?.length > 5, wrapText.id, { timeout: 15000 })
  await page.waitForTimeout(800)
  check('and after a reload', JSON.stringify(await committedRows(wrapText.id)) === JSON.stringify(typing.rows))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  // a text made with the Text tool part-way across the page wraps at that page's right margin, long unbreakable words included
  await pn(() => { window.__personalNote.leaferCanvas().setView({ x: 120, y: 40, scale: 1 }); window.__personalNote.setTool('text') })
  const wrapHost = await page.locator('#leafer-host').boundingBox()
  await page.mouse.click(wrapHost.x + 120 + 560, wrapHost.y + 40 + 600)
  await page.waitForTimeout(500)
  await page.keyboard.type('Come and see Averyveryveryveryveryverylongwordwithoutanybreaksatallhere and the rest of the line', { delay: 2 })
  const narrow = await wrapProbe()
  check('a text started part-way across the page wraps at the page margin, even around a very long word', narrow.over <= 0.5 && narrow.rows.length > 3, JSON.stringify([narrow.over, narrow.rows]))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const narrowText = (await objects()).filter((object) => object.type === 'text').find((object) => object.id !== wrapText.id)
  check('and breaks the same once it is written', JSON.stringify(await committedRows(narrowText.id)) === JSON.stringify(narrow.rows), JSON.stringify([narrow.rows, await committedRows(narrowText.id)]))

  await pn(() => window.__personalNote.createNote())
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 30000 })
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape') // (the new note opens with its caret ready: leave it, the clicks below make the texts)
  await page.waitForTimeout(300)
  // a click closer to the right margin than a short line starts the text further left, so its lines still end at the margin (and the page does not grow)
  await pn(() => { window.__personalNote.leaferCanvas().setView({ x: 120, y: 40, scale: 1 }); window.__personalNote.setTool('text') })
  await page.mouse.click(wrapHost.x + 120 + 790, wrapHost.y + 40 + 120)
  await page.waitForTimeout(500)
  await page.keyboard.type('Near the right edge of the page, a long line should still end at the margin.', { delay: 2 })
  const edgeProbe = await wrapProbe()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const edgeText = (await objects()).filter((object) => object.type === 'text').find(() => true)
  check('a text started within a short line of the page margin wraps at the margin and the page does not grow', edgeProbe.over <= 0.5 && edgeProbe.columns === 1 && edgeText.geometry.x + edgeText.geometry.width <= 860 - 56 + 0.5 && edgeText.geometry.width >= 200, JSON.stringify([edgeProbe.over, edgeProbe.columns, edgeText.geometry]))

  // input methods: a long composition (not yet accepted) and an autocorrect-style replacement never carry the words past the edge
  await pn(() => { window.__personalNote.leaferCanvas().setView({ x: 120, y: 40, scale: 1 }); window.__personalNote.setTool('text') })
  await page.mouse.click(wrapHost.x + 120 + 80, wrapHost.y + 40 + 400)
  await page.waitForTimeout(500)
  await page.keyboard.type('Typed words, then ', { delay: 2 })
  const cdp = await page.context().newCDPSession(page)
  const kana = 'こんにちは世界、これはとても長い日本語の文章で、ページの端を越えてはいけません。'.repeat(3)
  await cdp.send('Input.imeSetComposition', { text: kana, selectionStart: kana.length, selectionEnd: kana.length })
  await page.waitForTimeout(150)
  const composing = await wrapProbe()
  check('words being composed with an input method wrap at the edge too', composing.over <= 0.5 && composing.rows.length > 2, JSON.stringify([composing.over, composing.rows.length]))
  await cdp.send('Input.insertText', { text: kana })
  await page.waitForTimeout(150)
  await page.keyboard.type(' misspeled', { delay: 2 })
  await page.keyboard.press('Control+Shift+ArrowLeft')
  await pn(() => document.execCommand('insertText', false, 'a corrected and much longer replacement for the word'))
  await page.waitForTimeout(150)
  const corrected = await wrapProbe()
  check('and so do the words an autocorrect-style replacement brings in', corrected.over <= 0.5, String(corrected.over))
  await page.waitForTimeout(1000)
  const imeRows = (await wrapProbe()).rows
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const imeText = (await objects()).filter((object) => object.type === 'text').find((object) => object.id !== edgeText.id)
  check('after composing and correcting, the breaks once written equal the ones while writing', JSON.stringify(await committedRows(imeText.id)) === JSON.stringify(imeRows), JSON.stringify([imeRows, await committedRows(imeText.id)]))

  // the formatting editor loads a moment after the canvas: a text written before it is there (here it never arrives) wraps at the same width
  const early = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage()
  await early.route('**/markdown-editor.js*', (route) => route.abort())
  await early.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await early.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await early.waitForFunction(() => !window.__personalNote.state.creatingNote)
  await early.evaluate(() => window.__personalNote.createNote())
  await early.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 30000 })
  await early.waitForFunction(() => document.querySelector('.leafer-text-editor'), null, { timeout: 8000 }).catch(() => {})
  await early.waitForTimeout(600)
  await early.keyboard.type('Quick words typed at once, before the formatting editor is ready: ' + 'Averyveryveryveryveryverylongwordwithoutanybreaksatallhere and ' + sentence.repeat(2), { delay: 1 })
  const plain = await early.evaluate(() => { const area = document.querySelector('.leafer-text-editor'); return area && { tag: area.tagName, over: area.scrollWidth - area.clientWidth, width: area.clientWidth, height: area.scrollHeight, value: area.value } })
  check('a text written before the formatting editor is ready wraps at the wrap width (no line runs on)', plain?.tag === 'TEXTAREA' && plain.over <= 1 && plain.width === 724, JSON.stringify(plain && { ...plain, value: undefined }))
  await early.waitForTimeout(1000)
  await early.keyboard.press('Escape')
  await early.waitForTimeout(800)
  const earlyInfo = await early.evaluate(() => { const o = window.__personalNote.leaferEdits.doc.objects.find((x) => x.type === 'text'); const i = window.__personalNote.leaferCanvas().markdownInfo(o.id); return { content: o.content, height: i.height } })
  check('and nothing it was given is lost, nor does it change height when the typing stops', earlyInfo.content === plain?.value && Math.abs(earlyInfo.height - plain.height) <= 2, JSON.stringify([earlyInfo.height, plain?.height]))
  await early.context().close()

  // F-069: the older kinds of text (a classic point text as wide as its words, a classic text box, a sticky) wrap the same way: while they
  // are typed, in the middle of the page and near its right edge, never past the margin and never running on in one line
  const classicNote = await (await fetch(`${API}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Classic', notebookId: (await (await fetch(`${API}/api/notebooks`)).json())[0].id, noteType: 'canvas' }) })).json()
  const classicGeometry = (x, y, width, height) => ({ x, y, width, height, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 })
  const classicStyle = { fontSize: 24, color: '#1f1b16', fontWeight: 'normal', fontStyle: 'normal', textAlign: 'left', lineHeight: 1.45, padding: 8 }
  const classicNode = (id, mode, x, y, width, text) => ({ id, type: 'text', x, y, width, height: 40, text, pn: { type: 'text', mode, z: 0, geometry: classicGeometry(x, y, width, 40), style: classicStyle } })
  await fetch(`${API}/api/notes/${classicNote.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Classic', notebookId: classicNote.notebookId, revision: classicNote.revision, pageState: { columns: 1, rows: 2 }, content: { nodes: [
    classicNode('res_pointmid', 'point', 100, 100, 160, 'Point text'), classicNode('res_pointedge', 'point', 640, 300, 100, 'Edge text'),
    classicNode('res_boxmid', 'box', 100, 500, 400, 'Box text'), classicNode('res_boxedge', 'box', 640, 700, 150, 'Edge box'),
    { ...classicNode('res_centred', 'point', 300, 900, 200, 'Centred'), pn: { type: 'text', mode: 'point', z: 0, geometry: classicGeometry(300, 900, 200, 40), style: { ...classicStyle, textAlign: 'center' } } },
  ], edges: [] } }) })
  await pn(async (id) => { await window.__personalNote.refreshWorkspaceLists(); await window.__personalNote.selectNote(id) }, classicNote.id)
  await page.waitForFunction(() => window.__personalNote.leaferEdits.doc.objects.length === 5, null, { timeout: 15000 })
  await page.waitForTimeout(800)
  await pn(() => document.activeElement?.blur())
  await pn(() => window.__personalNote.leaferCanvas().setView({ x: 120, y: 40, scale: 1 }))
  const ids = (await objects()).map((object) => object.id) // (the app gives its own ids: they follow the order they were saved in)
  const original = (await objects()).map((object) => ({ mode: object.mode, geometry: object.geometry, content: object.content }))
  const names = ['point text, mid-page', 'point text, near the edge', 'box text, mid-page', 'box text, near the edge']
  for (const label of names) {
    const id = ids[names.indexOf(label)]
    const columnsBefore = await pn(() => window.__personalNote.state.pages.columns)
    await pn((textId) => window.__personalNote.leaferCanvas().editText(textId, { select: false }), id)
    await page.waitForTimeout(400)
    await page.keyboard.type(' ' + sentence + 'Averyveryveryveryveryverylongwordwithoutanybreaksatallhere', { delay: 1 })
    const area = await pn(() => { const a = document.querySelector('.leafer-text-editor'); const box = a.getBoundingClientRect(); return { right: box.right, over: a.scrollWidth - a.clientWidth, ws: getComputedStyle(a).whiteSpace, columns: window.__personalNote.state.pages.columns, edge: Boolean(a.parentElement.querySelector('.text-edge')) } })
    const hostBox = await page.locator('#leafer-host').boundingBox()
    const marginScreen = hostBox.x + 120 + 860 - 56
    check(`${label}: while typing, the lines wrap at the page margin (no line runs on) and the page does not grow`, area.ws === 'pre-wrap' && area.over <= 1 && area.right <= marginScreen + 1 && area.columns === columnsBefore, JSON.stringify([columnsBefore, area]))
    check(`${label}: a faint hairline marks the wrap edge while writing`, area.edge)
    await page.waitForTimeout(900)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(700)
    const after = (await objects()).find((object) => object.id === id)
    const was = original[names.indexOf(label)]
    check(`${label}: once written it is the box it was typed in, ending at the margin, still starting where it did`, after.mode === 'box' && after.geometry.x + after.geometry.width <= 860 - 56 + 0.5 && after.geometry.x === was.geometry.x, JSON.stringify([after.mode, after.geometry, was.geometry]))
    if (was.mode === 'point') {
      await pn(() => window.__personalNote.leaferEdits.undo())
      await page.waitForTimeout(300)
      const undone = (await objects()).find((object) => object.id === id)
      check(`${label}: undo returns it to a point text with its old place and size`, undone.mode === 'point' && JSON.stringify(undone.geometry) === JSON.stringify(was.geometry) && undone.content === was.content, JSON.stringify([undone.mode, undone.geometry, was.geometry]))
    }
  }
  // a centred legacy point text is left as it is: opening and typing in it moves nothing
  {
    const id = ids[4]
    await pn((textId) => window.__personalNote.leaferCanvas().editText(textId, { select: false }), id)
    await page.waitForTimeout(400)
    await page.keyboard.type(' more', { delay: 5 })
    await page.waitForTimeout(900)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(700)
    const centred = (await objects()).find((object) => object.id === id)
    check('a centred point text stays a point text and keeps its place when edited', centred.mode === 'point' && centred.geometry.x === 300 && centred.geometry.y === 900 && centred.content.endsWith(' more'), JSON.stringify([centred.mode, centred.geometry]))
  }
  check('and no hairline is left behind', (await pn(() => document.querySelector('.text-edge'))) === null)

  // F-070 on the plain textarea editor (a classic text, not Markdown): double-tap there and back keeps the caret
  {
    await pn((textId) => window.__personalNote.leaferCanvas().editText(textId, { select: false }), ids[2])
    await page.waitForTimeout(400)
    const isArea = await pn(() => document.activeElement?.tagName === 'TEXTAREA')
    await pn(() => document.activeElement.setSelectionRange(3, 3))
    await page.keyboard.press('ArrowRight')
    const plainBefore = await pn(() => document.activeElement.selectionStart)
    const tapPlain = async () => { await page.keyboard.down('Control'); await page.waitForTimeout(60); await page.keyboard.up('Control') }
    await tapPlain(); await page.waitForTimeout(100); await tapPlain()
    await page.waitForTimeout(400)
    check('plain editor: two taps switch to the pen and close the editor', isArea && (await pn(() => window.__personalNote.state.tool)) === 'pen' && !(await pn(() => document.querySelector('.leafer-text-editor'))))
    await tapPlain(); await page.waitForTimeout(100); await tapPlain()
    await page.waitForTimeout(400)
    const back = await pn(() => ({ tool: window.__personalNote.state.tool, tag: document.activeElement?.tagName, start: document.activeElement?.selectionStart, end: document.activeElement?.selectionEnd, caret: window.__personalNote.leaferCanvas().textCaret() }))
    check('plain editor: two more taps return to the same text with the caret at the same place', back.tool === 'text' && back.tag === 'TEXTAREA' && back.start === plainBefore && plainBefore === 4 && back.end === plainBefore && back.caret?.id === ids[2], JSON.stringify([plainBefore, back]))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }

  // F-070 double-tap the command key (Control here, Linux) toggles writing and the pen, real keys, caret in the words
  {
    await pn(() => window.__personalNote.createNote())
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 30000 })
    await page.waitForFunction(() => document.querySelector('.md-editor .cm-content'), null, { timeout: 8000 })
    await page.waitForTimeout(600)
    await page.keyboard.type('first line\nsecond line here')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    const caret = () => pn(() => window.__personalNote.leaferCanvas().textCaret())
    const tool = () => pn(() => window.__personalNote.state.tool)
    const pill = () => pn(() => { const el = document.querySelector('#tool-pill'); return el.hidden ? '' : el.textContent })
    const tap = async (key = 'Control', hold = 60) => { await page.keyboard.down(key); await page.waitForTimeout(hold); await page.keyboard.up(key) }
    const before = await caret()
    check('the caret sits mid-text in the formatting editor', before?.start === 8 && before.end === 8, JSON.stringify(before))
    const dockHtml = await pn(() => document.querySelector('[data-tool="pen"]').className)
    await tap(); await page.waitForTimeout(120)
    check('one tap changes nothing', (await tool()) === 'text' && (await caret())?.start === 8)
    await tap()
    await page.waitForTimeout(300)
    check('two taps with the caret in the text switch to the pen', (await tool()) === 'pen' && !(await pn(() => window.__personalNote.leaferCanvas().isEditingText())), await tool())
    check('a pill says Pen and the dock shows the pen active', (await pill()) === 'Pen' && (await pn(() => document.querySelector('[data-tool="pen"]').classList.contains('active'))), `${await pill()} / ${dockHtml}`)
    await page.waitForTimeout(1200)
    check('the pill goes away by itself', (await pill()) === '')
    // holding Space to pan while drawing is a temporary hand: the way back to the caret stays
    await page.keyboard.down(' ')
    await page.waitForTimeout(150)
    const handTool = await tool()
    await page.mouse.move(600, 500); await page.mouse.down(); await page.mouse.move(640, 540, { steps: 4 }); await page.mouse.up()
    await page.keyboard.up(' ')
    await page.waitForTimeout(300)
    check('Space pans with the hand and lets go back to the pen', handTool === 'hand' && (await tool()) === 'pen', JSON.stringify([handTool, await tool()]))
    await tap(); await page.waitForTimeout(100); await tap()
    await page.waitForTimeout(400)
    const back = await caret()
    check('two more taps return to text with the caret at the same place in the same text', (await tool()) === 'text' && back?.start === 8 && back.end === 8 && (await editing()), JSON.stringify([await tool(), back, before]))
    check('a pill says Text', (await pill()) === 'Text')
    await page.keyboard.type('X')
    await page.waitForTimeout(300)
    check('typing continues at that spot', (await pn(() => window.__personalNote.leaferCanvas().textCaret()))?.start === 9 && (await pn(() => document.querySelector('.md-editor .cm-content').textContent)).includes('first liXne'), await pn(() => document.querySelector('.md-editor .cm-content').textContent))
    // Control used in a shortcut, between or during the taps, never toggles
    await page.waitForTimeout(1000)
    await tap(); await page.keyboard.down('Control'); await page.keyboard.press('c'); await page.keyboard.up('Control'); await tap()
    await page.waitForTimeout(300)
    check('a Ctrl+C between two taps never toggles', (await tool()) === 'text')
    await tap(); await page.waitForTimeout(60); await page.keyboard.down('Control'); await page.keyboard.press('c'); await page.waitForTimeout(40); await page.keyboard.up('Control')
    await page.waitForTimeout(300)
    check('a Ctrl+C during the second tap never toggles', (await tool()) === 'text')
    await tap(); await page.keyboard.down('Control'); await page.mouse.wheel(0, 40); await page.keyboard.up('Control'); await tap()
    await page.waitForTimeout(300)
    check('a Ctrl+scroll zoom between two taps never toggles', (await tool()) === 'text')
    await page.waitForTimeout(500)
    await tap(); await page.keyboard.press('Shift'); await tap()
    await page.waitForTimeout(300)
    check('another key between the taps cancels', (await tool()) === 'text')
    await tap(); await page.waitForTimeout(500); await tap()
    await page.waitForTimeout(300)
    check('slow taps never toggle', (await tool()) === 'text')
    await page.waitForTimeout(500)
    await tap('Control', 700); await page.waitForTimeout(60); await tap('Control', 700)
    await page.waitForTimeout(300)
    check('long holds never toggle', (await tool()) === 'text')
    await tap(); await page.waitForTimeout(80); await tap(); await page.waitForTimeout(80); await tap()
    await page.waitForTimeout(300)
    check('a triple tap switches once (to the pen)', (await tool()) === 'pen')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    check('single-key shortcuts and Esc still work', (await tool()) === 'text')
    await page.keyboard.press('Escape')
    await pn(() => document.activeElement?.blur())
    await page.keyboard.press('e')
    await page.keyboard.press('t')
    await tap(); await page.waitForTimeout(100); await tap()
    await page.waitForTimeout(300)
    check('the last pen tool used (eraser) is the one it comes back to', (await tool()) === 'eraser', await tool())
    await page.keyboard.press('Escape')
  }

  // F-071 a middle-button click toggles like the double-tap; a middle-drag still pans; no paste, real mouse
  {
    await pn(() => window.__personalNote.createNote())
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 30000 })
    await page.waitForFunction(() => document.querySelector('.md-editor .cm-content'), null, { timeout: 8000 })
    await page.waitForTimeout(600)
    await page.keyboard.type('alpha beta gamma')
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft')
    const tool = () => pn(() => window.__personalNote.state.tool)
    const caret = () => pn(() => window.__personalNote.leaferCanvas().textCaret())
    const pill = () => pn(() => { const el = document.querySelector('#tool-pill'); return el.hidden ? '' : el.textContent })
    const before = await caret()
    const box = await pn(() => { const r = document.querySelector('.md-editor .cm-content').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    // seed the primary selection so a stray paste would show
    await pn(() => navigator.clipboard?.writeText?.('PASTED').catch(() => {}))
    await page.mouse.move(box.x, box.y)
    await page.mouse.down({ button: 'middle' }); await page.waitForTimeout(80); await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(400)
    check('a middle click inside the text switches to the pen and shows the pill', ['pen', 'eraser', 'highlight'].includes(await tool()) && (await pill()) !== '' && !(await pn(() => window.__personalNote.leaferCanvas().isEditingText())), `${await tool()} ${await pill()}`)
    await page.mouse.down({ button: 'middle' }); await page.waitForTimeout(80); await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(400)
    const back = await caret()
    check('a second middle click returns to text with the caret where it was', (await tool()) === 'text' && back?.start === before.start && back.end === before.end && (await editing()), JSON.stringify([await tool(), back, before]))
    const text = await pn(() => document.querySelector('.md-editor .cm-content').textContent)
    check('a middle click does not paste into the text', text === 'alpha beta gamma', text)
    // a small jitter under the limit is still a click
    await page.mouse.down({ button: 'middle' }); await page.mouse.move(box.x + 2, box.y + 1); await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(400)
    check('a 2px wobble is still a click', (await tool()) !== 'text', await tool())
    await page.mouse.down({ button: 'middle' }); await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(400)
    check('and back to text again', (await tool()) === 'text')
    // a middle-drag pans and never toggles
    const offsetOf = () => pn(() => { const w = window.__personalNote.leaferCanvas().drawnWorld(); return { x: w.x, y: w.y } })
    const panBefore = await offsetOf()
    await page.mouse.move(box.x, box.y)
    await page.mouse.down({ button: 'middle' }); await page.mouse.move(box.x - 60, box.y - 40, { steps: 6 }); await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(400)
    const panAfter = await offsetOf()
    check('a middle-drag pans the page', Math.abs(panAfter.x - panBefore.x) + Math.abs(panAfter.y - panBefore.y) > 20, JSON.stringify([panBefore, panAfter]))
    check('and does not toggle the tool', (await tool()) === 'text', await tool())
    // a long press without moving is not a click
    await page.mouse.down({ button: 'middle' }); await page.waitForTimeout(600); await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(300)
    check('a long middle press does not toggle', (await tool()) === 'text', await tool())
    // paste is never left blocked: Ctrl+V a good while after a middle click still pastes
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${UI_PORT}` })
    await pn(() => navigator.clipboard.writeText('PASTED'))
    await page.waitForTimeout(900)
    await pn(() => document.querySelector('.md-editor .cm-content')?.focus())
    await page.keyboard.press('Control+v')
    await page.waitForTimeout(400)
    check('Ctrl+V well after a middle click still pastes', (await pn(() => document.querySelector('.md-editor .cm-content')?.textContent ?? '')).includes('PASTED'), await pn(() => document.querySelector('.md-editor .cm-content')?.textContent))
    // a middle click on the sidebar neither toggles nor is swallowed
    const sideTool = await tool()
    const sideBox = await pn(() => { const r = document.querySelector('#sidebar').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    await page.mouse.move(sideBox.x, sideBox.y)
    await page.mouse.down({ button: 'middle' }); await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(300)
    check('a middle click on the sidebar does not toggle', (await tool()) === sideTool, `${sideTool} -> ${await tool()}`)
    // off while a dialog is open (search)
    await pn(() => document.activeElement?.blur())
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(300)
    await page.mouse.move(box.x, box.y)
    await page.mouse.down({ button: 'middle' }); await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(300)
    check('a middle click while search is open does not toggle', (await tool()) === 'text', await tool())
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }

  // A phone-width window opens as before (no automatic caret, no 100% writing view)
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
  await phone.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await phone.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await phone.evaluate((id) => window.__personalNote.selectNote(id), noteId)
  await phone.waitForTimeout(2500)
  check('a phone-width window opens as before (no caret placed)', !(await phone.evaluate(() => window.__personalNote.leaferCanvas().isEditingText())))
  await phone.context().close()
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
