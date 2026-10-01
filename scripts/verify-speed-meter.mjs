// Drives the real app (Vite dev server, in-memory mocked /api) through the F-015 speed meter checks.
// node scripts/verify-speed-meter.mjs <shotsDir>
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
let slowSecond = false
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

async function open(width = 1440, height = 900, skin = 'crayon', query = '') {
  stored = { version: '7.4.0', objects: [] }; pageState = { columns: 1, rows: 1 }; deleteCalls = 0; deletedFirst = false; slowSecond = false
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('page error:', error.message))
  page.on('console', (m) => { if (m.type() === 'error') console.error('console error:', m.text()) })
  await page.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('personal-note:skin', s); sessionStorage.setItem('seeded', '1') }; window.__raf = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (fn) => { window.__raf += 1; return raf(fn) } }, skin)
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const route_ = url.pathname.replace(/^\/api/, '')
    const method = route.request().method()
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (route_ === '/notebooks') return json(notebooks)
    if (route_ === '/notes') return json(deletedFirst ? [second] : [summary(), second])
    if (route_ === '/notes/2' && method === 'GET') { if (slowSecond) await new Promise((r) => setTimeout(r, 1500)); return json({ ...second, content: { version: '7.4.0', objects: [] }, pageState: { columns: 1, rows: 1 } }) }
    if (route_ === '/notes/1' && method === 'DELETE') { deleteCalls += 1; deletedFirst = true; return route.fulfill({ status: 204 }) }
    if (route_ === '/notes/1' && method === 'GET') return json({ ...summary(), content: stored, pageState })
    if (route_ === '/notes/1' && method === 'PUT') {
      const body = JSON.parse(route.request().postData())
      stored = body.content; pageState = body.pageState; revision += 1; saves += 1
      return json({ ...summary() })
    }
    return json([])
  })
  await page.goto(new URL('notes' + query, baseUrl).href)
  await page.waitForFunction(() => window.__personalNote?.canvas && document.querySelector('.note-list-item.active'), null, { timeout: 30000 })
  await page.waitForTimeout(900)
  return { context, page }
}


const toClient = (page, x, y) => page.evaluate(([px, py]) => {
  const { canvas } = window.__personalNote
  const v = canvas.viewportTransform
  const r = canvas.upperCanvasEl.getBoundingClientRect()
  return { x: r.left + px * v[0] + v[4], y: r.top + py * v[3] + v[5] }
}, [x, y])
const pill = (page) => page.locator('.speed-meter')
const rafOver = async (page, ms) => { const a = await page.evaluate(() => window.__raf); await page.waitForTimeout(ms); return (await page.evaluate(() => window.__raf)) - a }
{
  const { context, page } = await open(1440, 900, 'crayon')
  check('meter is off by default', (await pill(page).count()) === 0)
  const idle = await rafOver(page, 1000)
  await page.keyboard.press('Control+Shift+F')
  await page.waitForTimeout(1500)
  check('shortcut shows the pill', await pill(page).isVisible())
  const text = await pill(page).innerText()
  check('pill shows fps and slowest frame', /\d+ fps · slowest \d+ ms/.test(text), JSON.stringify(text))
  check('pill names engine and host', /Chromium · Browser/.test(text), JSON.stringify(text))
  const running = await rafOver(page, 1000)
  check('frames are measured only while visible', running > idle + 20, `idle ${idle}, on ${running}`)
  await page.screenshot({ path: path.join(shots, 'meter-desktop.png') })
  await page.reload()
  await page.waitForFunction(() => window.__personalNote?.canvas, null, { timeout: 30000 })
  await page.waitForTimeout(600)
  check('choice is remembered across reload', await pill(page).isVisible())
  await page.click('#top-properties')
  await page.waitForTimeout(450)
  check('settings toggle reflects state', await page.locator('#settings-speed-meter').isChecked())
  await page.screenshot({ path: path.join(shots, 'meter-settings.png') })
  await page.locator('#settings-speed-meter').uncheck()
  await page.waitForTimeout(200)
  check('settings toggle hides the pill', !(await pill(page).isVisible()))
  const off = await rafOver(page, 1000)
  check('zero frame loop after hiding', off <= idle + 5, `off ${off}, idle ${idle}`)
  await page.locator('#settings-speed-meter').check()
  await page.keyboard.press('Escape')
  await page.click('#top-properties').catch(() => {})
  // typing guard: focus the search field, shortcut must not toggle
  await page.keyboard.press('Control+K')
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+Shift+F')
  await page.waitForTimeout(200)
  check('shortcut ignored while typing', await pill(page).isVisible())
  await page.keyboard.press('Escape')
  await page.click('[data-tool="text"]')
  const c = await toClient(page, 200, 200)
  await page.mouse.click(c.x, c.y)
  await page.keyboard.type('hi')
  await page.keyboard.press('Control+Shift+F')
  await page.waitForTimeout(200)
  check('shortcut ignored while editing canvas text', await pill(page).isVisible())
  await page.keyboard.press('Escape')
  await page.emulateMedia({ media: 'print' })
  check('pill hidden in print', !(await pill(page).isVisible()))
  await context.close()
}
{
  const { context, page } = await open(1440, 900, 'crayon', '?host=desktop')
  await page.keyboard.press('Control+Shift+F')
  await page.waitForTimeout(500)
  check('desktop flag labels the host before pywebview exists', /Chromium · Desktop app/.test(await pill(page).innerText()))
  await context.close()
}
{
  const { context, page } = await open(1440, 900, 'crayon')
  await page.keyboard.press('Control+Shift+F')
  await page.waitForTimeout(500)
  await page.evaluate(() => { window.pywebview = {}; window.dispatchEvent(new Event('pywebviewready')) })
  check('pywebviewready re-renders the host label', /Desktop app/.test(await pill(page).innerText()))
  await context.close()
}
{
  const { context, page } = await open(390, 844, 'night')
  await page.keyboard.press('Control+Shift+F')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(shots, 'meter-phone-night.png') })
  await context.close()
}

await browser.close()
await server.close()
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `${failed.length} FAILED` : `${results.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
