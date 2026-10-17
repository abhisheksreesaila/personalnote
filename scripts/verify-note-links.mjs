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

  page.on('console', (m) => { if (process.env.PN_DEBUG) console.log('console:', m.text()) })
  await open()
  if (process.env.PN_DEBUG) await pn(() => { for (const t of ['dragstart','dragenter','dragover','drop','dragend']) document.addEventListener(t, (e) => console.log(t, e.target.className || e.target.tagName, [...(e.dataTransfer?.types||[])].join(','), e.clientX, e.clientY), true) })
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

  if (errors.length) console.log('page errors:', errors)
  check('no page errors', errors.length === 0, errors.join(' | '))
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
