// F-095 Drop a note into a note, in the real app: Vite on PN_VERIFY_PORT (default 4940), the real API on the next port over a scratch database
// (scripts/verify_note_links_seed.py), headless Chromium, real mouse and touch. Desktop (1360x1400) then phone (390x844, touch).
// Checks: a note row dragged onto a canvas lands as a link card at the drop spot (title, first lines, notebook icon) and a click opens that note;
// dragged onto a page it becomes a link at the drop point that opens the note; "Link to a note…" (island card, omnibar) does the same without a drag;
// the link survives a reload and a backup import (repointed at the imported copy); a removed target says "note removed", never an error;
// a secure target gives its title only; HTML in titles and words stays text; Done on an X bookmark archives it (and Undo brings it back).
// It stops what it starts, never uses port 3137 or a real database, and deletes only the scratch folder it made.
//   PN_SHOT=/path/links.png node scripts/verify-note-links.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4940)
const API_PORT = UI_PORT + 1
await assertPortsFree([UI_PORT, API_PORT])
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-links-'))
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const env = { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db') }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const seeded = spawnSync(python, ['scripts/verify_note_links_seed.py'], { env, encoding: 'utf8' })
if (seeded.status !== 0) { console.error(seeded.stderr); process.exit(1) }
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], { env, stdio: 'ignore' })
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await sleep(150) } throw new Error('API did not start') }
const call = async (method, url, body) => {
  const response = await fetch(`${API}/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return response.status === 204 ? null : response.json()
}
const noteByTitle = async (title) => (await call('GET', '/notes')).find((note) => note.title === title)
const full = async (title) => call('GET', `/notes/${(await noteByTitle(title)).id}`)

const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
let browser
try {
  await apiUp()
  await server.listen()
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const shotBase = process.env.PN_SHOT

  // ------------------------------------------------------------------------------------------------ desktop
  const context = await browser.newContext({ viewport: { width: 1360, height: 1400 } })
  const page = await context.newPage()
  await page.addInitScript(() => localStorage.setItem('pn.notesPanelOpen', '1'))
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const shot = async (name) => { if (shotBase) await page.screenshot({ path: shotBase.replace('.png', `-${name}.png`) }) }
  const open = async () => {
    await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
    await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 }).catch(() => {})
    await page.waitForTimeout(400)
  }
  const pn = (fn, arg) => page.evaluate(fn, arg)
  const openNote = async (title) => {
    const note = await noteByTitle(title)
    await pn((id) => window.__personalNote.selectNote(id), note.id)
    await page.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, note.id)
    await page.waitForTimeout(500)
    return note
  }
  const rowOf = async (title) => {
    const note = await noteByTitle(title)
    const row = page.locator(`.note-list-item[data-note-id="${note.id}"]`)
    if (!(await row.count())) { await page.locator('.nbk', { has: page.locator(`[data-notebook-select="${note.notebookId}"]`) }).locator('[data-notebook-select]').click(); await page.waitForTimeout(400) }
    await row.scrollIntoViewIfNeeded()
    return row
  }
  // A real mouse drag of a notes-panel row onto a window point.
  const dragRowTo = async (title, x, y) => {
    const row = await rowOf(title)
    const box = await row.boundingBox()
    await page.mouse.move(box.x + 30, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 60, box.y + box.height / 2 + 10, { steps: 4 })
    await page.mouse.move(x, y, { steps: 12 })
    await page.waitForTimeout(150)
    await page.mouse.up()
    await page.waitForTimeout(700)
  }
  const cards = () => pn(() => window.__personalNote.leaferCanvas().document().objects.filter((object) => object.type === 'notelink').map((object) => ({ id: object.id, ref: object.noteRef, title: object.title, x: object.geometry.x, y: object.geometry.y, w: object.geometry.width, h: object.geometry.height })))
  const toPage = (x, y) => pn(([cx, cy]) => window.__personalNote.leaferCanvas().pageAt(cx, cy), [x, y])
  const toWindow = async (point) => pn((p) => { const view = window.__personalNote.leaferCanvas().view(); const rect = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: rect.left + view.x + p.x * view.scale, y: rect.top + view.y + p.y * view.scale } }, point)
  // The colour on the Leafer canvas at a window point (the card's badge is the notebook's colour).
  const pixelAt = async (x, y) => {
    const png = await page.screenshot({ clip: { x: Math.round(x) - 1, y: Math.round(y) - 1, width: 3, height: 3 } })
    return pn(async (base64) => {
      const image = await new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img); img.src = `data:image/png;base64,${base64}` })
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height
      const g = c.getContext('2d'); g.drawImage(image, 0, 0)
      return [...g.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data].slice(0, 3)
    }, png.toString('base64'))
  }

  await open()
  const lisbon = await noteByTitle('Lisbon trip')
  const hub = await openNote('Hub')
  check('Hub is an empty canvas note', (await cards()).length === 0)

  // ---- drag a row onto the canvas
  const target = { x: 760, y: 520 }
  await dragRowTo('Lisbon trip', target.x, target.y)
  let found = await cards()
  check('dragging a note row onto the canvas lands one link card', found.length === 1 && found[0].ref === lisbon.resourceId && found[0].title === 'Lisbon trip', JSON.stringify(found))
  const dropPoint = await toPage(target.x, target.y)
  const centre = found[0] && { x: found[0].x + found[0].w / 2, y: found[0].y + found[0].h / 2 }
  check('the card is centred on the drop spot', centre && Math.abs(centre.x - dropPoint.x) < 2 && Math.abs(centre.y - dropPoint.y) < 2, `${JSON.stringify(centre)} vs ${JSON.stringify(dropPoint)}`)
  await shot('desktop-card')
  const badge = found[0] && await toWindow({ x: found[0].x + 14 + 22, y: found[0].y + found[0].h / 2 + 14 })
  const colour = badge && await pixelAt(badge.x, badge.y)
  check('the card shows the Travel notebook colour (#4D839C) on its badge', colour && Math.abs(colour[0] - 0x4d) < 18 && Math.abs(colour[1] - 0x83) < 18 && Math.abs(colour[2] - 0x9c) < 18, JSON.stringify(colour))
  await page.waitForTimeout(800)
  const hubSaved = await full('Hub')
  const link = hubSaved.content.nodes.find((node) => node.type === 'link')
  check('it saves as a JSON Canvas link node pointing at the note', link?.url === `personal-note://note/${lisbon.resourceId}`, JSON.stringify(link))
  const answer = await pn((ref) => import('/src/core/note-links.js').then((module) => module.peekNoteLink(ref)), lisbon.resourceId)
  check('the card has the live title, first lines and notebook from the server', answer?.title === 'Lisbon trip' && answer.excerpt === 'Lisbon\nHarbour walk at dusk\nBuy tickets' && answer.notebook?.name === 'Travel', JSON.stringify(answer))

  // ---- click opens the target; a drag moves the card instead
  const cardAt = await toWindow({ x: found[0].x + found[0].w * 0.7, y: found[0].y + found[0].h / 2 })
  await page.mouse.move(cardAt.x, cardAt.y)
  await page.mouse.down()
  await page.mouse.move(cardAt.x + 80, cardAt.y + 50, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  const moved = (await cards())[0]
  check('dragging the card moves it and does not open the note', moved && moved.x > found[0].x + 40 && (await pn(() => window.__personalNote.state.activeNoteId)) === hub.id, JSON.stringify(moved))
  const now = await toWindow({ x: moved.x + moved.w * 0.7, y: moved.y + moved.h / 2 })
  await page.mouse.click(now.x, now.y)
  await page.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, lisbon.id, { timeout: 10000 }).catch(() => {})
  check('clicking the card opens the linked note', (await pn(() => window.__personalNote.state.activeNoteId)) === lisbon.id)


  // ---- a page note: the drop point is where the link goes
  const reading = await openNote('Reading list')
  await page.waitForSelector('.page-host:not([hidden]) .cm-content')
  const lineBox = (text) => pn((t) => {
    const range = document.createRange()
    const walker = document.createTreeWalker(document.querySelector('.page-host .cm-content'), NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf(t)
      if (at >= 0) { range.setStart(node, at); range.setEnd(node, at + t.length); const r = range.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
    }
    return null
  }, text)
  const second = await lineBox('Second line')
  await dragRowTo('Lisbon trip', second.x + 12, second.y + second.h / 2)
  await page.waitForTimeout(1500)
  const readingSaved = await full('Reading list')
  const md = readingSaved.content.markdown
  const linkMd = `[Lisbon trip](personal-note://note/${lisbon.resourceId})`
  const expected = `First line of the reading list.\n\n${linkMd} Second line, where a link can go.\n\nThird line.` // (dropped in the middle of "Second": at the word's start; nothing else is written, not even the dragged id)
  check('dropped on a page it becomes exactly the Markdown link at the word edge, and nothing else is added to the words', md === expected, JSON.stringify(md))
  await page.waitForSelector('.page-note-link')
  const shown = await pn(() => { const el = document.querySelector('.page-note-link'); return { text: el.textContent, content: document.querySelector('.page-host .cm-content').textContent } })
  check('only the title shows in the page (the address is hidden until the caret is in it)', shown.text === 'Lisbon trip' && !shown.content.includes('personal-note://'), JSON.stringify(shown))
  await shot('desktop-page-link')
  await page.click('.page-note-link')
  await page.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, lisbon.id, { timeout: 10000 }).catch(() => {})
  check('clicking the link in the page opens the note', (await pn(() => window.__personalNote.state.activeNoteId)) === lisbon.id)

  // ---- "Link to a note…" without a drag: the note's menu and the omnibar
  await openNote('Hub')
  const before = (await cards()).length
  await page.click('#share-button')
  await page.click('#share-link')
  await page.waitForSelector('#search-input', { state: 'visible' })
  check('"Link to a note…" in the note menu opens the omnibar asking which note', (await page.getAttribute('#search-input', 'placeholder')) === 'Link to which note?')
  await page.fill('#search-input', 'Reading')
  await page.waitForTimeout(600)
  const rows = await page.locator('.omni-row').allTextContents()
  check('it offers notes only (no actions, not the open note)', rows.length > 0 && rows.every((text) => !/Focus mode|New note|Skin:/.test(text)) && !rows.some((text) => /^Hub/.test(text)), JSON.stringify(rows))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
  const after = await cards()
  const view = await pn(() => window.__personalNote.leaferCanvas().view())
  const viewCentre = await pn(() => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); return window.__personalNote.leaferCanvas().pageAt(r.left + r.width / 2, r.top + r.height / 2) })
  check('the pick lands a card for that note in the middle of the view', after.length === before + 1 && after.at(-1).ref === reading.resourceId && Math.abs(after.at(-1).x + 140 - viewCentre.x) < 80 && Math.abs(after.at(-1).y + 48 - viewCentre.y) < 80, JSON.stringify([after.at(-1), viewCentre, view]))
  await shot('desktop-menu-link')
  await page.keyboard.press('Control+k')
  await page.waitForSelector('#search-input', { state: 'visible' })
  await page.fill('#search-input', 'Link to a')
  await page.waitForTimeout(400)
  check('the omnibar has the action "Link to a note…"', (await page.locator('.omni-row').allTextContents()).some((text) => text.includes('Link to a note…')))
  await page.keyboard.press('Escape')

  // ---- survives a reload; a removed target says so, never an error
  await page.waitForTimeout(800)
  await page.reload()
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await openNote('Hub')
  check('the cards are still there after a reload', (await cards()).length === before + 1)
  const gone = await noteByTitle('Reading list')
  await call('DELETE', `/notes/${gone.id}`)
  await page.reload()
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await openNote('Hub')
  await page.waitForTimeout(800)
  const removedAnswer = await pn((ref) => import('/src/core/note-links.js').then((module) => module.peekNoteLink(ref)), reading.resourceId)
  check('a removed target is answered as gone (null), not as an error', removedAnswer === null, JSON.stringify(removedAnswer))
  const removedCard = (await cards()).find((card) => card.ref === reading.resourceId)
  const removedAt = await toWindow({ x: removedCard.x + removedCard.w * 0.7, y: removedCard.y + removedCard.h / 2 })
  await shot('desktop-removed')
  await page.mouse.click(removedAt.x, removedAt.y)
  await page.waitForTimeout(500)
  check('clicking it says the note was removed and stays on the note', (await page.locator('#toast').textContent()).includes('That note was removed') && (await pn(() => window.__personalNote.state.activeNoteId)) === hub.id, await page.locator('#toast').textContent())
  const dashed = await pixelAt(removedAt.x - removedCard.w * 0.7 + 3, removedAt.y)
  check('its face is drawn as a removed note (muted badge, not the notebook colour)', dashed !== null)

  // ---- the same in a page: a link whose note was removed is struck through and says so
  const temp = await call('POST', '/notes', { title: 'Temp target', noteType: 'page', notebookId: hub.notebookId })
  const holder = await call('POST', '/notes', { title: 'Holds a dead link', noteType: 'page', notebookId: hub.notebookId })
  await call('PUT', `/notes/${holder.id}`, { title: 'Holds a dead link', revision: holder.revision, content: { version: 1, markdown: `Gone: [Temp target](personal-note://note/${temp.resourceId}) and still here: [Lisbon trip](personal-note://note/${lisbon.resourceId}).`, ink: { marks: [], drawings: [] } } })
  await call('DELETE', `/notes/${temp.id}`)
  await pn(() => window.__personalNote.refreshWorkspaceLists())
  await openNote('Holds a dead link')
  await page.waitForSelector('.page-note-link.gone', { timeout: 10000 }).catch(() => {})
  const dead = await pn(() => { const el = document.querySelector('.page-note-link.gone'); return el && { text: el.textContent, after: getComputedStyle(el, '::after').content, struck: getComputedStyle(el).textDecorationLine, others: document.querySelectorAll('.page-note-link:not(.gone)').length } })
  check('in a page a removed note shows struck through with "(note removed)" and the live link beside it is normal', dead?.text === 'Temp target' && /note removed/.test(dead.after) && dead.struck === 'line-through' && dead.others === 1, JSON.stringify(dead))
  await shot('desktop-page-gone')
  await page.click('.page-note-link.gone')
  await page.waitForTimeout(400)
  check('clicking it says the note was removed and stays put', (await page.locator('#toast').textContent()).includes('That note was removed') && (await pn(() => window.__personalNote.state.activeNoteId)) === holder.id)

  // ---- a secure target shows only its title
  const secret = await noteByTitle('Card numbers')
  await pn(([ref]) => window.__personalNote.leaferCanvas().addNoteLink({ x: 600, y: 800 }, { ref, title: 'Card numbers' }), [secret.resourceId])
  await page.waitForTimeout(800)
  const secureAnswer = await pn((ref) => import('/src/core/note-links.js').then((module) => module.peekNoteLink(ref)), secret.resourceId)
  check('a secure target answers with its title and none of its words', secureAnswer?.secure === true && secureAnswer.title === 'Card numbers' && secureAnswer.excerpt === '' && !JSON.stringify(secureAnswer).includes('ZEBRA'), JSON.stringify(secureAnswer))
  const hubBody = JSON.stringify(await full('Hub'))
  check('the note holding the card never stored the secure note\'s words', !hubBody.includes('ZEBRA') && !hubBody.includes('never shown'))
  await shot('desktop-secure')

  // ---- HTML in a title or in the words stays text
  const sneaky = await noteByTitle('<img src=x onerror="window.__pwned=1"> sneaky')
  await pn(([ref, title]) => window.__personalNote.leaferCanvas().addNoteLink({ x: 300, y: 300 }, { ref, title }), [sneaky.resourceId, sneaky.title])
  await page.waitForTimeout(800)
  await openNote('Hub')
  const sneakyAnswer = await pn((ref) => import('/src/core/note-links.js').then((module) => module.peekNoteLink(ref)), sneaky.resourceId)
  check('a title and words made of HTML come back as plain strings', sneakyAnswer.title.startsWith('<img') && sneakyAnswer.excerpt.includes('<script>'), JSON.stringify(sneakyAnswer))
  await openNote(sneaky.title) // (a page note whose own title and words are HTML)
  await page.waitForSelector('.page-host:not([hidden]) .cm-content')
  await page.waitForTimeout(600)
  check('no script ran from any title or words', (await pn(() => window.__pwned)) === undefined && (await pn(() => document.querySelectorAll('.page-host img, #leafer-host img').length)) === 0)

  // ---- backup and restore: the restored Hub points at the restored Lisbon trip
  const backup = await call('GET', '/export/workspace')
  const imported = await call('POST', '/import/workspace', backup)
  await page.reload()
  await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await pn(() => window.__personalNote.refreshWorkspaceLists())
  const allHubs = (await call('GET', '/notes')).filter((note) => note.title === 'Hub')
  const copy = allHubs.find((note) => imported.noteIds.includes(note.id))
  await pn((id) => window.__personalNote.selectNote(id), copy.id)
  await page.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, copy.id)
  await page.waitForTimeout(800)
  const copyCards = await cards()
  const copyLisbonRef = copyCards.find((card) => card.title === 'Lisbon trip')?.ref
  const copyLisbon = (await call('GET', '/notes')).find((note) => note.resourceId === copyLisbonRef)
  check('after a restore the copy of Hub has a card pointing at the restored Lisbon trip, not the original', copyLisbon && copyLisbon.id !== lisbon.id && imported.noteIds.includes(copyLisbon.id), JSON.stringify([copyLisbonRef, copyLisbon?.id]))
  const copyAt = await toWindow({ x: copyCards.find((card) => card.title === 'Lisbon trip').x + 200, y: copyCards.find((card) => card.title === 'Lisbon trip').y + 40 })
  await page.mouse.click(copyAt.x, copyAt.y)
  await page.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, copyLisbon.id, { timeout: 10000 }).catch(() => {})
  check('clicking the restored card opens the restored note', (await pn(() => window.__personalNote.state.activeNoteId)) === copyLisbon?.id)
  const exported = await (await fetch(`${API}/api/export/markdown`)).arrayBuffer()
  const unzipped = spawnSync(python, ['-c', 'import sys,zipfile,io; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print("\\n".join(z.read(n).decode() for n in z.namelist() if n.endswith("/hub.md")))'], { input: Buffer.from(exported), encoding: 'utf8' })
  check('the Markdown export holds the link as a Markdown link to the note\'s file', /\[Lisbon trip\]\(lisbon-trip\.md\)/.test(unzipped.stdout) || /\[Lisbon trip\]\([^)]*lisbon-trip[^)]*\.md\)/.test(unzipped.stdout), unzipped.stdout.slice(0, 300))

  // ---- Done on an X bookmark
  const bookmark = (await call('GET', '/notes')).filter((note) => note.title.startsWith('@ada: ')).sort((a, b) => a.id - b.id)[0] // (the restore made copies)
  await pn((id) => window.__personalNote.selectNote(id), bookmark.id)
  await page.waitForSelector('.x-done:not([hidden])', { timeout: 10000 })
  await shot('desktop-x-done')
  const doneBox = await page.locator('.x-done').boundingBox()
  check('an X bookmark shows a Done button at the top right, at least 44px tall', doneBox && doneBox.height >= 44 && doneBox.x > 1000, JSON.stringify(doneBox))
  await page.locator('.x-done').click()
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Done'), null, { timeout: 10000 }).catch(() => {})
  const archived = (await call('GET', '/notes')).find((note) => note.id === bookmark.id)
  const books = await call('GET', '/notebooks')
  const archive = books.find((book) => book.id === archived?.notebookId)
  check('one click archives it: still there, now in the Archive notebook "X bookmarks done"', archive?.category === 'archive' && archive.name === 'X bookmarks done', JSON.stringify(archive))
  check('and its words are untouched', (await call('GET', `/notes/${bookmark.id}`)).content.markdown.includes('First bookmark about engines'))
  check('the Done button goes away for an archived bookmark', await page.locator('.x-done').isHidden())
  await page.click('#toast-action')
  await page.waitForTimeout(900)
  const undone = (await call('GET', '/notes')).find((note) => note.id === bookmark.id)
  check('Undo puts it back in X bookmarks', books.find((book) => book.id === undone.notebookId)?.name === 'X bookmarks' || (await call('GET', '/notebooks')).find((book) => book.id === undone.notebookId)?.name === 'X bookmarks')
  check('and the Done button is back', await page.locator('.x-done').isVisible())
  await page.locator('.x-done').click()
  await page.waitForTimeout(900)
  const again = (await call('GET', '/notebooks')).filter((book) => book.name === 'X bookmarks done')
  check('Done twice still uses the one archive notebook', again.length === 1)
  const firstLine = await lineBox('First bookmark')
  await page.mouse.click(firstLine.x + 20, firstLine.y + firstLine.h / 2)
  await page.keyboard.press('End')
  await page.keyboard.type(' kept')
  await page.waitForTimeout(1600)
  check('the open bookmark still saves after being archived (no revision conflict)', (await call('GET', `/notes/${bookmark.id}`)).content.markdown.includes(' kept'))

  check('no page errors', errors.length === 0, errors.join(' | '))

  // ------------------------------------------------------------------------------------------------ phone: a narrow window (390x844)
  await context.close()
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  const phone = await phoneContext.newPage()
  const phoneErrors = []
  phone.on('pageerror', (error) => phoneErrors.push(error.message))
  const pshot = async (name) => { if (shotBase) await phone.screenshot({ path: shotBase.replace('.png', `-phone-${name}.png`) }) }
  const ppn = (fn, arg) => phone.evaluate(fn, arg)
  await phone.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await phone.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  await phone.waitForTimeout(600)
  const popen = async (title) => {
    const note = await noteByTitle(title)
    await ppn((id) => window.__personalNote.selectNote(id), note.id)
    await phone.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, note.id)
    await phone.waitForTimeout(600)
    return note
  }
  const pcards = () => ppn(() => window.__personalNote.leaferCanvas().document().objects.filter((object) => object.type === 'notelink').map((object) => ({ ref: object.noteRef, title: object.title, x: object.geometry.x, y: object.geometry.y, w: object.geometry.width, h: object.geometry.height })))
  const phoneHub = await popen('Hub')
  const hubCardsBefore = (await pcards()).length

  // the visible alternative, by finger
  await phone.tap('#share-button')
  await phone.waitForTimeout(700) // (the card finishes opening)
  const linkButton = await phone.locator('#share-link').boundingBox()
  check('phone: "Link note" in the note menu is on screen and a finger-sized target', linkButton && linkButton.x >= 0 && linkButton.x + linkButton.width <= 390 && linkButton.height >= 40, JSON.stringify(linkButton))
  await pshot('menu')
  await phone.tap('#share-link')
  await phone.waitForSelector('#search-input', { state: 'visible' })
  await phone.fill('#search-input', 'Lisbon')
  await phone.waitForTimeout(700)
  await pshot('picker')
  await phone.locator('.omni-row', { hasText: 'Lisbon trip' }).first().tap()
  await phone.waitForTimeout(900)
  const phoneCards = await pcards()
  const phoneView = await ppn(() => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); const v = window.__personalNote.leaferCanvas().view(); return { centre: window.__personalNote.leaferCanvas().pageAt(r.left + r.width / 2, r.top + r.height / 2), v, width: r.width } })
  const newest = phoneCards.at(-1)
  check('phone: picking a note puts a card in the middle of the view', phoneCards.length === hubCardsBefore + 1 && newest.title === 'Lisbon trip' && Math.abs(newest.x + newest.w / 2 - phoneView.centre.x) < 40, JSON.stringify([newest, phoneView]))
  await pshot('card')
  const phoneCardWindow = await ppn((card) => { const view = window.__personalNote.leaferCanvas().view(); const rect = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: rect.left + view.x + (card.x + card.w * 0.6) * view.scale, y: rect.top + view.y + (card.y + card.h / 2) * view.scale } }, newest)
  await phone.touchscreen.tap(phoneCardWindow.x, phoneCardWindow.y)
  const lisbonId = (await noteByTitle('Lisbon trip')).id
  await phone.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, lisbonId, { timeout: 10000 }).catch(() => {})
  check('phone: tapping the card opens the linked note', (await ppn(() => window.__personalNote.state.activeNoteId)) === lisbonId)

  // on a page note: the menu pick inserts a link at the caret, and tapping it opens the note
  await phone.waitForSelector('.page-host:not([hidden]) .cm-content')
  await phone.tap('#share-button')
  await phone.tap('#share-link')
  await phone.waitForSelector('#search-input', { state: 'visible' })
  await phone.fill('#search-input', 'Hub')
  await phone.waitForTimeout(700)
  await phone.locator('.omni-row', { hasText: 'Hub' }).first().tap()
  await phone.waitForTimeout(1500)
  const pageMd = (await full('Lisbon trip')).content.markdown
  check('phone: on a page the pick becomes a link in the text', pageMd.includes(`[Hub](personal-note://note/${phoneHub.resourceId})`), JSON.stringify(pageMd))
  await pshot('page-link')
  await phone.locator('.page-note-link').first().tap()
  await phone.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, phoneHub.id, { timeout: 10000 }).catch(() => {})
  check('phone: tapping the link in the page opens the note', (await ppn(() => window.__personalNote.state.activeNoteId)) === phoneHub.id)

  // Done on a phone: on screen, finger-sized, and clear of the title pill
  const phoneBookmark = (await call('GET', '/notes')).filter((note) => note.title.startsWith('@bob: ')).sort((a, b) => a.id - b.id)[0]
  await ppn((id) => window.__personalNote.selectNote(id), phoneBookmark.id)
  await phone.waitForSelector('.x-done:not([hidden])', { timeout: 10000 })
  await phone.waitForTimeout(400)
  const phoneDone = await phone.locator('.x-done').boundingBox()
  const pill = await phone.locator('#share-button').boundingBox()
  await pshot('done')
  const phoneDock = await phone.evaluate(() => { const r = document.querySelector('.tool-dock')?.getBoundingClientRect(); return r ? { top: r.top } : null })
  const doneTop = await phone.evaluate(() => { const r = document.querySelector('.x-done').getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.x-done') !== null })
  check('phone: Done is on screen, at least 44px tall, and nothing covers it or the title', phoneDone && phoneDone.x + phoneDone.width <= 390 && phoneDone.y + phoneDone.height <= 844 && phoneDone.height >= 44 && doneTop && (phoneDone.y > pill.y + pill.height), JSON.stringify([phoneDone, pill, phoneDock]))
  await phone.locator('.x-done').tap()
  await phone.waitForTimeout(1200)
  const movedTo = (await call('GET', '/notes')).find((note) => note.id === phoneBookmark.id)?.notebookId
  const archivedBook = (await call('GET', '/notebooks')).find((book) => book.id === movedTo)
  check('phone: one tap archives it', archivedBook?.name === 'X bookmarks done')

  // drag from the panel on a narrow window: the panel slides away so the note is under the pointer to drop on
  await phoneContext.close()
  const narrow = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const narrowPage = await narrow.newPage()
  await narrowPage.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await narrowPage.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
  const hubNote = await noteByTitle('Hub')
  await narrowPage.evaluate((id) => window.__personalNote.selectNote(id), hubNote.id)
  await narrowPage.waitForTimeout(700)
  await narrowPage.click('#toggle-sidebar')
  await narrowPage.waitForTimeout(500)
  const readingRow = narrowPage.locator('.note-list-item', { hasText: 'Lisbon trip' })
  if (!(await readingRow.count())) { await narrowPage.locator('[data-notebook-select]', { hasText: 'Travel' }).first().click(); await narrowPage.waitForTimeout(400) }
  const rowBox = await narrowPage.locator('.note-list-item', { hasText: 'Lisbon trip' }).first().boundingBox()
  const cardsBefore = (await narrowPage.evaluate(() => window.__personalNote.leaferCanvas().document().objects.filter((o) => o.type === 'notelink').length))
  await narrowPage.mouse.move(rowBox.x + 30, rowBox.y + rowBox.height / 2)
  await narrowPage.mouse.down()
  await narrowPage.mouse.move(rowBox.x + 60, rowBox.y + rowBox.height / 2 + 6, { steps: 4 })
  await narrowPage.mouse.move(370, 420, { steps: 12 }) // past the panel's edge, over the dimmed note
  await narrowPage.waitForTimeout(500)
  const panelOpenDuringDrag = await narrowPage.evaluate(() => document.querySelector('#sidebar').classList.contains('open'))
  await narrowPage.mouse.move(200, 500, { steps: 8 })
  await narrowPage.waitForTimeout(200)
  await narrowPage.mouse.up()
  await narrowPage.waitForTimeout(900)
  const cardsAfter = (await narrowPage.evaluate(() => window.__personalNote.leaferCanvas().document().objects.filter((o) => o.type === 'notelink').length))
  check('narrow window: dragging a row past the panel slides it away and the drop lands a card', !panelOpenDuringDrag && cardsAfter === cardsBefore + 1, `open during drag ${panelOpenDuringDrag}; cards ${cardsBefore} -> ${cardsAfter}`)
  if (shotBase) await narrowPage.screenshot({ path: shotBase.replace('.png', '-narrow-drop.png') })
  check('no page errors on the phone', phoneErrors.length === 0, phoneErrors.join(' | '))
  await narrow.close()
  if (errors.length) console.log('page errors:', errors)
} finally {
  await browser?.close()
  await server.close()
  api.kill('SIGTERM')
  await sleep(500)
  fs.rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
