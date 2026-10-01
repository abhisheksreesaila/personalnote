// Drives the real app (Vite dev server, in-memory mocked /api) through the F-013 acceptance checks:
// instant pages and zoom, one settings entry, monospace default, Clear all with Undo.  node scripts/verify-snappy.mjs <shotsDir>
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const shots = process.argv[2] || path.join(os.tmpdir(), 'shots-f013')
fs.mkdirSync(shots, { recursive: true })
let stored = { version: '7.4.0', objects: [] }
let pageState = { columns: 1, rows: 1 }
let revision = 1
let saves = 0
let deleteCalls = 0
let deletedFirst = false
const now = new Date().toISOString()
const second = { id: 2, resourceId: 'res_second', revision: 1, noteType: 'canvas', title: 'Second', notebookId: 1, createdAt: now, updatedAt: now }
const summary = () => ({ id: 1, resourceId: 'res_note', revision, noteType: 'canvas', title: 'Objects', notebookId: 1, createdAt: now, updatedAt: now })
const notebooks = [{ id: 1, resourceId: 'res_nb', revision: 1, name: 'Bench', color: '#76669a', noteCount: 1 }]

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const baseUrl = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`) }

async function open(width = 1440, height = 900, skin = 'crayon') {
  stored = { version: '7.4.0', objects: [] }; pageState = { columns: 1, rows: 1 }; deleteCalls = 0; deletedFirst = false
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('page error:', error.message))
  page.on('console', (m) => { if (m.type() === 'error') console.error('console error:', m.text()) })
  await page.addInitScript((s) => localStorage.setItem('personal-note:skin', s), skin)
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const route_ = url.pathname.replace(/^\/api/, '')
    const method = route.request().method()
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (route_ === '/notebooks') return json(notebooks)
    if (route_ === '/notes') return json(deletedFirst ? [second] : [summary(), second])
    if (route_ === '/notes/2' && method === 'GET') return json({ ...second, content: { version: '7.4.0', objects: [] }, pageState: { columns: 1, rows: 1 } })
    if (route_ === '/notes/1' && method === 'DELETE') { deleteCalls += 1; deletedFirst = true; return route.fulfill({ status: 204 }) }
    if (route_ === '/notes/1' && method === 'GET') return json({ ...summary(), content: stored, pageState })
    if (route_ === '/notes/1' && method === 'PUT') {
      const body = JSON.parse(route.request().postData())
      stored = body.content; pageState = body.pageState; revision += 1; saves += 1
      return json({ ...summary() })
    }
    return json([])
  })
  await page.goto(new URL('notes', baseUrl).href)
  await page.waitForFunction(() => window.__personalNote?.canvas && document.querySelector('.note-list-item.active'), null, { timeout: 30000 })
  await page.waitForTimeout(900)
  return { context, page }
}

const objects = (page) => page.evaluate(() => window.__personalNote.canvas.getObjects().map((o) => ({ type: o.type[0].toUpperCase() + o.type.slice(1), text: o.text, id: o.semanticId, stickyColor: o.stickyColor, fill: o.fill, rx: o.rx, w: o.width, h: o.height })))
const toClient = (page, x, y) => page.evaluate(([px, py]) => {
  const { canvas } = window.__personalNote
  const v = canvas.viewportTransform
  const r = canvas.upperCanvasEl.getBoundingClientRect()
  return { x: r.left + px * v[0] + v[4], y: r.top + py * v[3] + v[5] }
}, [x, y])
const click = async (page, x, y) => { const c = await toClient(page, x, y); await page.mouse.click(c.x, c.y); await page.waitForTimeout(300) }
const flush = async (page) => { await page.waitForTimeout(700) }


async function typeNote(page, x, y, text) {
  await page.click('[data-tool="text"]')
  await click(page, x, y)
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
}

{
  const { context, page } = await open()
  await page.click('[data-tool="text"]')
  await typeNote(page, 100, 100, 'first')
  await typeNote(page, 100, 300, 'second')
  const mono = await page.evaluate(() => window.__personalNote.canvas.getObjects().map((o) => o.fontFamily))
  check('new text defaults to Geist Mono with a monospace fallback', mono.length === 2 && mono.every((f) => f === '"Geist Mono", monospace'), JSON.stringify(mono))
  const choice = await page.evaluate(() => document.querySelector('#font-family-control .active')?.dataset.fontFamily)
  check('the typography control shows Monospace as the active choice', choice === 'monospace', choice)

  // pages appear and fold instantly
  const grow = await page.evaluate(() => {
    const { canvas, reconcilePages, pageExtents, pageExtentsTarget } = window.__personalNote
    const object = canvas.getObjects()[0]
    object.set({ left: 850 }); object.setCoords()
    reconcilePages()
    const grown = { now: { ...pageExtents() }, target: { ...pageExtentsTarget() } }
    object.set({ left: 100 }); object.setCoords()
    reconcilePages()
    const folded = { now: { ...pageExtents() }, target: { ...pageExtentsTarget() } }
    return { grown, folded }
  })
  check('a second page appears on the same tick, with no growth animation', grow.grown.now.right === grow.grown.target.right && grow.grown.target.right > 860, JSON.stringify(grow.grown))
  check('the page folds away on the same tick', grow.folded.now.right === grow.folded.target.right && grow.folded.target.right === 860, JSON.stringify(grow.folded))

  // zoom, fit, reset: the view has moved by the time the click returns
  const views = await page.evaluate(() => {
    const { getCanvasScale } = window.__personalNote
    const out = {}
    const start = getCanvasScale()
    document.querySelector('#zoom-in').click(); out.zoomIn = getCanvasScale() > start
    const zoomed = getCanvasScale()
    document.querySelector('#zoom-fit').click(); out.fit = getCanvasScale()
    document.querySelector('#zoom-value').click(); out.reset = getCanvasScale()
    out.changed = out.fit !== zoomed || out.reset !== out.fit
    return out
  })
  check('zoom in, zoom to fit and reset all land instantly', views.zoomIn && views.changed, JSON.stringify(views))

  // one settings entry point
  const entry = await page.evaluate(() => ({ gear: Boolean(document.querySelector('#rail-settings')), panel: Boolean(document.querySelector('#settings-panel')) }))
  check('the sidebar gear and the separate settings panel are gone', !entry.gear && !entry.panel, JSON.stringify(entry))
  await page.click('#top-properties')
  await page.waitForTimeout(450)
  const panel = await page.evaluate(() => {
    const el = document.querySelector('#properties-panel')
    return { open: el.classList.contains('open'), typography: Boolean(el.querySelector('#font-family-control')), defaults: Boolean(el.querySelector('[data-default-font-family]')), modules: Boolean(el.querySelector('#settings-mindmap')), del: Boolean(el.querySelector('#delete-note')), clearInside: Boolean(el.querySelector('#clear-note')) }
  })
  check('the top-right panel holds note properties and workspace settings', panel.open && panel.typography && panel.defaults && panel.modules && panel.del && !panel.clearInside, JSON.stringify(panel))
  await page.screenshot({ path: path.join(shots, 'settings-panel-desktop.png') })
  await page.click('#close-properties')
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(shots, 'topbar-desktop.png'), clip: { x: 700, y: 0, width: 740, height: 70 } })

  // Clear all: one click, toast with Undo, Ctrl+Z too
  const count = () => page.evaluate(() => window.__personalNote.canvas.getObjects().length)
  await page.click('#clear-note')
  await page.waitForTimeout(300)
  const toast = await page.evaluate(() => ({ visible: !document.querySelector('#toast').hidden, text: document.querySelector('#toast').innerText }))
  check('Clear all clears at once and shows "Note cleared · Undo"', (await count()) === 0 && toast.visible && /Note cleared/.test(toast.text) && /Undo/.test(toast.text), JSON.stringify(toast))
  await page.screenshot({ path: path.join(shots, 'toast-desktop.png') })
  await page.click('#toast-action')
  await page.waitForTimeout(500)
  check('Undo in the toast brings the note back', (await count()) === 2, String(await count()))
  await page.click('#clear-note')
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(500)
  check('Ctrl+Z also undoes Clear all', (await count()) === 2, String(await count()))
  check('there is no confirmation dialog', await page.evaluate(() => !document.querySelector('#clear-note-dialog')))
  await context.close()
}

{
  const { context, page } = await open()
  // typography controls show the real default on first open
  const active = await page.evaluate(() => ({ note: document.querySelector('#font-family-control .active')?.dataset.fontFamily, def: document.querySelector('[data-default-font-family].active')?.dataset.defaultFontFamily, label: document.querySelector('#top-properties').getAttribute('aria-label'), title: document.querySelector('#top-properties').title }))
  check('typography controls show Monospace active on first open', active.note === 'monospace' && active.def === 'monospace', JSON.stringify(active))
  check('the top-right button is labelled "Settings and properties"', active.title === 'Settings and properties' && active.label === 'Open settings and properties', JSON.stringify(active))
  const texts = () => page.evaluate(() => window.__personalNote.canvas.getObjects().map((o) => o.text))
  const toastHidden = () => page.evaluate(() => document.querySelector('#toast').hidden)

  // Clear straight after typing keeps the last edit, in the note and in what is saved
  await typeNote(page, 100, 100, 'first')
  await page.click('[data-tool="text"]')
  await click(page, 100, 300)
  await page.keyboard.type('fresh')
  await page.click('#clear-note')
  await page.waitForTimeout(1200)
  check('Clear all saves an empty note', stored.objects.length === 0, JSON.stringify(stored.objects.map((o) => o.text)))
  await page.click('#toast-action')
  await page.waitForTimeout(1200)
  const back = await texts()
  check('Undo after clear-right-after-typing restores the last edit too', back.includes('first') && back.includes('fresh'), JSON.stringify(back))
  check('the restored note is what gets saved', stored.objects.map((o) => o.text).sort().join() === 'first,fresh', JSON.stringify(stored.objects.map((o) => o.text)))

  // Ctrl+Z after clear-then-edit is a normal undo, not swallowed
  await page.click('#clear-note')
  await page.waitForTimeout(300)
  await typeNote(page, 200, 200, 'after')
  await page.waitForTimeout(500)
  check('editing after Clear all dismisses the Undo toast', await toastHidden())
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(500)
  const afterZ = await texts()
  check('Ctrl+Z after clear-then-edit undoes the edit', !afterZ.includes('after'), JSON.stringify(afterZ))
  await context.close()
}

{
  // Delete note: gone at once, Undo for 8s, the real delete waits
  const { context, page } = await open()
  const listed = () => page.evaluate(() => [...document.querySelectorAll('.note-list-item')].map((n) => n.textContent.trim()))
  const deleteIt = async () => { await page.click('#top-properties'); await page.waitForTimeout(450); await page.click('#delete-note'); await page.waitForTimeout(400) }
  await deleteIt()
  const gone = await listed()
  const toast = await page.evaluate(() => ({ visible: !document.querySelector('#toast').hidden, text: document.querySelector('#toast').innerText }))
  check('Delete note removes the note at once and shows "Note deleted · Undo"', !gone.some((t) => t.includes('Objects')) && toast.visible && /Note deleted/.test(toast.text) && deleteCalls === 0, JSON.stringify({ gone, toast, deleteCalls }))
  await page.click('#toast-action')
  await page.waitForTimeout(800)
  check('Undo brings the note back and never deletes it', (await listed()).some((t) => t.includes('Objects')) && deleteCalls === 0, `calls ${deleteCalls}`)
  await page.waitForTimeout(8600)
  check('an undone delete is never sent', deleteCalls === 0, `calls ${deleteCalls}`)
  await deleteIt()
  await page.waitForTimeout(8600)
  check('the delete is sent once the toast expires', deleteCalls === 1, `calls ${deleteCalls}`)
  await context.close()
}

{
  const { context, page } = await open()
  await page.click('#top-properties'); await page.waitForTimeout(450); await page.click('#delete-note'); await page.waitForTimeout(400)
  check('the delete is still held after a moment', deleteCalls === 0)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await page.waitForTimeout(500)
  check('closing the page sends the held delete', deleteCalls === 1, `calls ${deleteCalls}`)
  await context.close()
}

{
  const { context, page } = await open()
  await page.click('#top-properties'); await page.waitForTimeout(450); await page.click('#delete-note'); await page.waitForTimeout(400)
  const flushed = await page.evaluate(() => window.personalNote.flush())
  check('the desktop close flush also sends the held delete', flushed === true && deleteCalls === 1, `calls ${deleteCalls}`)
  await context.close()
}

{
  // a fast switch to another note must not drop the edit just made
  const { context, page } = await open()
  await page.click('[data-tool="text"]')
  await click(page, 100, 100)
  await page.keyboard.type('quick edit')
  await page.keyboard.press('Escape')
  await page.evaluate(() => [...document.querySelectorAll('.note-list-item')].find((n) => n.textContent.includes('Second')).click())
  await page.waitForTimeout(1500)
  check('the outgoing note was saved before the switch', stored.objects.some((o) => o.text === 'quick edit'), JSON.stringify(stored.objects.map((o) => o.text)))
  await page.evaluate(() => [...document.querySelectorAll('.note-list-item')].find((n) => n.textContent.includes('Objects')).click())
  await page.waitForTimeout(1200)
  const back = await page.evaluate(() => window.__personalNote.canvas.getObjects().map((o) => o.text))
  check('switching back shows the edit', back.includes('quick edit'), JSON.stringify(back))
  await context.close()
}

{
  const { context, page } = await open(390, 844)
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(shots, 'phone.png') })
  await page.click('#top-properties')
  await page.waitForTimeout(450)
  await page.screenshot({ path: path.join(shots, 'settings-panel-phone.png') })
  await context.close()
}

await browser.close()
await server.close()
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `${failed.length} FAILED` : `${results.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
