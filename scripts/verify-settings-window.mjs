// F-102: Settings is a window of its own (desktop) and a drill-in list sheet (phone); the open note's properties are a popover from the island.
// Real production build (dist/) served by the real API on PN_VERIFY_PORT (default 4940, never 3137), scratch database, headless Chromium.
//   npm run build && PN_VERIFY_PORT=4940 node scripts/verify-settings-window.mjs      (PN_SHOT=/some/dir also saves a picture of every section in every skin)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const PORT = basePort(4940)
await assertPortsFree([PORT])
const ROOT = path.resolve('.')
const SHOT = process.env.PN_SHOT
if (SHOT) fs.mkdirSync(SHOT, { recursive: true })
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-settings-'))
const python = path.resolve(fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : '../../../.venv/bin/python')
const env = { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db'), PERSONAL_NOTE_PLUGINS_DIR: path.join(scratch, 'plugins') }
const BASE = `http://127.0.0.1:${PORT}`
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(PORT)], { cwd: ROOT, env, stdio: process.env.PN_DEBUG ? 'inherit' : 'ignore' })
const stopApi = () => { try { api.kill() } catch {} }
process.on('exit', stopApi)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopApi(); process.exit(1) })
const call = async (method, url, body) => { const r = await fetch(`${BASE}/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
const up = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const SECTIONS = ['appearance', 'writing', 'ai', 'plugins', 'voice', 'meaning', 'x', 'locked', 'advanced']
let browser
try {
  await up()
  const note = (await call('POST', '/notes', { title: 'Grocery ideas' })).body
  const saved = async () => JSON.stringify((await call('GET', `/notes/${note.id}`)).body.content)
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const open = async (viewport, skin) => {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width < 700, isMobile: viewport.width < 700 })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript((id) => localStorage.setItem('personal-note:skin', id), skin)
    await page.goto(`${BASE}/notes`)
    await page.locator('#island-title').waitFor()
    await page.waitForTimeout(1500) // the optional code arrives on idle
    return { page, context, errors }
  }
  const openSettings = async (page) => {
    await page.click('#share-button')
    await page.click('#top-properties')
    await page.locator('#properties-panel.open .sw-item').first().waitFor()
    await page.waitForTimeout(450)
  }
  const shot = async (page, name) => { if (SHOT) await page.screenshot({ path: path.join(SHOT, `${name}.png`) }) }
  const visibleTitle = (page) => page.locator('.sw-head .sw-title').textContent()

  // ---- desktop, every skin: the window, every section
  for (const skin of ['paper', 'crayon', 'night']) {
    const { page, context, errors } = await open({ width: 1440, height: 900 }, skin)
    await openSettings(page)
    const box = await page.locator('#properties-panel').boundingBox()
    if (skin === 'paper') {
      check('Settings opens as a centred window about 900 by 620', Math.abs(box.width - 900) < 2 && Math.abs(box.height - 620) < 2 && Math.abs(box.x + box.width / 2 - 720) < 2 && Math.abs(box.y + box.height / 2 - 450) < 2, JSON.stringify(box))
      check('the nine sections are listed in the design order', (await page.locator('.sw-item > span:nth-child(2)').allTextContents()).join('|') === 'Appearance|Writing|AI|Plugins|Voice|Search by meaning|X bookmarks|Locked notes|Advanced')
      check('the whole page is dimmed behind the window by a backdrop of its own', await page.evaluate(() => { const dim = document.querySelector('#settings-dim'); const r = dim.getBoundingClientRect(); return getComputedStyle(dim).opacity === '1' && r.width === innerWidth && r.height === innerHeight && document.elementFromPoint(120, 600) === dim }))
    }
    for (const id of SECTIONS) {
      await page.click(`.sw-item[data-sw-item="${id}"]`)
      await page.waitForTimeout(120)
      if (skin === 'paper') check(`desktop ${id}: the section opens with its own title`, (await visibleTitle(page)).length > 0 && (await page.locator(`.sw-page[data-sw-page="${id}"]`).isVisible()))
      await shot(page, `${skin}-desktop-${id}`)
    }
    check(`${skin}: no page errors while opening every section`, errors.length === 0, errors.join())
    await context.close()
  }

  // ---- desktop behaviour (Paper)
  {
    const { page, context } = await open({ width: 1440, height: 900 }, 'paper')
    await openSettings(page)
    // search filters sections and rows
    await page.fill('#settings-search', 'backup')
    await page.waitForTimeout(150)
    const names = await page.locator('.sw-item:visible > span:nth-child(2)').allTextContents()
    check('searching "backup" keeps only Advanced in the list', names.join() === 'Advanced', names.join())
    check('searching "backup" shows its rows and hides the others', (await page.locator('#download-backup').isVisible()) && !(await page.locator('#settings-speed-meter').isVisible()))
    check('a search drops a card with no matching row, and the heading above it', (await page.locator('.sw-page[data-sw-page="advanced"] .settings-section-label:visible').allTextContents()).join() === 'Workspace data')
    await shot(page, 'paper-desktop-search')
    await page.fill('#settings-search', 'zzzz')
    check('a search with no match says so', /Nothing matches/.test(await page.locator('.sw-none').textContent()))
    await page.fill('#settings-search', '')
    check('clearing the search brings the section back', await page.locator('.sw-page[data-sw-page="appearance"]').isVisible())
    // skins
    await page.click('.sw-skin[data-skin-id="night"]')
    check('picking the Night card changes the skin', (await page.evaluate(() => document.documentElement.dataset.skin)) === 'night')
    await page.click('.sw-skin[data-skin-id="paper"]')
    // plugins: the switch is the checkbox
    await page.click('.sw-item[data-sw-item="plugins"]')
    check('Plugins has a switch per plugin', (await page.locator('#settings-plugins-rows input[type="checkbox"]').count()) === 4)
    const before = await page.locator('#plugin-mindmap').isChecked()
    await page.locator('#plugin-mindmap').click()
    await page.waitForTimeout(600)
    check('a plugin switch turns the plugin off and on', before && !(await page.locator('#plugin-mindmap').isChecked()))
    await page.locator('#plugin-mindmap').click()
    await page.waitForTimeout(600)
    // writing
    await page.click('.sw-item[data-sw-item="writing"]')
    await page.click('[data-default-font-family="monospace"]')
    check('the default font control still works', await page.locator('[data-default-font-family="monospace"]').evaluate((e) => e.classList.contains('active')))
    // advanced: speed meter
    await page.click('.sw-item[data-sw-item="advanced"]')
    await page.locator('#settings-speed-meter').click()
    check('the speed meter switch shows the meter', await page.locator('.speed-meter').isVisible())
    await page.locator('#settings-speed-meter').click()
    // ai: segmented control drives the form, Test is there
    await page.click('.sw-item[data-sw-item="ai"]')
    await page.click('.sw-seg button[data-value="openai"]')
    check('the AI segmented control shows the OpenAI-compatible fields', (await page.locator('#ai-base-url').isVisible()) && !(await page.locator('#ai-claude-model').isVisible()))
    check('AI Test and Save are there', (await page.locator('#ai-test').isVisible()) && (await page.locator('#ai-save').isVisible()))
    await page.click('.sw-seg button[data-value="claude-code"]')
    // locked notes page opens the note properties
    await page.click('.sw-item[data-sw-item="locked"]')
    await page.click('.sw-page[data-sw-page="locked"] .portability-actions button')
    check('Locked notes: "Make the open note secure" closes Settings and opens the note properties', !(await page.locator('#properties-panel').evaluate((e) => e.classList.contains('open'))) && (await page.locator('#note-popover').isVisible()))
    await context.close()
  }

  // ---- a real dialog: a press on the dim closes it and never reaches the canvas; focus goes in, stays in, and comes back
  {
    const { page, context } = await open({ width: 1440, height: 900 }, 'paper')
    const before = await saved()
    await page.click('[data-tool="shape"]')
    await page.click('#share-button')
    await page.click('#top-properties')
    await page.locator('#properties-panel.open .sw-item').first().waitFor()
    await page.waitForTimeout(450)
    await page.mouse.click(120, 600) // the dimmed canvas, outside the window
    await page.waitForTimeout(1800) // (a saved shape would show by now)
    check('a press on the dim closes Settings', !(await page.locator('#properties-panel').evaluate((e) => e.classList.contains('open'))))
    check('and it does not reach the canvas: the shape tool placed nothing', (await saved()) === before)
    await page.mouse.click(120, 600)
    await page.waitForTimeout(1800)
    check('(the same press with Settings shut does place a shape: the check can fail)', (await saved()) !== before)
    await context.close()
  }
  {
    const { page, context } = await open({ width: 1440, height: 900 }, 'paper')
    const panel = page.locator('#properties-panel')
    check('the Settings window is a labelled modal dialog', (await panel.getAttribute('role')) === 'dialog' && (await panel.getAttribute('aria-modal')) === 'true' && (await panel.getAttribute('aria-label')) === 'Settings')
    await page.focus('#share-button')
    await page.keyboard.press('Enter')
    await page.locator('#top-properties').focus()
    await page.keyboard.press('Enter')
    await page.locator('#properties-panel.open .sw-item').first().waitFor()
    await page.waitForTimeout(450)
    const inside = () => page.evaluate(() => document.querySelector('#properties-panel').contains(document.activeElement))
    check('opening Settings moves the focus into the window', await inside())
    let escaped = 0
    for (let i = 0; i < 70; i++) { await page.keyboard.press('Tab'); if (!(await inside())) escaped++ }
    check('Tab goes round inside the window and never out of it (70 presses)', escaped === 0, String(escaped))
    for (let i = 0; i < 70; i++) { await page.keyboard.press('Shift+Tab'); if (!(await inside())) escaped++ }
    check('and so does Shift+Tab', escaped === 0, String(escaped))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    check('Esc closes Settings and puts the focus back on the island', !(await panel.evaluate((e) => e.classList.contains('open'))) && (await page.evaluate(() => document.activeElement.id)) === 'share-button')
    await page.focus('#search-button')
    await page.evaluate(() => document.querySelector('#top-properties').click())
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const back = await page.evaluate(() => document.activeElement.id || document.activeElement.className)
    check('Esc returns the focus to where it was when Settings was opened from elsewhere', back === 'search-button', back)
    await context.close()
  }

  // ---- the note's properties: a popover from the island
  {
    const { page, context } = await open({ width: 1440, height: 900 }, 'paper')
    await page.click('#share-button')
    await page.click('#share-props')
    const pop = page.locator('#note-popover')
    check('the island card opens a small properties popover', await pop.isVisible())
    const popBox = await pop.boundingBox()
    check('the popover is small and sits under the island', popBox.width <= 330 && popBox.y < 120, JSON.stringify(popBox))
    check('it holds the notebook, the type and the storage', (await pop.locator('#notebook-picker').isVisible()) && /On this device/.test(await pop.textContent()) && /Canvas|Page/.test(await pop.locator('#note-surface-label').textContent()))
    check('it holds Make secure and Delete note', (await pop.locator('#secure-note').isVisible()) && (await pop.locator('#delete-note').isVisible()))
    await page.waitForTimeout(500)
    await shot(page, 'paper-desktop-note-popover')
    await page.keyboard.press('Escape')
    check('Esc closes the popover', !(await pop.isVisible()))
    await page.click('#share-button')
    await page.click('#share-props')
    await page.mouse.click(300, 600)
    check('a click away closes the popover', !(await pop.isVisible()))
    check('Settings no longer holds the note properties', (await page.locator('#properties-panel #notebook-picker').count()) === 0)
    await context.close()
  }

  // ---- phone: a grouped list that drills in
  for (const skin of ['paper', 'crayon', 'night']) {
    const { page, context, errors } = await open({ width: 390, height: 844 }, skin)
    await page.click('#share-button')
    await page.click('#top-properties')
    await page.locator('#properties-panel.open .sw-item').first().waitFor()
    await page.waitForTimeout(450)
    const panel = await page.locator('#properties-panel').boundingBox()
    if (skin === 'paper') {
      check('on a phone Settings is a bottom sheet', panel.x <= 1 && Math.abs(panel.width - 390) < 2 && panel.y > 40 && Math.abs(panel.y + panel.height - 844) < 2, JSON.stringify(panel))
      const rows = await page.locator('.sw-item').evaluateAll((all) => all.map((e) => Math.round(e.getBoundingClientRect().height)))
      check('list rows are 52 px', rows.every((h) => h === 52), rows.join())
      check('only the list shows until a row is tapped', !(await page.locator('.sw-pane').isVisible()))
      check('rows show a value', (await page.locator('.sw-item[data-sw-item="appearance"] small').textContent()) === 'Paper' && /on$/.test(await page.locator('.sw-item[data-sw-item="plugins"] small').textContent()))
    }
    await shot(page, `${skin}-phone-list`)
    await page.tap('.sw-item[data-sw-item="appearance"]')
    await page.waitForTimeout(150)
    if (skin === 'paper') check('tapping Appearance drills in and shows three skin cards', (await page.locator('.sw-skin:visible').count()) === 3 && !(await page.locator('.sw-nav').isVisible()))
    await shot(page, `${skin}-phone-appearance`)
    if (skin === 'paper') {
      for (const id of SECTIONS.filter((s) => s !== 'appearance')) {
        await page.tap('.sw-back')
        await page.tap(`.sw-item[data-sw-item="${id}"]`)
        await page.waitForTimeout(120)
        await shot(page, `${skin}-phone-${id}`)
        check(`phone ${id}: drills in and Back returns`, (await page.locator(`.sw-page[data-sw-page="${id}"]`).isVisible()) && (await page.locator('.sw-back').isVisible()))
      }
      const close = await page.locator('.sw-close').boundingBox()
      check('[phone] the close button in a section is at least 44 px', close.width >= 44 && close.height >= 44, JSON.stringify(close))
      // a swipe down on the handle closes the sheet
      await page.tap('.sw-back')
      const handle = await page.locator('.sw-grab').boundingBox()
      const client = await context.newCDPSession(page)
      const x = handle.x + handle.width / 2
      const y = handle.y + 12
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      for (let i = 1; i <= 8; i++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + i * 20 }] })
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(500)
      check('swiping the handle down 160 px closes the sheet', !(await page.locator('#properties-panel').evaluate((e) => e.classList.contains('open'))))
    }
    if (skin === 'paper') {
      await page.waitForTimeout(600)
      if (!(await page.locator('#share-props').isVisible())) await page.tap('#share-button')
      await page.locator('#share-props').waitFor({ state: 'visible', timeout: 8000 })
      await page.tap('#share-props')
      const heights = await page.locator('#secure-note, #delete-note').evaluateAll((all) => all.map((e) => Math.round(e.getBoundingClientRect().height)))
      check('[phone] Make secure and Delete note in the note properties are at least 44 px', heights.length === 2 && heights.every((h) => h >= 44), heights.join())
    }
    check(`${skin} phone: no page errors`, errors.length === 0, errors.join())
    await context.close()
  }
} finally {
  await browser?.close()
  stopApi()
  fs.rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
