// F-097: the first screen paints with core code only; optional plugin code arrives after it. Real production build (dist/) served by the real
// API on PN_VERIFY_PORT (never 3137), headless Chromium, scratch database and plugins folder.
//   npm run build && PN_VERIFY_PORT=4930 node scripts/verify-first-screen.mjs
//   PN_ROOT=/path/to/another/checkout (built) measures that checkout instead (used for the "before" numbers); PN_RUNS=9 sets the timing runs;
//   PN_THROTTLE=4 slows the CPU 4x in the timing runs. Checks: plugin chunks are not requested before the first screen and do arrive after it;
//   the mic clicked right at load still starts; a mind map opened right at load still opens; with Voice and Search by meaning off nothing of them loads.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const PORT = basePort(4930)
await assertPortsFree([PORT])
const ROOT = path.resolve(process.env.PN_ROOT || '.')
const RUNS = Number(process.env.PN_RUNS || 9)
const THROTTLE = Number(process.env.PN_THROTTLE || 1)
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-first-'))
const pluginsDir = path.join(scratch, 'plugins')
const python = path.resolve(fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : '../../../.venv/bin/python')
const env = { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db'), PERSONAL_NOTE_PLUGINS_DIR: pluginsDir }
const BASE = `http://127.0.0.1:${PORT}`
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(PORT)], { cwd: ROOT, env, stdio: process.env.PN_DEBUG ? 'inherit' : 'ignore' })
// Stop the API this script started (and only it) however the script ends: normal exit, a closed output pipe, Ctrl-C or SIGTERM.
const stopApi = () => { try { api.kill() } catch {} }
process.on('exit', stopApi)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopApi(); process.exit(1) })
process.stdout.on('error', () => { stopApi(); process.exit(1) }) // EPIPE: whoever was reading our output has gone
const call = async (method, url, body) => { const r = await fetch(`${BASE}/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
const up = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
// The code that belongs to an optional plugin or to the settings panels (chunk names of the production build).
const LATE = /\/assets\/(voice-plugin|meaning-plugin|jam-plugin|settings-panels)-[^/]*\.js/
// The first screen, measured from outside so the same definition works on any build: the open note's title is the newest note's, the notes list has
// rows (`__seen`), and two frames later it has been drawn (`__firstScreen`, the time reported).
const WATCH = `(() => { const t = () => { const title = document.querySelector('#note-title'); const rows = document.querySelector('#notebook-navigator')?.children.length
  if (title && title.value === 'Plain note' && rows) { window.__seen = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => { window.__firstScreen = performance.now() })) } else requestAnimationFrame(t) }; requestAnimationFrame(t) })()`
let browser
try {
  await up()
  const MAP = { version: 1, title: 'Trip map', rootId: 'r', defaultPresentation: 'box', nodes: [
    { id: 'r', parentId: null, text: 'Trip', x: 0, y: 0, color: '#ef684b', fontSize: 28, bold: true, font: 'hand', presentation: 'box', curve: 78 },
    { id: 'a', parentId: 'r', text: 'Flights', x: 220, y: -60, color: '#3a7bd5', fontSize: 20, bold: false, font: 'hand', presentation: 'box', curve: 78 } ] }
  const made = (await call('POST', '/notes', { title: 'Trip map', noteType: 'mindmap' })).body
  await call('PUT', `/notes/${made.id}`, { title: 'Trip map', content: MAP, revision: made.revision })
  await call('POST', '/notes', { title: 'Plain note' }) // the newest note opens first, so the map is not the first screen
  await call('POST', '/plugins/voice', { enabled: true }); await call('POST', '/plugins/meaning', { enabled: true })
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const newPage = async (viewport = { width: 1360, height: 900 }, throttle = 1) => {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    if (throttle > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle })
    await page.addInitScript(WATCH)
    return page
  }
  const lateRequests = (page) => page.evaluate((source) => performance.getEntriesByType('resource').filter((e) => new RegExp(source).test(e.name)).map((e) => ({ name: e.name.split('/').pop(), start: e.startTime })), LATE.source)

  // ---- timing and ordering: the notes list leads, the plugin code follows
  const times = []
  let ordered = true; let arrived = true; let sample = ''; let violation = ''
  for (let i = 0; i < RUNS; i++) {
    const page = await newPage(undefined, THROTTLE)
    await page.goto(`${BASE}/notes`)
    await page.waitForFunction(() => window.__firstScreen, null, { timeout: 60000 })
    const first = await page.evaluate(() => window.__firstScreen)
    const seen = await page.evaluate(() => window.__seen)
    times.push(first)
    await page.waitForTimeout(4000) // idle time: the plugin code is fetched in here, with no click
    const late = await lateRequests(page)
    if (late.some((r) => r.start < seen)) ordered = false
    if (late.some((r) => r.start < seen)) violation = late.map((r) => `${r.name}@${Math.round(r.start)}ms`).join(' ') + ` (first screen ${Math.round(seen)}ms)`
    if (!late.some((r) => /voice-plugin/.test(r.name)) || !late.some((r) => /meaning-plugin/.test(r.name))) arrived = false
    sample = late.map((r) => `${r.name}@${Math.round(r.start)}ms`).join(' ') + ` (first screen ${Math.round(seen)}ms)`
    await page.context().close()
  }
  console.log(`INFO  first screen over ${RUNS} runs${THROTTLE > 1 ? ` at ${THROTTLE}x CPU slowdown` : ''}: median ${Math.round(median(times))} ms, min ${Math.round(Math.min(...times))}, max ${Math.round(Math.max(...times))}  [${times.map(Math.round).join(', ')}]`)
  console.log(`INFO  last run: ${sample}`)
  check('plugin and settings-panel code is not requested before the first screen is drawn', ordered, violation)
  check('and it arrives after it (Voice and Search by meaning chunks loaded without any click)', arrived, sample)

  // ---- the mic, clicked the moment it shows (desktop and phone width)
  for (const [label, viewport, selector] of [['desktop', { width: 1360, height: 900 }, '#voice-button'], ['phone', { width: 390, height: 780 }, '#mobile-speak']]) {
    const page = await newPage(viewport)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${BASE}/notes`)
    await page.locator(selector).waitFor({ state: 'visible', timeout: 30000 })
    const early = await page.evaluate(() => !performance.getEntriesByType('resource').some((e) => /voice-plugin/.test(e.name) && e.responseEnd > 0))
    if (label === 'phone') { // the phone's button is hold to speak
      const box = await page.locator(selector).boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
    } else await page.locator(selector).click()
    await page.locator('#voice-caption').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    const caption = await page.locator('#voice-caption').evaluate((e) => !e.hidden)
    if (label === 'phone') await page.mouse.up()
    check(`[${label}] the mic clicked as soon as it shows still starts (no lost click)${early ? ' (voice code had not arrived yet)' : ''}`, caption && errors.length === 0, errors.join())
    await page.context().close()
  }

  // ---- a mind map opened right at load
  {
    const page = await newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${BASE}/notes`)
    await page.locator('#toggle-sidebar').waitFor()
    if ((await page.locator('#toggle-sidebar').getAttribute('aria-expanded')) !== 'true') await page.click('#toggle-sidebar')
    await page.getByText('Trip map').first().click({ timeout: 30000 })
    await page.locator('.mindmap-host svg').first().waitFor({ timeout: 20000 })
    const words = await page.locator('.mindmap-host').textContent()
    check('a mind map opened right at load waits for its editor and opens, with its words', /Flights/.test(words) && errors.length === 0, errors.join() || words)
    await page.context().close()
  }

  // ---- Settings and the omnibar used while the optional code is still on its way (the settings chunk is held back for 2.5 s)
  const openSettings = async (page) => { if (!(await page.locator('#top-properties').isVisible())) await page.click('#share-button'); await page.click('#top-properties') }
  const slowPanels = (page) => page.route(/\/assets\/settings-panels-[^/]*\.js/, async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue() })
  {
    const page = await newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await slowPanels(page)
    await page.goto(`${BASE}/notes`)
    await page.waitForFunction(() => window.__firstScreen, null, { timeout: 60000 })
    await openSettings(page)
    await page.waitForTimeout(400)
    const before = await page.locator('#plugin-mindmap').count()
    const openAtOnce = await page.locator('#properties-panel .properties-heading h2').isVisible() // (the window is there with its title while the section list is still on its way)
    await page.locator('#plugin-mindmap').waitFor({ state: 'attached', timeout: 15000 })
    await page.locator('.sw-item').first().waitFor({ timeout: 15000 })
    await page.click('.sw-item[data-sw-item="ai"]')
    check('Settings opened before the optional code arrived is a window at once and fills in (section list, Plugins rows, the AI section) when it does', openAtOnce && before === 0 && await page.locator('#ai-provider').isVisible() && await page.locator('#ai-test').isVisible() && errors.length === 0, errors.join())
    await page.context().close()
  }
  {
    const page = await newPage()
    await slowPanels(page)
    await page.goto(`${BASE}/notes`)
    await page.waitForFunction(() => window.__firstScreen, null, { timeout: 60000 })
    await page.click('#search-button')
    await page.fill('#search-input', 'Plain')
    await page.locator('#search-results .search-result', { hasText: 'Plain note' }).first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(3500) // the optional code has now arrived: the bar still shows what was typed and its results
    check('the omnibar typed in before the optional code arrived keeps its text and results when it does',
      (await page.inputValue('#search-input')) === 'Plain' && await page.locator('#search-results .search-result', { hasText: 'Plain note' }).count() > 0)
    await page.context().close()
  }

  // ---- a load that fails (the settings chunk answers with an error once) says so, in plain words, and Reload brings everything back
  {
    const page = await newPage()
    let failed = 0
    await page.route(/\/assets\/settings-panels-[^/]*\.js/, async (route) => { if (failed++ === 0) await route.abort(); else await route.continue() })
    await page.goto(`${BASE}/notes`)
    await page.locator('#toast').waitFor({ state: 'visible', timeout: 20000 })
    const said = await page.locator('#toast').textContent()
    check('a chunk that fails to load is said on screen in plain words, with a Reload button', /did not load/.test(said) && /Reload/.test(said), said)
    await Promise.all([page.waitForNavigation(), page.click('#toast-action')])
    await page.locator('#voice-button').waitFor({ state: 'visible', timeout: 15000 })
    await openSettings(page)
    await page.locator('#plugin-mindmap').waitFor({ state: 'attached', timeout: 15000 })
    await page.click('#voice-button')
    await page.locator('#voice-caption').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    check('after Reload Settings is filled in and the mic works', await page.locator('#voice-caption').evaluate((e) => !e.hidden))
    await page.context().close()
  }

  // ---- F-098: the canvas engine (Leafer) is a chunk of its own that arrives after the notes panel and the title; held back 2 s here
  const slowEngine = (page) => page.route(/\/assets\/canvas-leafer-[^/]*\.js/, async (route) => { await new Promise((r) => setTimeout(r, 2000)); await route.continue() })
  {
    const page = await newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await slowEngine(page)
    await page.goto(`${BASE}/notes`)
    await page.waitForFunction(() => window.__firstScreen, null, { timeout: 60000 })
    const early = await page.evaluate(() => ({ canvases: document.querySelectorAll('#leafer-host canvas').length, title: document.querySelector('#note-title').value, island: document.querySelector('#island-title').textContent }))
    check('the notes list and the open note\'s title are drawn before the canvas engine arrives (no canvas yet)', early.canvases === 0 && early.title === 'Plain note' && early.island === 'Plain note', JSON.stringify(early))
    await page.locator('#leafer-host canvas').first().waitFor({ state: 'attached', timeout: 20000 })
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 20000 })
    check('and the canvas fills in when it does, without errors', errors.length === 0, errors.join())
    await page.context().close()
  }
  {
    // a press on the page before the engine is there is held and placed at the same spot once it is: the words typed after it land in a text there
    const page = await newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await slowEngine(page)
    await page.goto(`${BASE}/notes`)
    await page.waitForFunction(() => window.__firstScreen, null, { timeout: 60000 })
    const press = { x: 640, y: 420 }
    await page.mouse.click(press.x, press.y)
    const editor = page.locator('.leafer-text-editor')
    await editor.first().waitFor({ state: 'attached', timeout: 20000 })
    await page.waitForFunction(() => document.activeElement?.classList.contains('leafer-text-editor'), null, { timeout: 20000 }) // (the caret is in: a person types when they see it)
    await page.keyboard.type('held press')
    const box = await editor.first().boundingBox()
    const text = await editor.first().inputValue()
    const near = box && Math.abs(box.x - press.x) < 120 && Math.abs(box.y - press.y) < 120
    check('a press on the page before the canvas engine arrives is placed there when it does, and typing goes into it', near && /held press/.test(text) && errors.length === 0, `${JSON.stringify(box)} ${text} ${errors.join()}`)
    await page.context().close()
  }

  {
    // a held sticky is placed (the tool picked before the engine arrived is what the press places)
    const page = await newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await slowEngine(page)
    await page.goto(`${BASE}/notes`)
    await page.waitForFunction(() => window.__firstScreen, null, { timeout: 60000 })
    await page.click('[data-tool="sticky"]')
    await page.mouse.click(640, 420)
    const plain = (await call('GET', '/notes')).body.find((n) => n.title === 'Plain note')
    let saved = ''
    for (let i = 0; i < 40 && !/sticky/.test(saved); i++) { await page.waitForTimeout(300); saved = JSON.stringify((await call('GET', `/notes/${plain.id}`)).body.content ?? '') }
    check('a sticky pressed on the page before the canvas engine arrives is placed (and saved) when it does', /sticky/.test(saved) && errors.length === 0, `${saved.slice(0, 120)} ${errors.join()}`)
    await page.context().close()
  }
  {
    // a press held for the note being opened is dropped when another note is picked: nothing lands in it, or in the note picked after
    const page = await newPage()
    await page.addInitScript(() => localStorage.setItem('pn.notesPanelOpen', '1'))
    await slowEngine(page)
    await page.goto(`${BASE}/notes`)
    await page.waitForFunction(() => window.__firstScreen, null, { timeout: 60000 })
    await page.mouse.click(900, 300)
    await page.getByText('Trip map').first().click()
    await page.locator('.mindmap-host svg').first().waitFor({ timeout: 25000 })
    await page.waitForTimeout(500)
    await page.locator('[data-note-id]', { hasText: 'Plain note' }).first().click()
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled && document.querySelector('#note-title').value === 'Plain note', null, { timeout: 25000 })
    await page.waitForTimeout(1500) // (the note opens ready for writing; whatever it opens is not under the press)
    const near = await page.locator('.leafer-text-editor').evaluateAll((els, p) => els.some((e) => { const r = e.getBoundingClientRect(); return Math.abs(r.x - p.x) < 150 && Math.abs(r.y - p.y) < 150 }), { x: 900, y: 300 })
    check('a press made while one note loads does not land in the note picked after it (nothing is written under the press)', !near)
    await page.context().close()
  }
  {
    // the title cannot be typed into while the engine is awaited (the words would be overwritten and unsaved); it can once the note is drawn, and is saved
    const page = await newPage()
    await slowEngine(page)
    await page.goto(`${BASE}/notes`)
    await page.waitForFunction(() => window.__firstScreen, null, { timeout: 60000 })
    const readOnly = await page.locator('#note-title').evaluate((e) => e.readOnly)
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 25000 })
    await page.waitForFunction(() => !document.querySelector('#note-title').readOnly, null, { timeout: 10000 })
    await page.click('#share-button')
    await page.locator('#note-title').fill('Plain note renamed')
    let name = ''
    for (let i = 0; i < 30 && name !== 'Plain note renamed'; i++) { await page.waitForTimeout(300); name = (await call('GET', '/notes')).body.find((n) => /Plain note/.test(n.title))?.title }
    check('the title is read-only until the note is drawn, then it takes typing and saves it', readOnly && name === 'Plain note renamed', `${readOnly} ${name}`)
    const note = (await call('GET', '/notes')).body.find((n) => n.title === 'Plain note renamed')
    await call('PUT', `/notes/${note.id}`, { title: 'Plain note', revision: note.revision })
    await page.context().close()
  }
  {
    // nothing moves after the first paint: the title pill, the notes panel and its rows are where they were when the canvas arrives
    const page = await newPage()
    await page.addInitScript(() => localStorage.setItem('pn.notesPanelOpen', '1'))
    await slowEngine(page)
    await page.goto(`${BASE}/notes`)
    await page.waitForFunction(() => window.__firstScreen, null, { timeout: 60000 })
    const rects = () => page.evaluate(() => [...document.querySelectorAll('.sidebar, #notebook-navigator, #notebook-navigator *, .island, #island-title, .topbar, .topbar *')].map((e) => { const r = e.getBoundingClientRect(); return `${e.id || e.className || e.tagName}:${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}` }))
    // (this check is about the engine arriving: the web font has its own check below, so let it settle first)
    await page.waitForFunction(() => document.fonts.status === 'loaded' && [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Geist' && f.status === 'loaded'), null, { timeout: 5000 }).catch(() => console.log('note  the web font had not loaded after 5 s: a late font swap, not the engine, may move the layout below'))
    await page.waitForTimeout(400)
    const first = await rects()
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 25000 })
    await page.waitForTimeout(1500)
    const later = await rects()
    const moved = first.map((r, i) => r === later[i] ? null : `${r} -> ${later[i]}`).filter(Boolean)
    check('the title pill, top bar and notes panel do not move or change size after the first paint', first.length === later.length && first.length > 5 && moved.length === 0, moved.slice(0, +(process.env.PN_MOVED || 4)).join(' | '))
    await page.context().close()
  }
  {
    // F-099: the web font (Geist) arrives after the first paint, delayed here so the swap surely happens later: nothing in the notes panel or
    // the top bar changes size or place when it does (the fallback face carries Geist's metrics)
    const page = await newPage()
    await page.addInitScript(() => localStorage.setItem('pn.notesPanelOpen', '1'))
    await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue() })
    await page.goto(`${BASE}/notes`)
    await page.waitForFunction(() => window.__firstScreen, null, { timeout: 60000 })
    const geist = () => page.evaluate(() => [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Geist' && f.status === 'loaded').length)
    const rects = () => page.evaluate(() => [...document.querySelectorAll('.sidebar, .sidebar *, .island, .island *, .topbar, .topbar *')].map((e) => { const r = e.getBoundingClientRect(); return { name: `${e.id || e.className || e.tagName}[${String(e.textContent).replace(/\s+/g, ' ').slice(0, 14)}]`, x: r.x, y: r.y, w: r.width, h: r.height } }))
    const swappedBefore = await geist()
    const first = await rects()
    await page.waitForFunction(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Geist' && f.status === 'loaded'), null, { timeout: 20000 }).catch(() => {})
    const swappedAfter = await geist()
    await page.waitForTimeout(500)
    const later = await rects()
    // Nothing may jump up or down or change height (a line of text that grows pushes what is below it). A word is a few pixels wider in a
    // different face whatever the metrics, so across the swap x and width may differ by up to 2 px (the face's own letter widths), no more.
    const moved = first.map((r, i) => { const n = later[i]; return Math.abs(r.y - n.y) > 0.01 || Math.abs(r.h - n.h) > 0.01 || Math.abs(r.x - n.x) > 2 || Math.abs(r.w - n.w) > 2 ? `${r.name} ${r.x},${r.y},${r.w},${r.h} -> ${n.x},${n.y},${n.w},${n.h}` : null }).filter(Boolean)
    check('the notes panel and top bar do not jump or grow when the web font arrives after the first paint (the font did arrive later)', swappedBefore === 0 && swappedAfter > 0 && first.length === later.length && first.length > 20 && moved.length === 0, `${swappedBefore}->${swappedAfter} ${moved.slice(0, +(process.env.PN_MOVED || 4)).join(' | ')}`)
    await page.context().close()
  }
  {
    // the engine chunk answers with an error once: the notes list is still there, the failure is said in plain words, and Reload brings the canvas
    const page = await newPage()
    let failed = 0
    await page.route(/\/assets\/canvas-leafer-[^/]*\.js/, async (route) => { if (failed++ === 0) await route.abort(); else await route.continue() })
    await page.goto(`${BASE}/notes`)
    await page.locator('#toast').waitFor({ state: 'visible', timeout: 20000 })
    const said = await page.locator('#toast').textContent()
    check('a canvas engine that fails to load is said on screen in plain words, with a Reload button', /canvas did not load/.test(said) && /Reload/.test(said), said)
    await Promise.all([page.waitForNavigation(), page.click('#toast-action')])
    await page.locator('#leafer-host canvas').first().waitFor({ state: 'attached', timeout: 20000 })
    check('and after Reload the canvas is there', true)
    await page.context().close()
  }
  // ---- Voice and Search by meaning off: their code is never fetched, even after idle
  await call('POST', '/plugins/voice', { enabled: false }); await call('POST', '/plugins/meaning', { enabled: false })
  {
    const page = await newPage()
    await page.goto(`${BASE}/notes`)
    await page.waitForFunction(() => window.__firstScreen, null, { timeout: 60000 })
    await page.waitForTimeout(3000)
    const late = (await lateRequests(page)).filter((r) => /voice-plugin|meaning-plugin|jam-plugin/.test(r.name))
    check('with Voice and Search by meaning off, their code is never requested', late.length === 0, JSON.stringify(late))
    await page.context().close()
  }
} finally {
  await browser?.close()
  api.kill()
  fs.rmSync(scratch, { recursive: true, force: true })
}
process.exit(results.every(Boolean) ? 0 : 1)
