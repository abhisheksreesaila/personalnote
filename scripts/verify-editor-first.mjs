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
