// F-073 focus mode, in the real app: Vite dev server on PN_VERIFY_PORT (default 4880) with a real API on the next port over a scratch
// database, headless Chromium, the real keyboard and mouse. Run one at a time; it stops everything it starts.
//   PN_VERIFY_PORT=4882 node scripts/verify-focus.mjs          (PN_SHOT=/path/shot.png also saves pictures)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const UI_PORT = Number(process.env.PN_VERIFY_PORT || 4880)
const API_PORT = UI_PORT + 1
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-focus-'))
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], {
  env: { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db'), PERSONAL_NOTE_SECURE_IDLE_SECONDS: '6' }, stdio: 'ignore',
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
  const shot = async (name) => { if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${name}.png`) }) }
  const wait = (ms) => page.waitForTimeout(ms)
  const hidden = (selector) => pn((s) => getComputedStyle(document.querySelector(s)).display === 'none', selector)
  const inFocus = () => pn(() => document.querySelector('.app-shell').classList.contains('focus-mode'))
  const noteRevision = async (id) => (await (await fetch(`${API}/api/notes/${id}`)).json()).revision
  const snap = () => pn(() => {
    const app = window.__personalNote
    const v = app.leaferCanvas().view()
    return {
      tool: app.state.tool, view: { x: Math.round(v.x), y: Math.round(v.y), scale: Math.round(v.scale * 1000) / 1000 }, selection: app.leaferCanvas().selection(),
      caret: app.leaferCanvas().textCaret(), editing: app.leaferCanvas().isEditingText(), zoom: Math.round(app.state.canvasZoom * 1000) / 1000,
      dock: getComputedStyle(document.querySelector('.tool-dock')).display, sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
      topbar: getComputedStyle(document.querySelector('.topbar')).display, doc: JSON.stringify(app.leaferEdits.doc),
    }
  })
  // The colour of a few spots of the window, as it is painted.
  const pixels = async (points) => {
    const data = (await page.screenshot()).toString('base64')
    return pn(async ({ data, points }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      return points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)))
    }, { data, points })
  }
  const paperRgb = () => pn(() => getComputedStyle(document.querySelector('.app-shell')).backgroundColor.match(/\d+/g).slice(0, 3).map(Number))
  const near = (a, b, tolerance = 3) => a.every((value, i) => Math.abs(value - b[i]) <= tolerance)

  // A note with writing, a drawing and a page that is zoomed out, the Select tool, the text selected
  await pn(() => window.__personalNote.createNote())
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('.md-editor .cm-content'), null, { timeout: 8000 }).catch(() => {})
  await wait(600)
  await page.keyboard.type('# Trip\nThe harbour walk at dusk, with tea. Then the long way home along the water.')
  await wait(1200)
  const noteId = await pn(() => window.__personalNote.state.activeNoteId)
  const host = await page.locator('#leafer-host').boundingBox()
  await page.click('[data-tool="pen"]')
  await wait(400)
  const stroke = async (points) => { await page.mouse.move(points[0].x, points[0].y); await page.mouse.down(); for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 3 }); await page.mouse.up(); await wait(300) }
  await stroke([{ x: host.x + 700, y: host.y + 520 }, { x: host.x + 800, y: host.y + 600 }, { x: host.x + 740, y: host.y + 680 }])
  await wait(900)
  check('the note has a drawing as well as words', (await pn(() => window.__personalNote.leaferEdits.doc.objects.map((o) => o.type))).some((type) => type !== 'text'))
  await pn(() => document.activeElement?.blur())
  await page.keyboard.press('Escape')
  await wait(800)
  await page.click('[data-tool="select"]')
  const textId = await pn(() => window.__personalNote.leaferEdits.doc.objects.find((o) => o.type === 'text').id)
  await pn((id) => { window.__personalNote.leaferCanvas().finishTextEdit(); window.__personalNote.leaferCanvas().select([id]) }, textId)
  await pn(() => document.querySelector('#zoom-out').click())
  await wait(700)
  const revision = await noteRevision(noteId)

  // --- enter with the keyboard (Ctrl+. here, Cmd+. on a Mac)
  const before = await snap()
  check('the starting point: Select tool, text selected, zoomed out, not editing', before.tool === 'select' && before.selection.length === 1 && before.zoom < 1 && !before.editing, JSON.stringify([before.tool, before.selection, before.zoom, before.editing]))
  await page.keyboard.press('Control+.')
  await wait(900)
  await shot('focus')
  check('Ctrl+. enters focus mode', await inFocus())
  const during = await snap()
  check('the sidebar, dock, page map, zoom and top bar are gone', during.dock === 'none' && during.sidebar === 'none' && during.topbar === 'none' && (await hidden('#page-minimap')) && (await hidden('#zoom-control')))
  const paper = await paperRgb()
  const spots = await pixels([[30, 300], [200, 500], [1330, 400], [1100, 700], [680, 880], [900, 620], [40, 40], [300, 880]])
  check('the window is plain paper colour: no page edges, shadows, fold lines or dotted desk, and the drawing is not shown', spots.every((rgb) => near(rgb, paper)), JSON.stringify([paper, spots]))
  check('the dotted desk is off', await pn(() => getComputedStyle(document.querySelector('.app-shell')).backgroundImage === 'none'))
  const editor = await pn(() => { const r = document.querySelector('.leafer-text-editor')?.getBoundingClientRect(); return r && { left: r.left, right: r.right, top: r.top, width: r.width } })
  check('the words are in a centred column (about 680 px)', editor && Math.abs((editor.left + editor.right) / 2 - 680) < 3 && editor.width > 500 && editor.width < 760, JSON.stringify(editor))
  check('the caret is in the words, ready to type', during.editing && (await pn(() => document.activeElement === document.querySelector('.leafer-text-editor'))))
  check('drawing is off: the tool is Text and the pen cannot be picked', during.tool === 'text' && (await pn(() => { window.__personalNote.setTool('pen'); return window.__personalNote.state.tool })) === 'text')
  check('"Esc or Ctrl . to leave" shows, then fades by itself', Number(await pn(() => getComputedStyle(document.querySelector('#focus-hint')).opacity)) > 0.5)
  await wait(3000)
  check('the hint is gone after a moment', Number(await pn(() => getComputedStyle(document.querySelector('#focus-hint')).opacity)) < 0.05)
  check('the top strip is hidden until the mouse goes up there', Number(await pn(() => getComputedStyle(document.querySelector('#focus-strip')).opacity)) === 0)
  await page.mouse.move(700, 20)
  await wait(400)
  const strip = await pn(() => ({ opacity: Number(getComputedStyle(document.querySelector('#focus-strip')).opacity), title: document.querySelector('#focus-title').textContent, count: document.querySelector('#focus-count').textContent, height: document.querySelector('#focus-strip').getBoundingClientRect().height }))
  await shot('strip')
  check('hovering the top shows a 52 px strip with the title, the word count and Leave focus', strip.opacity === 1 && strip.height === 52 && strip.title.length > 0 && /^\d+ words$/.test(strip.count) && (await pn(() => document.querySelector('#focus-leave').textContent.includes('Leave focus'))), JSON.stringify(strip))
  await page.mouse.move(700, 500)
  await wait(300)
  check('the strip hides again when the mouse leaves', Number(await pn(() => getComputedStyle(document.querySelector('#focus-strip')).opacity)) === 0)
  // the real mouse in the margin does not start a new text or end the one being written
  const objectsBefore = await pn(() => window.__personalNote.leaferEdits.doc.objects.length)
  await page.mouse.click(120, 600)
  await wait(400)
  check('a click in the empty margin changes nothing (no new text, the caret stays)', (await pn(() => window.__personalNote.leaferEdits.doc.objects.length)) === objectsBefore && (await snap()).editing)

  // --- leave with the strip button
  await page.mouse.move(700, 20)
  await wait(300)
  await page.click('#focus-leave')
  await wait(1200)
  check('"Leave focus" leaves', !(await inFocus()))
  const after = await snap()
  check('everything is exactly as it was: tool, selection, zoom, view, dock, sidebar, top bar', after.tool === before.tool && JSON.stringify(after.selection) === JSON.stringify(before.selection) && after.zoom === before.zoom && JSON.stringify(after.view) === JSON.stringify(before.view) && after.dock !== 'none' && after.sidebar !== 'none' && after.topbar !== 'none', JSON.stringify([before, after].map((s) => ({ ...s, doc: 0 }))))
  check('the note is untouched: the same words and objects, and no save happened', after.doc === before.doc && (await noteRevision(noteId)) === revision, String(await noteRevision(noteId)))
  check('the focus began editing and leaving ended it: not editing, as before', !after.editing)

  // --- enter with the button in the top bar, leave with Esc; the caret was in the words
  await pn((id) => window.__personalNote.leaferCanvas().resumeText({ id, start: 12, end: 12 }), textId)
  await wait(500)
  const writing = await snap()
  check('the starting point: the caret is inside the words', writing.caret?.start === 12)
  await page.click('#focus-button')
  await wait(900)
  check('the focus button in the top bar enters focus mode', await inFocus())
  check('the caret is where it was', (await snap()).caret?.start === 12 && (await snap()).caret?.id === textId)
  await page.keyboard.press('Escape')
  await wait(1200)
  const back = await snap()
  check('Esc leaves, with the caret exactly where it was and the same view', !(await inFocus()) && back.caret?.start === 12 && back.editing && JSON.stringify(back.view) === JSON.stringify(writing.view) && back.tool === writing.tool, JSON.stringify([writing.caret, back.caret, writing.view, back.view]))
  check('and the note is still untouched', back.doc === before.doc && (await noteRevision(noteId)) === revision)

  // --- typing works in focus; Ctrl+. leaves
  await page.keyboard.press('Control+.')
  await wait(800)
  check('Ctrl+. enters from inside the text too', await inFocus())
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' And a last line.')
  await wait(300)
  const typed = await pn(() => document.querySelector('.leafer-text-editor').textContent)
  check('typing works in focus mode', typed.endsWith('And a last line.'), typed.slice(-40))
  await page.keyboard.press('Control+.')
  await wait(1200)
  check('Ctrl+. leaves again', !(await inFocus()))
  await wait(1200)
  const savedText = await pn(() => window.__personalNote.leaferEdits.doc.objects.find((o) => o.type === 'text').content)
  check('what was typed in focus is in the note', savedText.endsWith('And a last line.'), savedText.slice(-40))

  // --- the omnibar's Focus mode action
  await page.keyboard.press('Control+k')
  await page.waitForFunction(() => document.querySelector('#search-backdrop')?.classList.contains('open'), null, { timeout: 3000 })
  await page.keyboard.type('focus mode')
  await wait(500)
  await page.keyboard.press('Enter')
  await wait(1000)
  check('the omnibar has a Focus mode action and it enters focus mode', await inFocus())
  check('with the omnibar closed behind it', await pn(() => !document.querySelector('#search-backdrop').classList.contains('open')))
  await page.keyboard.press('Escape')
  await wait(1000)
  check('and Esc leaves', !(await inFocus()))

  // --- drawing stays off: the double-tap and the middle click change nothing, the caret stays and typing still lands
  await page.keyboard.press('Control+.')
  await wait(800)
  await pn((id) => window.__personalNote.leaferCanvas().resumeText({ id, start: 5, end: 5 }), textId)
  await wait(300)
  const caretBefore = await pn(() => window.__personalNote.leaferCanvas().textCaret())
  await page.keyboard.down('Control'); await page.keyboard.up('Control')
  await wait(60)
  await page.keyboard.down('Control'); await page.keyboard.up('Control')
  await wait(400)
  check('double-tap Ctrl in focus does nothing: still writing, same caret, no pen', (await snap()).tool === 'text' && (await snap()).editing && JSON.stringify((await snap()).caret) === JSON.stringify(caretBefore), JSON.stringify([await snap().then((x) => x.tool), caretBefore, await snap().then((x) => x.caret)]))
  const edBox = await pn(() => { const r = document.querySelector('.leafer-text-editor').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 20 } })
  await page.mouse.click(edBox.x, edBox.y, { button: 'middle' })
  await page.mouse.click(120, 700, { button: 'middle' })
  await wait(400)
  check('a middle click in focus does nothing either', (await snap()).tool === 'text' && (await snap()).editing)
  await page.keyboard.type('XY')
  await wait(200)
  check('and typing still lands', (await pn(() => document.querySelector('.leafer-text-editor').textContent)).includes('XY'))
  check('the wrap-edge hairline is not shown in focus', await pn(() => [...document.querySelectorAll('.md-edge, .text-edge')].every((e) => getComputedStyle(e).display === 'none')))

  // --- the line being typed stays in the window
  const caretIn = () => pn(() => { const r = getSelection().getRangeAt(0); const box = r.getClientRects()[0] ?? r.startContainer.parentElement.closest('.cm-line')?.getBoundingClientRect() ?? r.startContainer.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, h: innerHeight } })
  await page.keyboard.press('Control+End')
  let worst = 0
  for (let line = 1; line <= 50; line += 1) {
    await page.keyboard.type(`\nLine ${line} of a long piece`, { delay: 1 })
    if (line % 5 === 0) { await wait(120); const c = await caretIn(); worst = Math.max(worst, c.bottom - (c.h - 90)) }
  }
  await wait(300)
  const endCaret = await caretIn()
  await shot('long')
  check('typing 50 lines keeps the caret line inside the window with room below it', worst <= 0 && endCaret.bottom <= endCaret.h - 90 && endCaret.top > 0, JSON.stringify([worst, endCaret]))
  await page.keyboard.press('Control+Home')
  await wait(400)
  const homeCaret = await caretIn()
  check('moving the caret back to the top brings the top into view', homeCaret.top >= 40 && homeCaret.bottom <= homeCaret.h, JSON.stringify(homeCaret))
  for (let i = 0; i < 12; i += 1) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Control+End')
  await page.keyboard.press('ArrowUp')
  await wait(300)
  const upCaret = await caretIn()
  check('arrowing up from the end keeps the caret in view', upCaret.top > 40 && upCaret.bottom < upCaret.h, JSON.stringify(upCaret))
  await page.keyboard.press('Escape')
  await wait(1200)
  check('Esc leaves after all that', !(await inFocus()))

  // --- something added to the note while focus is on is not drawn, and is back after
  await page.keyboard.press('Control+.')
  await wait(800)
  await pn(() => window.__personalNote.leaferCanvas().createShape({ x: 600, y: 300 }, { fill: '#ff0000' }))
  await wait(600)
  const shapeSpots = await pixels([[680, 450], [700, 460], [720, 470]])
  check('an object made while focus is on is not drawn', shapeSpots.every((rgb) => near(rgb, paper)), JSON.stringify(shapeSpots))
  await page.keyboard.press('Escape')
  await wait(1200)
  const shapeBox = await pn(() => { const c = window.__personalNote.leaferCanvas(); const o = window.__personalNote.leaferEdits.doc.objects.find((x) => x.type === 'shape'); const b = c.screenBox(o.id); const h = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: Math.round(h.left + b.x + b.width / 2), y: Math.round(h.top + b.y + b.height / 2) } })
  const shapeNow = (await pixels([[shapeBox.x, shapeBox.y]]))[0]
  check('the shape made in focus is drawn again after Esc (not paper colour)', !near(shapeNow, paper, 30), JSON.stringify([shapeBox, shapeNow, paper]))
  check('and only the objects that are really there are shown again afterwards', (await pn(() => window.__personalNote.leaferEdits.doc.objects.some((o) => o.type === 'shape'))) && (await pn(() => window.__personalNote.leaferEdits.doc.objects.length)) >= 3)

  // --- a page note
  const pageNote = (await (await fetch(`${API}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Pages', notebookId: (await (await fetch(`${API}/api/notebooks`)).json())[0].id, noteType: 'page' }) })).json())
  await fetch(`${API}/api/notes/${pageNote.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Pages', notebookId: pageNote.notebookId, revision: pageNote.revision, pageState: { columns: 1, rows: 1 }, content: { markdown: '# A page\n\nSome plain words on a page note.' } }) })
  await pn(async (id) => { await window.__personalNote.refreshWorkspaceLists(); await window.__personalNote.selectNote(id) }, pageNote.id)
  await page.waitForFunction(() => document.querySelector('#page-host .cm-content'), null, { timeout: 15000 })
  await wait(800)
  const savedContent = async () => JSON.stringify((await (await fetch(`${API}/api/notes/${pageNote.id}`)).json()).content)
  // a drawing made by hand on empty paper (Draw mode), so there is ink to hide and to leave alone
  await pn(() => document.querySelector('[data-page-mode="draw"]').click())
  const paperBox = await pn(() => { const r = document.querySelector('.page-paper').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width } })
  const drag = async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); for (let i = 1; i <= 8; i += 1) await page.mouse.move(x + i * 14, y + Math.sin(i) * 20, { steps: 2 }); await page.mouse.up() }
  await drag(paperBox.x + 180, paperBox.y + 420)
  await pn(() => document.querySelector('[data-page-mode="write"]').click())
  await wait(2200)
  const inkBefore = await savedContent()
  check('the page note has a drawing', /"drawings":\[\{/.test(inkBefore), inkBefore.slice(-200))
  const pageRevision = await noteRevision(pageNote.id)
  const deskScroll = async () => pn(() => document.querySelector('.page-desk').scrollTop)

  // enter and leave with no typing: nothing saved
  await page.keyboard.press('Control+.')
  await wait(900)
  check('a page note: the existing drawing is not shown in focus', await pn(() => [...document.querySelectorAll('.page-drawing')].every((e) => getComputedStyle(e).display === 'none') && getComputedStyle(document.querySelector('.page-ink')).display === 'none'))
  // a mouse drag on empty paper must not draw
  await drag(680 - 150, 640)
  await drag(680 - 150, 300)
  await page.keyboard.press('Escape')
  await wait(2500)
  check('a mouse drag on empty paper in focus draws nothing: the same ink is saved and the revision is unchanged', (await savedContent()) === inkBefore && (await noteRevision(pageNote.id)) === pageRevision, `${await noteRevision(pageNote.id)} vs ${pageRevision}`)
  check('the drawing is shown again after leaving', await pn(() => [...document.querySelectorAll('.page-drawing')].every((e) => getComputedStyle(e).display !== 'none')))
  await page.keyboard.press('Control+.')
  await wait(800)
  await page.keyboard.press('Control+.')
  await wait(1500)
  check('entering and leaving a page note with no typing saves nothing', (await savedContent()) === inkBefore && (await noteRevision(pageNote.id)) === pageRevision)

  const pgHostBefore = await pn(() => { const r = document.querySelector('#page-host').getBoundingClientRect(); return { left: Math.round(r.left), width: Math.round(r.width) } })
  await page.click('#focus-button')
  await wait(900)
  check('a page note enters focus mode too', await inFocus())
  const pg = await pn(() => ({ toolbar: getComputedStyle(document.querySelector('.page-toolbar')).display, sidebar: getComputedStyle(document.querySelector('.sidebar')).display, stage: document.querySelector('.page-stage').getBoundingClientRect(), host: document.querySelector('#page-host').getBoundingClientRect(), typing: document.activeElement === document.querySelector('#page-host .cm-content') }))
  check('with its toolbar and sidebar gone, a 680 px column in the middle and the caret ready', pg.toolbar === 'none' && pg.sidebar === 'none' && Math.abs(pg.stage.width - 680) < 2 && Math.abs((pg.stage.left + pg.stage.right) / 2 - 680) < 12 && pg.typing, JSON.stringify(pg))
  await page.keyboard.type(' More.')
  await wait(200)
  check('typing works on a page note in focus', (await pn(() => document.querySelector('#page-host .cm-content').textContent)).includes('More.'))
  await page.keyboard.press('Escape')
  await wait(1200)
  const pgAfter = await pn(() => ({ toolbar: getComputedStyle(document.querySelector('.page-toolbar')).display, sidebar: getComputedStyle(document.querySelector('.sidebar')).display, host: document.querySelector('#page-host').getBoundingClientRect() }))
  check('Esc brings the page note back as it was', !(await inFocus()) && pgAfter.toolbar !== 'none' && pgAfter.sidebar !== 'none' && Math.round(pgAfter.host.left) === pgHostBefore.left && Math.round(pgAfter.host.width) === pgHostBefore.width, JSON.stringify(pgAfter))
  await pn(() => document.querySelector('[data-page-mode="draw"]').click())
  await page.keyboard.press('Control+.')
  await wait(700)
  check('draw mode is off in focus on a page note', await pn(() => !document.querySelector('#page-host').classList.contains('page-drawing-mode')))
  await page.keyboard.press('Escape')
  await wait(900)
  check('and back on afterwards', await pn(() => document.querySelector('#page-host').classList.contains('page-drawing-mode')))
  await pn(() => document.querySelector('[data-page-mode="write"]').click())

  // --- a long page note: the scroll position comes back
  const longNote = (await (await fetch(`${API}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Long', notebookId: pageNote.notebookId, noteType: 'page' }) })).json())
  await fetch(`${API}/api/notes/${longNote.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Long', notebookId: pageNote.notebookId, revision: longNote.revision, pageState: { columns: 1, rows: 1 }, content: { markdown: Array.from({ length: 90 }, (_, i) => `Paragraph ${i} of a long page note.`).join('\n\n') } }) })
  await pn(async (id) => { await window.__personalNote.refreshWorkspaceLists(); await window.__personalNote.selectNote(id) }, longNote.id)
  await page.waitForFunction(() => document.querySelector('#page-host .cm-content'), null, { timeout: 15000 })
  await wait(900)
  await pn(() => { document.querySelector('.page-desk').scrollTop = 700; document.activeElement?.blur() })
  await wait(400)
  const scrollBefore = await deskScroll()
  await page.keyboard.press('Control+.')
  await wait(900)
  await page.keyboard.press('Escape')
  await wait(1500)
  check('the page scroll position is the same after leaving focus', scrollBefore > 300 && Math.abs((await deskScroll()) - scrollBefore) <= 2, JSON.stringify([scrollBefore, await deskScroll()]))

  // --- the Mac app's window bridge, and the browser's full screen
  await pn(() => { window.__fsCalls = []; window.pywebview = { api: { set_full_screen: async (on) => { window.__fsCalls.push(on); return true } } } })
  await page.keyboard.press('Control+.')
  await wait(700)
  await page.keyboard.press('Escape')
  await wait(900)
  check('in the desktop app focus asks the window for full screen and gives it back', JSON.stringify(await pn(() => window.__fsCalls)) === '[true,false]', JSON.stringify(await pn(() => window.__fsCalls)))
  // quick repeated toggles while the window is still moving: one move at a time, the last ask wins
  await pn(() => { window.__fsCalls = []; window.pywebview = { api: { set_full_screen: async (on) => { window.__fsCalls.push(on); await new Promise((r) => setTimeout(r, 300)); return true } } } })
  for (let i = 0; i < 5; i += 1) { await page.keyboard.press('Control+.'); await wait(40) }
  await wait(1500)
  const calls = await pn(() => window.__fsCalls)
  const settledInFocus = await inFocus()
  check('five quick toggles end in focus and ask for full screen one move at a time, last ask wins', settledInFocus && calls.at(-1) === true && calls.every((on, i) => i === 0 || on !== calls[i - 1]), JSON.stringify([settledInFocus, calls]))
  await page.keyboard.press('Escape')
  await wait(1200)
  check('and leaving gives full screen back', (await pn(() => window.__fsCalls)).at(-1) === false)
  await pn(() => { delete window.pywebview })
  await page.keyboard.press('Control+.')
  await wait(700)
  const browserFull = await pn(() => Boolean(document.fullscreenElement))
  await page.keyboard.press('Control+.')
  await wait(900)
  console.log(`INFO  browser full screen on entering focus: ${browserFull} (headless Chromium may refuse it; focus works either way); after leaving: ${await pn(() => Boolean(document.fullscreenElement))}`)
  check('the browser full screen, if it was granted, is left with focus', !(await pn(() => Boolean(document.fullscreenElement))))

  // --- a note of drawings only: focus shows an empty page to write on and changes nothing until words are typed
  const notebook = (await (await fetch(`${API}/api/notebooks`)).json())[0]
  const drawn = await (await fetch(`${API}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Sketch', notebookId: notebook.id, noteType: 'canvas' }) })).json()
  const geometry = { x: 120, y: 200, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
  await fetch(`${API}/api/notes/${drawn.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Sketch', notebookId: notebook.id, revision: drawn.revision, pageState: { columns: 1, rows: 1 }, content: { nodes: [{ id: 'res_box', type: 'file', x: 120, y: 200, width: 200, height: 120, file: '', pn: { type: 'shape', kind: 'rect', z: 0, geometry, fill: '#ffd60a' } }], edges: [] } }) })
  await pn(async (id) => { await window.__personalNote.refreshWorkspaceLists(); await window.__personalNote.selectNote(id) }, drawn.id)
  await wait(1800)
  const sketchBefore = await snap()
  const sketchRevision = await noteRevision(drawn.id)
  await page.keyboard.press('Control+.')
  await wait(900)
  check('a note of drawings: focus is a blank page with the caret ready', (await inFocus()) && (await snap()).editing)
  const sketchSpots = await pixels([[300, 400], [600, 450], [900, 500]])
  check('and the drawing is not shown', sketchSpots.every((rgb) => near(rgb, paper)), JSON.stringify(sketchSpots))
  await page.keyboard.press('Escape')
  await wait(1200)
  const sketchAfter = await snap()
  check('leaving restores the drawing note exactly, with nothing saved', !(await inFocus()) && sketchAfter.doc === sketchBefore.doc && JSON.stringify(sketchAfter.view) === JSON.stringify(sketchBefore.view) && (await noteRevision(drawn.id)) === sketchRevision, JSON.stringify([sketchBefore.view, sketchAfter.view]))
  // --- a secure note in focus: it locks by itself, the words are hidden, focus is left, and nothing is lost or looped
  await pn(() => window.__personalNote.createNote())
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('.md-editor .cm-content'), null, { timeout: 8000 }).catch(() => {})
  await wait(600)
  await page.keyboard.type('ZEBRA-CARD-4111 hidden words')
  await wait(1500)
  const secureId = await pn(() => window.__personalNote.state.activeNoteId)
  await page.keyboard.press('Escape')
  await pn(() => document.querySelector('#top-properties').click())
  await wait(300)
  await page.click('#secure-note')
  await page.waitForSelector('.secure-sheet')
  await page.fill('.secure-sheet input[name=passphrase]', 'correct horse battery')
  await page.fill('.secure-sheet input[name=again]', 'correct horse battery')
  await page.click('.secure-sheet .primary')
  await page.waitForSelector('[data-recovery-key]', { timeout: 20000 })
  await page.click('[data-saved]')
  await page.click('[data-done]')
  await page.waitForSelector('.secure-pill')
  await pn(() => document.querySelector('#close-properties')?.click())
  await wait(500)
  await page.keyboard.press('Control+.')
  await wait(800)
  check('an unlocked secure canvas note can be focused', await inFocus())
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' FOCUSWORDS')
  await wait(1300)
  const lockLog = []
  page.on('request', (request) => { if (/\/secure\/lock|\/api\/notes\/\d+$/.test(request.url())) lockLog.push(`${request.method()} ${request.url().replace(/^.*\/api/, '')}`) })
  await page.waitForSelector('.secure-cover', { timeout: 15000 })
  await wait(2500)
  check('the quiet time locks the note: the cover shows and focus is left', (await page.locator('.secure-cover').count()) === 1 && !(await inFocus()))
  check('no word of it is anywhere on the page', !(await pn(() => (document.documentElement.outerHTML + document.body.innerText).includes('ZEBRA') || (document.documentElement.outerHTML + document.body.innerText).includes('FOCUSWORDS'))))
  check('locking once did not loop (one lock, a reload or two, no more)', lockLog.filter((l) => l.includes('/secure/lock')).length <= 1 && lockLog.filter((l) => l.startsWith('GET')).length <= 2, JSON.stringify(lockLog))
  check('the chrome is back behind the cover', (await snap()).sidebar !== 'none')
  await page.fill('.secure-cover input[name=passphrase]', 'correct horse battery')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.secure-pill', { timeout: 15000 })
  await wait(1500)
  const storedSecure = await pn(() => JSON.stringify(window.__personalNote.leaferEdits.doc))
  check('after unlocking, the words typed in focus are all there', storedSecure.includes('ZEBRA-CARD-4111') && storedSecure.includes('FOCUSWORDS'), storedSecure.slice(0, 200))
  void secureId

  check('no page errors', errors.length === 0, errors.join(' | '))
} catch (error) {
  check('the check ran to the end', false, error.stack || String(error))
} finally {
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
  api.kill()
  fs.rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
