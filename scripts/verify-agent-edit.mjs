// F-096 Show and Undo on "Claude edited this note", in the real app: Vite on PN_VERIFY_PORT (default 4960), the real API on the next port over a
// scratch database, headless Chromium, and the real `bin/personal-note` command line run against that database while the app is open.
// Desktop (1360x900, mouse and keyboard) then phone (390x844, touch).
// Checks: an agent's append to the open note puts "Claude edited this note", Show and Undo on the island; Show scrolls/zooms the new text into
// the window and marks it for a moment, then the mark goes; Undo takes the agent's text away (on screen and in the database) as one step and
// offers Redo, which puts it back; words the person typed after the agent's edit survive Undo; if the person changed the agent's own words
// since, Undo says so plainly and changes nothing; an agent edit to a note that is not open shows nothing; the same on a page note (Show
// marks the appended paragraph in the editor); the phone's island fits the screen and its chips answer a tap.
// It stops what it starts, never uses port 3137 or a real database, and deletes only the scratch folder it made.
//   PN_SHOT=/path/agent.png node scripts/verify-agent-edit.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4960)
const API_PORT = UI_PORT + 1
await assertPortsFree([UI_PORT, API_PORT])
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-agent-'))
const DB = path.join(scratch, 'verify.db')
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const env = { ...process.env, PERSONAL_NOTE_DB: DB }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], { env, stdio: 'ignore' })
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await sleep(150) } throw new Error('API did not start') }
const call = async (method, url, body) => {
  const response = await fetch(`${API}/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return response.status === 204 ? null : response.json()
}
// The real command line, as an agent runs it, on the scratch database.
const cli = (...args) => {
  const run = spawnSync(python, ['bin/personal-note', '--database', DB, '--agent', 'Claude Code', ...args], { env, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`personal-note ${args.join(' ')}: ${run.stderr}`)
  return run.stdout.trim() ? JSON.parse(run.stdout) : null
}
const canvasTexts = (note) => (note.content.nodes ?? []).filter((node) => node.type === 'text').map((node) => node.text)
const fresh = (id) => call('GET', `/notes/${id}`)
const waitFor = async (fn, ms = 9000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(60) } return false }

const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
let browser
try {
  await apiUp()
  await server.listen()
  // The notes: a canvas with two texts far apart, a second canvas the agent edits while it is not open, and a page.
  const makeCanvas = async (title, objects) => {
    const note = await call('POST', '/notes', { title })
    await call('PUT', `/notes/${note.id}`, { title, revision: note.revision, notebookId: note.notebookId, content: { objects }, pageState: { columns: 1, rows: 3 } })
    return note.id
  }
  const text = (words, left, top) => ({ type: 'Textbox', text: words, left, top, width: 500, fontSize: 24 })
  const seed = async () => { // (fresh notes for each session, so each starts from the same words)
    const canvasId = await makeCanvas('Agent canvas', [text('First thought', 120, 120), text('Second thought', 120, 2300)])
    const otherId = await makeCanvas('Another canvas', [text('Another note', 120, 120)])
    const pageNote = await call('POST', '/notes', { title: 'Agent page', noteType: 'page' })
    const lines = Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of the page, written by a person.`)
    await call('PUT', `/notes/${pageNote.id}`, { title: 'Agent page', revision: pageNote.revision, notebookId: pageNote.notebookId, content: { version: 1, markdown: lines.join('\n\n'), ink: { marks: [], drawings: [] } } })
    return { canvasId, otherId, pageId: pageNote.id }
  }

  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const shotBase = process.env.PN_SHOT

  const session = async (name, contextOptions, tap) => {
    console.log(`--- ${name}`)
    const { canvasId, otherId, pageId } = await seed()
    const context = await browser.newContext(contextOptions)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error' && !/WebSocket|8080|Request failed|status of 409/.test(message.text())) errors.push(message.text()) })
    const pn = (fn, arg) => page.evaluate(fn, arg)
    const shot = async (label) => { if (shotBase) await page.screenshot({ path: shotBase.replace('.png', `-${name}-${label}.png`) }) }
    const open = async (id) => {
      await pn((noteId) => window.__personalNote.selectNote(noteId), id)
      await page.waitForFunction((noteId) => window.__personalNote.state.activeNoteId === noteId, id)
      await page.waitForTimeout(700)
    }
    const face = () => pn(() => ({ kind: document.querySelector('#island').dataset.face, text: document.querySelector('#island .isl-face:not([hidden])')?.innerText.replace(/\s+/g, ' ').trim() }))
    const waitNotice = async (label) => waitFor(async () => { const f = await face(); return f.kind === 'agent' && f.text.startsWith(label) ? f : false })
    const chip = (action) => page.locator(`#island [data-island-action="${action}"]`)
    const settled = () => page.waitForFunction(() => { const i = document.querySelector('#island'); return Math.abs(i.getBoundingClientRect().width - (parseFloat(i.style.width) || 0)) < 1 }) // (the island glides to its new size; a press before it arrives would miss the chip)
    const press = async (action) => { await settled(); const box = await chip(action).boundingBox(); if (tap) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2) }
    const objects = () => pn(() => window.__personalNote.leaferEdits.doc.objects.map((object) => ({ id: object.id, content: object.content })))
    const view = () => pn(() => window.__personalNote.leaferCanvas().view())
    const marks = () => pn(() => [...document.querySelectorAll('.agent-mark')].map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } }))
    await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
    await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 }).catch(() => {})
    await page.waitForTimeout(500)

    // ------------------------------------------------------------------ canvas: the agent appends to the open note
    await open(canvasId)
    await pn(() => window.__personalNote.setViewTo({ x: 0, y: 0, scale: window.__personalNote.state.displayScale }))
    await page.waitForTimeout(300)
    const before = await view()
    let started = await fresh(canvasId)
    cli('notes', 'append', String(canvasId), '--text', 'Added by the agent')
    const notice = await waitNotice('Claude edited')
    check('an agent\'s append to the open note says "Claude edited this note" on the island, with Show and Undo', notice.text === (tap ? 'Claude edited Show Undo' : 'Claude edited this note Show Undo'), JSON.stringify(notice))
    await page.waitForTimeout(500) // (the island is still growing into its new face)
    const sized = await pn(() => { const r = document.querySelector('#island').getBoundingClientRect(); return { left: r.left, right: r.right, chips: [...document.querySelectorAll('#island [data-island-action^="agent-"]')].map((c) => { const b = c.getBoundingClientRect(); return { left: b.left, right: b.right } }) } })
    check('the island and its chips are inside the window', sized.left >= 0 && sized.right <= (await pn(() => innerWidth)) && sized.chips.every((c) => c.left >= sized.left && c.right <= sized.right), JSON.stringify(sized))
    const crowd = await pn(() => { const i = document.querySelector('#island').getBoundingClientRect(); return ['.sidebar-toggle', '#search-button'].map((s) => { const b = document.querySelector(s).getBoundingClientRect(); return b.width && b.right > i.left && b.left < i.right && b.bottom > i.top && b.top < i.bottom }) })
    check('the island stays clear of the notes button and the search button', crowd.every((over) => !over), JSON.stringify(crowd))
    await shot('notice')
    check('the appended text is in the open note', (await objects()).some((object) => object.content === 'Added by the agent'))

    // Show: the new text comes into the window, marked for a moment
    await press('agent-show')
    const shown = await waitFor(async () => (await marks()).length === 1 && (await marks())[0])
    check('Show marks the new text with one outline', Boolean(shown), String((await marks()).length))
    await page.waitForTimeout(450)
    const after = await view()
    check('Show moved the view to it', Math.abs(after.y - before.y) > 50 || Math.abs(after.scale - before.scale) > 0.01, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    const placed = await marks()
    const area = await pn(() => { const r = document.querySelector('#workspace').getBoundingClientRect(); return { cx: r.left + r.width / 2, top: r.top, bottom: r.bottom, right: r.right, left: r.left } })
    check('the mark is on screen, centred across the window', placed[0] && placed[0].left + placed[0].width / 2 > area.cx - 60 && placed[0].left + placed[0].width / 2 < area.cx + 60 && placed[0].top > area.top && placed[0].top + placed[0].height < area.bottom, JSON.stringify([placed[0], area]))
    await shot('show')
    check('the notice is still there after Show (Undo is still on offer)', (await face()).kind === 'agent')
    await waitFor(async () => !(await marks()).length, 4000)
    check('the mark goes after a moment', (await marks()).length === 0)

    // Undo: one step, on screen and in the database; Redo puts it back
    if ((await face()).kind !== 'agent') { // (the 4 s ran out while the mark showed: another append, to try Undo on)
      started = await fresh(canvasId)
      cli('notes', 'append', String(canvasId), '--text', 'Second append')
      await waitNotice('Claude edited')
    }
    const agentRevision = (await fresh(canvasId)).revision
    await press('agent-undo')
    const undone = await waitNotice('Undid Claude’s edit')
    check('Undo says what it did and offers Redo', Boolean(undone) && /Redo$/.test(undone.text), JSON.stringify(undone))
    const stored = await fresh(canvasId)
    check('Undo took the agent\'s words out of the database as one new revision', !canvasTexts(stored).some((words) => /Added by the agent|Second append/.test(words)) && stored.revision === agentRevision + 1, `${JSON.stringify(canvasTexts(stored))} r${stored.revision}/${agentRevision}`)
    check('and off the screen', !(await objects()).some((object) => /Added by the agent|Second append/.test(object.content ?? '')))
    check('the person\'s own words are untouched', canvasTexts(stored).includes('First thought') && canvasTexts(stored).includes('Second thought'))
    await shot('undone')
    await press('agent-redo')
    await waitNotice('Put Claude’s edit back')
    check('Redo brings the agent\'s version back, still in the database', canvasTexts(await fresh(canvasId)).some((words) => /Added by the agent|Second append/.test(words)))
    check('and on the screen', (await objects()).some((object) => /Added by the agent|Second append/.test(object.content ?? '')))

    // Words the person typed after the agent's edit survive Undo
    await waitFor(async () => (await face()).kind !== 'agent', 6000)
    const firstText = (await objects()).find((object) => object.content === 'First thought')
    cli('notes', 'append', String(canvasId), '--text', 'Third append')
    await waitNotice('Claude edited')
    await pn((id) => window.__personalNote.leaferCanvas().editText(id, { select: false }), firstText.id)
    await page.waitForTimeout(250)
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' and typed after')
    await press('agent-undo') // (not saved yet: Undo sends the words first)
    await waitNotice('Undid Claude’s edit')
    const mixed = canvasTexts(await fresh(canvasId))
    check('typing done after the agent\'s edit survives Undo, and the agent\'s words are gone', mixed.some((words) => /First thought and typed after/.test(words)) && !mixed.some((words) => /Third append/.test(words)), JSON.stringify(mixed))
    check('the typed words are still on screen', (await objects()).some((object) => /First thought and typed after/.test(object.content ?? '')))
    await pn(() => document.activeElement?.blur())

    // The person changed the agent's own words since: Undo says so and changes nothing
    await waitFor(async () => (await face()).kind !== 'agent', 6000)
    cli('notes', 'append', String(canvasId), '--text', 'Fourth append')
    await waitNotice('Claude edited')
    const current = await fresh(canvasId)
    const node = current.content.nodes.find((n) => n.type === 'text' && n.text === 'Fourth append')
    await call('PUT', `/notes/${canvasId}`, { title: current.title, revision: current.revision, notebookId: current.notebookId, content: { ...current.content, nodes: current.content.nodes.map((n) => (n.id === node.id ? { ...n, text: 'Fourth append, fixed by me' } : n)) } })
    await press('agent-undo')
    const refused = await waitNotice('Can’t undo')
    const toast = await waitFor(() => pn(() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.innerText : '' }), 3000)
    check('Undo over the person\'s edit of the agent\'s words says so, in the island and in full', Boolean(refused) && /you changed it since/.test(refused.text) && /would overwrite your edit\. Nothing was changed\./.test(String(toast)), JSON.stringify([refused, toast]))
    check('and changed nothing', canvasTexts(await fresh(canvasId)).includes('Fourth append, fixed by me'))
    await shot('refused')

    // A note that is not open: nothing shows
    await waitFor(async () => (await face()).kind !== 'agent', 7000)
    cli('notes', 'append', String(otherId), '--text', 'Written while closed')
    await page.waitForTimeout(3500) // (the app polls every 2 s)
    check('an agent edit to a note that is not open offers no Show or Undo (the island only says the agent is writing)', !/edited this note|Show|Undo/.test((await face()).text) && !(await chip('agent-undo').count()), JSON.stringify(await face()))
    await waitFor(async () => (await face()).kind === 'rest', 12000)
    check('an agent edit to a note that is not open shows nothing', (await face()).kind === 'rest', JSON.stringify(await face()))
    await open(otherId)
    await page.waitForTimeout(1500)
    check('and nothing shows when that note is opened afterwards', (await face()).kind === 'rest')

    // ------------------------------------------------------------------ page note
    await open(pageId)
    await pn(() => document.querySelector('#workspace').scrollTo?.(0, 0))
    cli('notes', 'append', String(pageId), '--text', 'Paragraph added by the agent')
    const pageNotice = await waitNotice('Claude edited')
    check('a page note gets the same notice', Boolean(pageNotice) && /Show\s+Undo$/.test(pageNotice.text), JSON.stringify(pageNotice))
    await press('agent-show')
    const pageMark = await waitFor(async () => (await marks()).length === 1 && (await marks())[0])
    const line = await pn(() => { const el = [...document.querySelectorAll('.cm-line')].find((node) => node.textContent.includes('Paragraph added by the agent')); const r = el?.getBoundingClientRect(); return r && { top: r.top, bottom: r.bottom } })
    check('Show scrolls the page to the new paragraph and marks it', Boolean(pageMark) && line && pageMark.top - 8 <= line.top + 2 && pageMark.top + pageMark.height + 8 >= line.bottom - 2 && line.top >= 0 && line.bottom <= (await pn(() => innerHeight)), JSON.stringify([pageMark, line]))
    await shot('page-show')
    if ((await face()).kind !== 'agent') { cli('notes', 'append', String(pageId), '--text', 'Another paragraph by the agent'); await waitNotice('Claude edited') }
    await press('agent-undo')
    await waitNotice('Undid Claude’s edit')
    const pageStored = (await fresh(pageId)).content.markdown
    check('Undo on the page takes the paragraph out of the database and the editor', !/by the agent/.test(pageStored) && pageStored.startsWith('Line 1 of the page') && !(await pn(() => /by the agent/.test(document.querySelector('.cm-content')?.textContent ?? ''))), pageStored.slice(-80))
    await press('agent-redo')
    await waitNotice('Put Claude’s edit back')
    check('and Redo brings it back', /by the agent/.test((await fresh(pageId)).content.markdown))
    check('no page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  await session('desktop', { viewport: { width: 1360, height: 900 } }, false)
  await session('phone', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }, true)
} catch (error) {
  console.error(error)
  results.push(false)
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  if (process.env.PN_KEEP) console.log('kept', scratch); else fs.rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nall ${results.length} passed`)
process.exit(failed ? 1 : 0)
