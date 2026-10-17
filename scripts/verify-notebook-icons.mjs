// F-089 notebook icons, in the real app: Vite dev server on PN_VERIFY_PORT (default 4900) with a real API on the next port over, on a scratch database;
// headless Chromium (PN_VERIFY_BROWSER=webkit for the Mac app's engine). Real mouse and keyboard throughout.
// PN_PYTHON names the Python that has the app's requirements (default .venv/bin/python, else python3).
// It stops what it starts, never touches port 3137 or the real database.
//   PN_SHOT=/path/icons.png node scripts/verify-notebook-icons.mjs   (also saves a picture per skin: Crayon, Paper, Night; phone width too)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium, webkit } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4900)
const API_PORT = UI_PORT + 1
await assertPortsFree([UI_PORT, API_PORT])
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-icons-'))
const python = process.env.PN_PYTHON || (fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3')
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], {
  env: { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db') }, stdio: 'ignore',
})
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const call = async (method, url, body) => {
  const response = await fetch(`${API}/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return response.status === 204 ? null : response.json()
}
const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
const engine = process.env.PN_VERIFY_BROWSER === 'webkit' ? webkit : chromium
let browser
try {
  await apiUp()
  await server.listen()
  const names = ['Household chores', 'Links', 'X bookmarks', 'Recipes', '🚀 Launch', 'Zebra']
  for (const name of names) await call('POST', '/notebooks', { name })
  browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ['--disable-dev-shm-usage'] } : {}) })
  const context = await browser.newContext({ viewport: { width: 1360, height: 1100 } })
  const page = await context.newPage()
  await page.addInitScript(() => localStorage.setItem('pn.notesPanelOpen', '1'))
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const shot = async (name) => { if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${name}.png`) }) }
  const open = async () => {
    await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
    await page.waitForSelector('[data-icon-notebook]', { timeout: 60000 })
    await page.waitForTimeout(300)
  }
  const button = (name) => page.locator('.nav-row', { hasText: name }).locator('.nbi')
  const glyph = (name) => button(name).evaluate((node) => ({ svg: !!node.querySelector('svg'), lucide: node.querySelector('svg')?.getAttribute('class') ?? '', emoji: node.querySelector('.nbi-e')?.textContent ?? '', letter: node.querySelector('.nbi-l')?.textContent ?? '', color: getComputedStyle(node).color }))
  const stored = async (name) => (await call('GET', '/notebooks')).find((item) => item.name === name)

  await open()
  const house = await glyph('Household chores')
  check('"Household chores" shows a house icon, guessed', house.svg && house.lucide.includes('house'), JSON.stringify(house))
  check('"Links" shows a globe', (await glyph('Links')).lucide.includes('globe'))
  const xGlyph = await glyph('X bookmarks')
  check('"X bookmarks" shows the X logo', xGlyph.svg && !xGlyph.lucide.includes('lucide'), JSON.stringify(xGlyph))
  check('"Recipes" shows a pot', (await glyph('Recipes')).lucide.includes('cooking-pot'))
  check('a leading emoji in the name shows as the icon', (await glyph('Launch')).emoji === '🚀')
  check('and the row does not repeat it', (await page.locator('.nav-row', { hasText: 'Launch' }).locator('.notebook-name').textContent()) === 'Launch')
  check('no word matches: the first letter shows', (await glyph('Zebra')).letter === 'Z')
  check('nothing was stored by guessing', (await stored('Links')).icon === '')

  // Pick an icon with the mouse.
  await button('Zebra').click()
  await page.waitForSelector('.nbi-pop')
  const pop = await page.locator('.nbi-pop').boundingBox()
  check('clicking the icon opens the picker inside the window', pop && pop.x >= 0 && pop.y >= 0 && pop.x + pop.width <= 1360 && pop.y + pop.height <= 1100, JSON.stringify(pop))
  await shot('picker')
  await page.click('.nbi-pop [data-icon="lucide:rocket"]')
  await page.waitForTimeout(400)
  check('picking an icon closes the picker', (await page.locator('.nbi-pop').count()) === 0)
  check('the chosen icon shows', (await glyph('Zebra')).lucide.includes('rocket'))
  check('and is saved with the notebook', (await stored('Zebra')).icon === 'lucide:rocket')

  // An emoji, typed.
  await button('Zebra').click()
  await page.click('.nbi-in')
  await page.keyboard.type('ab')
  await page.keyboard.press('Enter')
  check('two characters are not an emoji: the field says so and the picker stays', (await page.locator('.nbi-in[aria-invalid]').count()) === 1 && (await page.locator('.nbi-pop').count()) === 1)
  await page.fill('.nbi-in', '🦓')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  check('an emoji typed in the field shows', (await glyph('Zebra')).emoji === '🦓')
  check('and is saved', (await stored('Zebra')).icon === 'emoji:🦓')

  // A colour, and Esc.
  await button('Zebra').click()
  await page.locator('.nbi-colors button').nth(3).click()
  await page.waitForTimeout(400)
  const colour = (await page.locator('.nbi-colors button').nth(3).getAttribute('data-color'))
  check('picking a colour keeps the picker open', (await page.locator('.nbi-pop').count()) === 1)
  check('and saves it', (await stored('Zebra')).color.toLowerCase() === colour.toLowerCase(), colour)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  check('Esc closes the picker and the focus returns to the icon', (await page.locator('.nbi-pop').count()) === 0 && (await page.evaluate(() => document.activeElement?.classList.contains('nbi'))))

  // Keyboard only: open with Enter, arrow to another icon, choose it.
  await button('Links').focus()
  await page.keyboard.press('Enter')
  await page.waitForSelector('.nbi-pop')
  await page.locator('.nbi-grid button').first().focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  const focused = await page.evaluate(() => document.activeElement.dataset.icon)
  check('arrow keys move through the icons (right one, down one row of eight)', focused === 'lucide:cooking-pot', focused)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  check('Enter on an icon chooses it', (await stored('Links')).icon === focused, `${focused} vs ${(await stored('Links')).icon}`)

  // "Choose for me" goes back to the guess.
  await button('Links').click()
  await page.click('.nbi-auto')
  await page.waitForTimeout(400)
  check('"Choose for me" goes back to the guessed icon', (await stored('Links')).icon === '' && (await glyph('Links')).lucide.includes('globe'))

  // Survives a reload; the colour tints the icon.
  await open()
  check('the emoji survives a reload', (await glyph('Zebra')).emoji === '🦓')
  const tint = await glyph('Zebra')
  const swatch = colour.replace('#', '')
  const rgb = [0, 2, 4].map((i) => parseInt(swatch.slice(i, i + 2), 16)).join(', ')
  check('the icon is tinted with the notebook colour after a reload', tint.color === `rgb(${rgb})`, `${tint.color} vs rgb(${rgb})`)

  // The three skins, desktop and phone.
  for (const skin of ['crayon', 'paper', 'night']) {
    await page.evaluate((id) => localStorage.setItem('personal-note:skin', id), skin)
    await open()
    await shot(skin)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await open()
  await page.click('#toggle-sidebar').catch(() => {})
  await page.waitForTimeout(500)
  const box = await button('Links').boundingBox()
  check('on a phone the icon is a 44px target', box && box.width >= 44 && box.height >= 44, JSON.stringify(box))
  await button('Links').click()
  await page.waitForSelector('.nbi-pop')
  const small = await page.locator('.nbi-pop').boundingBox()
  check('and the picker fits the phone screen', small && small.x >= 0 && small.x + small.width <= 390 && small.y + small.height <= 844, JSON.stringify(small))
  await shot('phone')
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  fs.rmSync(path.join(scratch, 'verify.db'), { force: true })
  fs.rmSync(path.join(scratch, 'verify.db-wal'), { force: true })
  fs.rmSync(path.join(scratch, 'verify.db-shm'), { force: true })
  try { fs.rmdirSync(scratch) } catch {}
}
process.exit(results.every(Boolean) ? 0 : 1)
