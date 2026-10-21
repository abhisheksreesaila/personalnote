// Before/after screenshots: real dist/ build, scratch DB, headless; "after" adds docs/design/omxqua/prototype.css on top.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from '../../../scripts/lib/ports.mjs'
const PORT = basePort(4987); await assertPortsFree([PORT])
const OUT = path.resolve(process.env.PN_SHOT_OUT || 'docs/design/omxqua/img-built'); fs.mkdirSync(OUT, { recursive: true })

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-oq-'))
const env = { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'v.db'), PERSONAL_NOTE_PLUGINS_DIR: path.join(scratch, 'plugins') }
const BASE = `http://127.0.0.1:${PORT}`
const api = spawn('.venv/bin/python', ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(PORT)], { env, stdio: 'ignore' })
process.on('exit', () => { try { api.kill() } catch {} })
const call = async (m, u, b) => (await fetch(`${BASE}/api${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: b && JSON.stringify(b) })).json()
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/notebooks`)).ok) break } catch {} await new Promise(r => setTimeout(r, 150)) }
for (const t of ['Lighthouse trip', 'Grocery ideas', 'Reading list', 'Garden plan', 'Weekly review']) await call('POST', '/notes', { title: t })
await call('POST', '/notes', { title: 'Book mind map', noteType: 'mindmap' })
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } }

for (const skin of ['paper', 'night', 'crayon']) for (const [dev, vp] of Object.entries(sizes)) for (const look of ['built']) {
  const phone = dev === 'phone'
  const ctx = await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone, deviceScaleFactor: phone ? 2 : 1 })
  const page = await ctx.newPage()
  if (process.env.PN_SHOT_CONTRAST) await page.emulateMedia({ contrast: process.env.PN_SHOT_CONTRAST })
  await page.addInitScript((id) => localStorage.setItem('personal-note:skin', id), skin)
  await page.goto(`${BASE}/notes`); await page.locator('#island-title').waitFor(); await page.waitForTimeout(1800)
  const name = (s) => path.join(OUT, `${look}-${s}-${skin}-${dev}.png`)
  const dress = async () => { await page.waitForTimeout(350) }
  // notes
  if (!(await page.locator('.sidebar.open').count())) await page.click('#toggle-sidebar').catch(() => {})
  await page.waitForTimeout(500); await dress(); await page.screenshot({ path: name('notes') })
  if (phone) { await page.mouse.click(370, 820); await page.waitForTimeout(500) }
  // search
  await page.click('#search-button'); await page.locator('#search-input').waitFor(); await page.fill('#search-input', 'l'); await page.waitForTimeout(700)
  await dress(); await page.screenshot({ path: name('search') })
  await page.keyboard.press('Escape'); await page.waitForTimeout(400)
  // settings
  await page.click('#share-button'); await page.click('#top-properties'); await page.locator('#properties-panel.open .sw-item').first().waitFor(); await page.waitForTimeout(600)
  if (phone) { await page.click('.sw-item[data-sw-item="appearance"]'); await page.waitForTimeout(400) }
  await dress(); await page.screenshot({ path: name('settings') })
  await ctx.close(); console.log('shot', look, skin, dev)
}
await browser.close(); process.exit(0)
