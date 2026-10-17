// F-090: built-in plugins in the real app. Vite dev server on PN_VERIFY_PORT (never 3137) with the real API on the next port, headless Chromium,
// a scratch database and a scratch plugins folder (PERSONAL_NOTE_PLUGINS_DIR), so the captain's settings are never touched.
// Mind maps on: the new-mind-map entry is there and a map opens in its editor. Switched off in Settings → Plugins: no entry in the new-note menu,
// the editor chunk is never requested (not even after a reload and opening a map), an existing map opens read-only as an outline with
// "Turn on Mind maps to edit", the server refuses a new map and keeps the old one untouched. "Turn on Mind maps" in that view brings the editor
// back without a reload, and an edit saves. F-091 adds Voice and Search by meaning: with each on, the mic / the "By meaning" group, their Settings
// rows and their code (voice-plugin, meaning-plugin chunks) are there; off from Settings they vanish at once; reloaded with both off, none of that code
// is requested and nothing is asked of /api/voice, /api/search-meaning or /api/search/meaning; on again without a reload brings them back.
// Phone width first, then desktop. The command line's side is tests/test_plugin_settings.py and tests/test_plugin_voice_meaning.py.
//   PN_VERIFY_PORT=4910 node scripts/verify-plugins.mjs        (PN_SHOT=/path/shot.png also saves pictures)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4910)
const API_PORT = UI_PORT + 1
await assertPortsFree([UI_PORT, API_PORT])
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-plugins-'))
const pluginsDir = path.join(scratch, 'plugins')
const savedChoice = () => { try { return JSON.parse(fs.readFileSync(path.join(pluginsDir, 'plugins.json'), 'utf8')) } catch { return null } }
const python = path.resolve(fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : fs.existsSync('../../../.venv/bin/python') ? '../../../.venv/bin/python' : 'python3')
const env = { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db'), PERSONAL_NOTE_PLUGINS_DIR: pluginsDir }
const API = `http://127.0.0.1:${API_PORT}`
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], { env, stdio: process.env.PN_DEBUG ? 'inherit' : 'ignore' })
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const call = async (method, url, body) => { const r = await fetch(`${API}/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
let browser
try {
  await apiUp()
  await server.listen()
  const MAP = { version: 1, title: 'Trip map', rootId: 'r', defaultPresentation: 'box', nodes: [
    { id: 'r', parentId: null, text: 'Trip', x: 0, y: 0, color: '#ef684b', fontSize: 28, bold: true, font: 'hand', presentation: 'box', curve: 78 },
    { id: 'a', parentId: 'r', text: 'Flights', x: 220, y: -60, color: '#3a7bd5', fontSize: 20, bold: false, font: 'hand', presentation: 'box', curve: 78 },
    { id: 'b', parentId: 'r', text: 'Food', x: 220, y: 60, color: '#3a7bd5', fontSize: 20, bold: false, font: 'hand', presentation: 'box', curve: 78 },
  ] }
  const made = await call('POST', '/notes', { title: 'Trip map', noteType: 'mindmap' })
  const put = await call('PUT', `/notes/${made.body.id}`, { title: 'Trip map', content: MAP, revision: made.body.revision })
  if (put.status !== 200) throw new Error('could not seed the map: ' + JSON.stringify(put))
  const map = { ...put.body, id: made.body.id }
  const plain = (await call('POST', '/notes', { title: 'Plain note' })).body
  const mapState = async () => (await call('GET', `/notes/${map.id}`)).body
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const errors = []
  for (const [label, viewport] of [['phone', { width: 390, height: 780 }], ['desktop', { width: 1360, height: 900 }]]) {
    await call('POST', '/plugins/mindmap', { enabled: true })
    const before = await mapState()
    const page = await (await browser.newContext({ viewport })).newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    let mapCode = []
    page.on('request', (request) => { if (/\/src\/mindmap\/|\/src\/modules\/mindmap\.js/.test(request.url())) mapCode.push(request.url()) })
    const shot = async (name) => { if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${label}-${name}.png`) }) }
    const open = async () => {
      await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
      await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
    }
    const pick = async (id) => { await page.evaluate((n) => window.__personalNote.selectNote(n), id); await page.waitForFunction((n) => window.__personalNote.state.activeNoteId === n && !window.__personalNote.state.loading, id, { timeout: 15000 }) }
    const settings = async () => {
      if (!(await page.locator('#properties-panel').evaluate((e) => e.classList.contains('open')))) { if (!(await page.locator('#top-properties').isVisible())) await page.click('#share-button'); await page.click('#top-properties'); await page.waitForTimeout(500) }
      await page.locator('#plugin-mindmap').waitFor()
    }
    // What a long press (right click) on the sidebar's New note button offers: [] when the menu does not open.
    const menuKinds = async () => {
      const wasOpen = (await page.locator('#toggle-sidebar').getAttribute('aria-expanded')) === 'true'
      if (!wasOpen) { await page.click('#toggle-sidebar'); await page.waitForTimeout(500) }
      await page.locator('#rail-new-note').click({ button: 'right' })
      await page.waitForTimeout(250)
      const shown = await page.locator('#note-create-menu').evaluate((e) => !e.hidden)
      const kinds = shown ? await page.locator('#note-create-menu [data-create-note-type]').evaluateAll((els) => els.map((e) => e.dataset.createNoteType)) : []
      if (shown) await page.keyboard.press('Escape')
      await page.mouse.click(viewport.width - 4, viewport.height - 4)
      if (!wasOpen && (await page.locator('#toggle-sidebar').getAttribute('aria-expanded')) === 'true') { await page.click('#toggle-sidebar'); await page.waitForTimeout(400) }
      return kinds
    }

    // ---- on (the default)
    await open()
    await settings()
    check(`[${label}] Settings → Plugins lists Mind maps with its description, "Nothing to download" and a switch that is on`,
      await page.locator('#plugin-mindmap').isChecked() && /Draw ideas as a branching map\. Nothing to download\./.test(await page.locator('#settings-plugins').textContent()))
    if (label === 'phone') {
      const row = await page.locator('#settings-plugins .setting-row').first().boundingBox()
      check('[phone] the switch row is at least 48px tall', row.height >= 48, JSON.stringify(row))
    }
    await shot('settings-on')
    check(`[${label}] on: the new-note menu offers Mind map`, (await menuKinds()).join() === 'canvas,mindmap')
    await pick(map.id)
    await page.waitForSelector('.mindmap-host:not([hidden]) svg', { timeout: 15000 })
    check(`[${label}] on: a map opens in its editor (the editor code was requested)`, mapCode.length > 0 && await page.locator('[data-map-action="zoom-in"]').count() > 0, JSON.stringify(mapCode))

    // ---- switch it off from Settings, with a map open
    await settings()
    await page.locator('#plugin-mindmap').uncheck()
    await page.locator('.mindmap-readonly').waitFor({ timeout: 10000 })
    check(`[${label}] off: the choice is kept on the machine`, JSON.stringify(savedChoice()) === '{"mindmap":false}' || savedChoice()?.mindmap === false, JSON.stringify(savedChoice()))
    check(`[${label}] off: the open map turns into a read-only outline with "Turn on Mind maps to edit"`,
      /Turn on Mind maps to edit/.test(await page.locator('.mindmap-readonly').textContent()) && (await page.locator('.mindmap-readonly li').allTextContents()).join('|').startsWith('Trip')
      && await page.locator('.mindmap-host svg').count() === 0 && await page.locator('#note-title').isEditable() === false)
    check(`[${label}] off: no editor tool pill is left on screen`, await page.locator('.tool-dock').evaluate((e) => getComputedStyle(e).display === 'none'))
    await shot('readonly')
    await pick(plain.id)
    check(`[${label}] off: a canvas note beside it still has its tools`, label === 'phone' || await page.locator('.tool-dock').evaluate((e) => getComputedStyle(e).display !== 'none'))
    await pick(map.id)

    // ---- off, fresh page: nothing of the plugin loads
    mapCode = []
    await open()
    await pick(plain.id)
    check(`[${label}] off: the new-note menu has no Mind map entry (the long press opens nothing)`, (await menuKinds()).length === 0)
    await pick(map.id)
    await page.locator('.mindmap-readonly').waitFor()
    const outline = await page.locator('.mindmap-readonly li').allTextContents()
    check(`[${label}] off: an existing map still lists and opens read-only, with its words`, outline.join('|').includes('Flights') && outline.join('|').includes('Food'), outline.join('|'))
    check(`[${label}] off: no request for the mind-map editor code after a reload and opening a map`, mapCode.length === 0, JSON.stringify(mapCode))
    const refused = await call('POST', '/notes', { title: 'No', noteType: 'mindmap' })
    check(`[${label}] off: the server refuses a new mind map and keeps the old one as it was`,
      refused.status === 409 && (await mapState()).revision === before.revision && (await mapState()).content.nodes.length === before.content.nodes.length, JSON.stringify(refused))
    await page.keyboard.type('xyz')
    await page.waitForTimeout(700)
    check(`[${label}] off: typing on the read-only map changes nothing`, (await mapState()).revision === before.revision && (await mapState()).title === 'Trip map')

    const puts = []
    page.on('request', (request) => { if (request.method() === 'PUT' && request.url().includes(`/api/notes/${map.id}`)) puts.push(request.url()) })
    await settings()
    await page.click('#download-backup')
    await page.locator('#portability-status').filter({ hasText: 'Export downloaded' }).waitFor({ timeout: 15000 }).catch(() => {})
    await pick(plain.id)
    await open()
    await pick(map.id)
    await page.locator('.mindmap-readonly').waitFor()
    check(`[${label}] off: exporting and leaving the read-only map send no save and leave its revision alone`, puts.length === 0 && (await mapState()).revision === before.revision, JSON.stringify(puts))

    // ---- on again, no restart
    mapCode = []
    await page.click('#mindmap-turn-on')
    await page.waitForSelector('.mindmap-host:not([hidden]) svg', { timeout: 15000 })
    check(`[${label}] on again from the button, no reload: the editor is back and was loaded now`, mapCode.length > 0 && await page.locator('.mindmap-readonly').count() === 0, JSON.stringify(mapCode))
    check(`[${label}] on again: the choice is kept`, savedChoice()?.mindmap === true)
    await page.waitForTimeout(500)
    await page.locator('.mindmap-host svg text', { hasText: 'Trip' }).first().click() // select the central idea
    await page.keyboard.press('Tab') // a new branch under the selected node
    await page.waitForTimeout(300)
    await page.keyboard.type('Hotels')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1800)
    const after = await mapState()
    check(`[${label}] on again: the map is editable and the edit saves`, after.content.nodes.length === before.content.nodes.length + 1 && after.content.nodes.filter((n) => n.text === 'Hotels').length === before.content.nodes.filter((n) => n.text === 'Hotels').length + 1 && after.content.nodes.some((n) => n.text === 'Flights'), JSON.stringify(after.content.nodes.map((n) => n.text)))
    check(`[${label}] on again: the new-note menu offers Mind map again`, (await menuKinds()).join() === 'canvas,mindmap')
    await shot('on-again')
    await page.context().close()
  }
  // ---- F-091: Voice and Search by meaning. The mic, the "By meaning" group and their Settings rows follow the switches; off loads and asks nothing.
  const voiceCode = /\/voice-plugin[-.]|\/src\/modules\/voice\/voice-plugin\.js/
  const meaningCode = /\/meaning-plugin[-.]|\/src\/modules\/search\/meaning-plugin\.js/
  const featureApi = /\/api\/(voice|search-meaning|search\/meaning)/
  for (const [label, viewport] of [['phone', { width: 390, height: 780 }], ['desktop', { width: 1360, height: 900 }]]) {
    await call('POST', '/plugins/voice', { enabled: true })
    await call('POST', '/plugins/meaning', { enabled: true })
    const page = await (await browser.newContext({ viewport })).newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    // A stand-in for an installed index, so the group can be seen: the real engine is a 315 MB download this check never makes.
    await page.route('**/api/search-meaning/status', (route) => route.fulfill({ json: { state: 'ready', index: { indexed: 2, total: 2, error: '', failed: 0 } } }))
    await page.route('**/api/search/meaning**', (route) => route.fulfill({ json: [{ id: plain.id, title: 'Plain note', notebookName: 'Inbox', score: 0.9 }] }))
    let code = []
    let asked = []
    page.on('request', (request) => { if (voiceCode.test(request.url()) || meaningCode.test(request.url())) code.push(request.url().split('/').pop().split('?')[0]); if (featureApi.test(request.url())) asked.push(new URL(request.url()).pathname) })
    const open = async () => {
      await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
      await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
      // the mic lives on a canvas note's tool island (a mind map has its own tools), so start on the plain canvas note
      await page.evaluate((n) => window.__personalNote.selectNote(n), plain.id)
      await page.waitForFunction((n) => window.__personalNote.state.activeNoteId === n && !window.__personalNote.state.loading, plain.id, { timeout: 15000 })
    }
    const settings = async () => {
      if (!(await page.locator('#properties-panel').evaluate((e) => e.classList.contains('open')))) { if (!(await page.locator('#top-properties').isVisible())) await page.click('#share-button'); await page.click('#top-properties'); await page.waitForTimeout(500) }
      await page.locator('#plugin-voice').waitFor()
    }
    const closeSettings = async () => { await page.click('#close-properties'); await page.waitForTimeout(300) }
    const micShown = () => page.locator(label === 'phone' ? '#mobile-speak' : '#voice-button').isVisible()
    const byMeaning = async () => {
      await page.click('#search-button')
      await page.fill('#search-input', 'sleep')
      await page.waitForTimeout(1200)
      const shown = await page.locator('#search-results .omni-group h4', { hasText: 'By meaning' }).count()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      return shown
    }

    // on (the default)
    await open()
    await page.locator(label === 'phone' ? '#mobile-speak' : '#voice-button').waitFor({ state: 'visible', timeout: 15000 })
    check(`[${label}] voice on: the mic is there and the voice code was loaded`, await micShown() && code.some((name) => name.startsWith('voice-plugin')), code.join())
    check(`[${label}] meaning on: the "By meaning" group shows under a search`, await byMeaning() === 1 && code.some((name) => name.startsWith('meaning-plugin')))
    await settings()
    const text = await page.locator('#settings-plugins').textContent()
    check(`[${label}] Settings → Plugins lists Voice and Search by meaning with what each needs`,
      /Dictate into a note with your voice\. Audio is never kept, only the words\. Needs: about 750 MB download \(the Nemotron speech model\), runs on this computer\./.test(text)
      && /Find notes by what they mean, not only their words\. Needs: about 315 MB download \(the EmbeddingGemma model\), runs on this computer\./.test(text)
      && await page.locator('#plugin-voice').isChecked() && await page.locator('#plugin-meaning').isChecked())
    check(`[${label}] on: both download rows are in Settings`, await page.locator('#settings-voice-section').count() === 1 && await page.locator('#settings-meaning-section').count() === 1)
    if (label === 'phone') check('[phone] the new switch rows are at least 48px tall', (await page.locator('#settings-plugins .setting-row').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))).every((height) => height >= 48))

    // voice off from Settings, no reload
    await page.locator('#plugin-voice').uncheck()
    await page.waitForFunction(() => document.querySelector('#voice-button').hidden && !document.querySelector('#settings-voice-section'), null, { timeout: 10000 })
    check(`[${label}] voice off: no mic, no recording-face trigger, no voice row; the choice is kept`, !(await micShown()) && !(await page.locator('#voice-button').isVisible()) && !(await page.locator('#mobile-speak').isVisible()) && savedChoice()?.voice === false && savedChoice()?.meaning === true, JSON.stringify(savedChoice()))
    // meaning off from Settings, no reload
    await page.locator('#plugin-meaning').uncheck()
    await page.waitForFunction(() => !document.querySelector('#settings-meaning-section'), null, { timeout: 10000 })
    check(`[${label}] meaning off: the download row is gone and the choice is kept`, savedChoice()?.meaning === false)
    await closeSettings()
    asked = []
    check(`[${label}] meaning off: no "By meaning" group, and the omnibar asks the server nothing about meaning`, await byMeaning() === 0 && asked.length === 0, asked.join())

    // both off, fresh page: nothing of either loads or is asked
    code = []
    asked = []
    await open()
    await page.waitForTimeout(800)
    await settings()
    await closeSettings()
    check(`[${label}] both off, after a reload: no mic, no voice or meaning code requested, no voice or meaning request made`,
      !(await page.locator('#voice-button').isVisible()) && !(await page.locator('#mobile-speak').isVisible()) && code.length === 0 && asked.length === 0 && await byMeaning() === 0, `${code.join()} ${asked.join()}`)
    check(`[${label}] both off: the server's answers are plain`,
      (await (await fetch(`${API}/api/search/meaning?q=sleep`)).json()).length === 0
      && (await fetch(`${API}/api/search/meaning?q=sleep&strict=1`)).status === 409
      && (await fetch(`${API}/api/voice/engine/start`, { method: 'POST', headers: { 'x-personal-note': '1' } })).status === 409)

    // on again, no restart
    await settings()
    await page.locator('#plugin-voice').check()
    await page.locator(label === 'phone' ? '#mobile-speak' : '#voice-button').waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('#plugin-meaning').check()
    await page.locator('#settings-meaning-section').waitFor({ timeout: 10000 })
    await closeSettings()
    check(`[${label}] on again, no reload: the mic and the voice code are back`, await micShown() && code.some((name) => name.startsWith('voice-plugin')) && savedChoice()?.voice === true, code.join())
    check(`[${label}] on again: the "By meaning" group is back`, await byMeaning() === 1 && code.some((name) => name.startsWith('meaning-plugin')))
    await page.context().close()
  }
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  fs.rmSync(scratch, { recursive: true, force: true }) // the exact folder this run made
}
console.log(results.every(Boolean) ? `\nALL ${results.length} CHECKS PASSED` : `\n${results.filter((r) => !r).length} OF ${results.length} CHECKS FAILED`)
process.exit(results.every(Boolean) ? 0 : 1)
