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
    const before = await page.locator('#plugin-mindmap').count()
    await page.locator('#plugin-mindmap').waitFor({ timeout: 15000 })
    check('Settings opened before the optional code arrived fills in (Plugins rows and the AI section) when it does', before === 0 && await page.locator('#ai-settings').isVisible() && errors.length === 0, errors.join())
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
    await page.locator('#plugin-mindmap').waitFor({ timeout: 15000 })
    await page.click('#voice-button')
    await page.locator('#voice-caption').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    check('after Reload Settings is filled in and the mic works', await page.locator('#voice-caption').evaluate((e) => !e.hidden))
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
