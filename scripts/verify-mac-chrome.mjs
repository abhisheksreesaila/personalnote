// Drives the real app (Vite dev server, in-memory mocked /api) through the F-022 native Mac window page checks (chrome=mac layout, drag strips, menu commands).
// node scripts/verify-mac-chrome.mjs <shotsDir>
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const shots = process.argv[2] || path.join(os.tmpdir(), 'shots-f022')
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
  await page.waitForFunction(() => window.__personalNote?.leaferCanvas() && document.querySelector('.note-list-item.active'), null, { timeout: 30000 })
  await page.waitForTimeout(900)
  return { context, page }
}

const rect = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom } : null }, sel)
const MAC = '?host=desktop&chrome=mac'

{ // Mac chrome, wide window
  const { context, page } = await open(1440, 900, 'paper', MAC)
  check('html carries chrome-mac', await page.evaluate(() => document.documentElement.classList.contains('chrome-mac')))
  const brand = await rect(page, '.brand-row')
  check('sidebar contents start below the traffic lights (>= 40px)', brand.y >= 40, `brandTop=${brand.y}`)
  const strips = await page.evaluate(() => [...document.querySelectorAll('.mac-drag-strip')].map((e) => e.className))
  check('two drag strips with the pywebview class', strips.length === 2 && strips.every((c) => c.includes('pywebview-drag-region')), JSON.stringify(strips))
  const bar = await rect(page, '.topbar'); const strip = await rect(page, '.mac-drag-main')
  check('top bar sits inside the drag row', bar.y >= 0 && bar.b <= strip.b + 1, `bar=${bar.y}-${bar.b} strip=${strip.b}`)
  const hit = await page.evaluate(() => {
    const at = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) }
    return { empty: document.elementFromPoint(900, 10)?.className ?? '', search: Boolean(at('#search-button')?.closest('#search-button')), share: Boolean(at('#share-button')?.closest('#share-button')), title: at('#note-title')?.id }
  })
  check('empty bar area hits the drag strip', String(hit.empty).includes('pywebview-drag-region'), hit.empty)
  check('search, share and title stay clickable', hit.search && hit.share && hit.title === 'note-title', JSON.stringify(hit))
  await page.screenshot({ path: path.join(shots, 'mac-wide.png') })
  await page.evaluate(() => window.personalNote.setFullscreen(true))
  await page.waitForTimeout(100)
  const full = await page.evaluate(() => ({ strip: getComputedStyle(document.querySelector('.mac-drag-strip')).display, pad: getComputedStyle(document.querySelector('.sidebar')).paddingTop }))
  check('full screen hides strips and the sidebar inset', full.strip === 'none' && full.pad === '14px', JSON.stringify(full))
  await context.close()
}

{ // Narrow window: the top bar starts clear of the lights
  const { context, page } = await open(700, 800, 'paper', MAC)
  const toggle = await rect(page, '#toggle-sidebar')
  check('narrow: sidebar toggle starts at or after 74px', toggle && toggle.x >= 74, `x=${toggle?.x}`)
  await page.screenshot({ path: path.join(shots, 'mac-narrow.png') })
  await context.close()
}

for (const query of ['', '?host=desktop']) { // Unchanged elsewhere
  const { context, page } = await open(1440, 900, 'paper', query)
  const info = await page.evaluate(() => ({ cls: document.documentElement.classList.contains('chrome-mac'), strips: document.querySelectorAll('.mac-drag-strip').length, pad: getComputedStyle(document.querySelector('.sidebar')).paddingTop }))
  check(`no mac chrome for "${query || 'browser tab'}"`, !info.cls && info.strips === 0 && info.pad === '14px', JSON.stringify(info))
  await context.close()
}

{ // Menu commands
  const { context, page } = await open(1440, 900, 'paper', MAC)
  const command = (name) => page.evaluate((n) => window.personalNote.command(n), name)
  check('unknown command is refused', (await command('format-disk')) === false)
  await command('skin-night'); check('skin command switches skin', (await page.evaluate(() => document.documentElement.dataset.skin)) === 'night')
  await command('skin-paper')
  await command('speed-meter'); check('speed meter command shows the meter', await page.evaluate(() => !document.querySelector('.speed-meter')?.hidden))
  await command('speed-meter'); check('speed meter command hides it again', await page.evaluate(() => document.querySelector('.speed-meter')?.hidden === true))
  await command('settings'); check('settings command opens the properties panel', await page.evaluate(() => document.querySelector('#properties-panel').classList.contains('open')))
  const zoom = () => page.evaluate(() => parseInt(document.querySelector('#zoom-value').textContent))
  const z0 = await zoom()
  await command('zoom-in'); await page.waitForTimeout(500)
  const z1 = await zoom()
  await command('zoom-out'); await command('zoom-out'); await page.waitForTimeout(500)
  const z2 = await zoom()
  check('zoom commands change the zoom', z1 > z0 && z2 < z1, `${z0} -> ${z1} -> ${z2}`)
  check('new-note command is accepted', (await command('new-note')) === true)
  await page.waitForTimeout(500)
  await context.close()
}

await browser.close()
await server.close()
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `${failed.length} FAILED` : `${results.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
