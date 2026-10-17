// F-090: built-in plugins in the real app. Vite dev server on PN_VERIFY_PORT (never 3137) with the real API on the next port, headless Chromium,
// a scratch database and a scratch plugins folder (PERSONAL_NOTE_PLUGINS_DIR), so the captain's settings are never touched.
// Mind maps on: the new-mind-map entry is there and a map opens in its editor. Switched off in Settings → Plugins: no entry in the new-note menu,
// the editor chunk is never requested (not even after a reload and opening a map), an existing map opens read-only as an outline with
// "Turn on Mind maps to edit", the server refuses a new map and keeps the old one untouched. "Turn on Mind maps" in that view brings the editor
// back without a reload, and an edit saves. Phone width first, then desktop. The command line's side is tests/test_plugin_settings.py.
//   PN_VERIFY_PORT=4910 node scripts/verify-plugins.mjs        (PN_SHOT=/path/shot.png also saves pictures)
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const UI_PORT = Number(process.env.PN_VERIFY_PORT || 4910)
const API_PORT = UI_PORT + 1
if ([UI_PORT, API_PORT].includes(3137)) throw new Error('Never use the real app port (3137)')
for (const port of [UI_PORT, API_PORT]) {
  const busy = await new Promise((resolve) => { const probe = net.connect(port, '127.0.0.1'); probe.on('connect', () => { probe.destroy(); resolve(true) }); probe.on('error', () => resolve(false)) })
  if (busy) throw new Error(`port ${port} is busy: set PN_VERIFY_PORT to another`)
}
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
      check('[phone] the switch row is at least 44px tall', row.height >= 44, JSON.stringify(row))
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
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  fs.rmSync(scratch, { recursive: true, force: true }) // the exact folder this run made
}
console.log(results.every(Boolean) ? `\nALL ${results.length} CHECKS PASSED` : `\n${results.filter((r) => !r).length} OF ${results.length} CHECKS FAILED`)
process.exit(results.every(Boolean) ? 0 : 1)
