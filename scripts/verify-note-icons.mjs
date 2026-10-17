// F-100 note icons, in the real app: Vite dev server on PN_VERIFY_PORT (default 4920) with a real API on the next port over, on a scratch database;
// headless Chromium (PN_VERIFY_BROWSER=webkit for the Mac app's engine). Real mouse and keyboard throughout.
// PN_PYTHON names the Python that has the app's requirements (default .venv/bin/python, else python3).
// It stops what it starts, never touches port 3137 or the real database.
//   PN_SHOT=/path/icons.png node scripts/verify-note-icons.mjs   (also saves a picture per skin, desktop and phone)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium, webkit } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4920)
const API_PORT = UI_PORT + 1
await assertPortsFree([UI_PORT, API_PORT])
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-note-icons-'))
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
  const book = (await call('GET', '/notebooks'))[0]
  const make = async (title, noteType) => (await call('POST', '/notes', { title, noteType, notebookId: book.id }))
  const ids = {}
  for (const [title, type] of [['Lisbon trip', 'page'], ['Startup pitch', 'canvas'], ['Product ideas', 'mindmap'], ['Zzz qqq', 'page'], ['Grocery ideas', 'page']]) ids[title] = (await make(title, type)).id
  const stored = async (title) => (await call('GET', '/notes')).find((note) => note.id === ids[title])

  browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ['--disable-dev-shm-usage'] } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.addInitScript(() => localStorage.setItem('pn.notesPanelOpen', '1'))
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  const shot = async (name) => { if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${name}.png`) }) }
  const row = (title) => page.locator(`.note-list-item[data-note-id="${ids[title]}"]`)
  const tile = (title) => row(title).locator('.nt')
  const settle = (ms = 500) => page.waitForTimeout(ms)
  const open = async (title = 'Zzz qqq') => {
    await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
    await page.waitForSelector('.notebook-tab', { timeout: 60000 })
    if ((await row('Lisbon trip').count()) === 0) await page.locator('.notebook-tab').first().click()
    await row('Lisbon trip').waitFor()
    await settle(300)
  }

  await open()
  // The rows: a tile with the emoji, the type glyph on the right.
  const emojis = {}
  for (const title of Object.keys(ids)) emojis[title] = await tile(title).textContent()
  check('"Lisbon trip" shows a plane (guessed from the title)', emojis['Lisbon trip'] === '✈️', emojis['Lisbon trip'])
  check('"Startup pitch" shows a rocket (guessed)', emojis['Startup pitch'] === '🚀', emojis['Startup pitch'])
  check('"Grocery ideas" shows a cart (guessed)', emojis['Grocery ideas'] === '🛒', emojis['Grocery ideas'])
  check('a map with no word the app knows gets the mind-map default', emojis['Product ideas'] === '💡' || emojis['Product ideas'] === '🧠', emojis['Product ideas'])
  check('a page with no word the app knows gets the page default', emojis['Zzz qqq'] === '📄', emojis['Zzz qqq'])
  const look = await tile('Lisbon trip').evaluate((node) => {
    const style = getComputedStyle(node)
    const box = node.getBoundingClientRect()
    const rowBox = node.parentElement.getBoundingClientRect()
    const glyph = node.parentElement.querySelector('svg')?.getBoundingClientRect()
    return { background: style.backgroundColor, width: box.width, height: box.height, radius: style.borderRadius, tileLeft: box.left - rowBox.left, glyphRight: glyph ? rowBox.right - glyph.right : null, glyphAfterTile: glyph ? glyph.left > box.right : false }
  })
  check('the tile is 24px with a tinted background', look.width === 24 && look.height === 24 && look.background !== 'rgba(0, 0, 0, 0)' && look.radius === '7px', JSON.stringify(look))
  check('the type glyph is on the right of the row', look.glyphAfterTile && look.glyphRight < 20, JSON.stringify(look))
  const tints = await Promise.all(Object.keys(ids).map((title) => tile(title).evaluate((node) => getComputedStyle(node).backgroundColor)))
  check('the tiles are not all one colour', new Set(tints).size > 1, tints.join(' | '))
  await shot('list-paper')

  // Click a tile: the picker opens, the note stays as it is.
  const before = await page.evaluate(() => document.querySelector('#note-title').value)
  await tile('Zzz qqq').click()
  await page.waitForSelector('.nip')
  check('clicking a tile opens the picker, and does not open that note', (await page.locator('#note-title').inputValue()) === before)
  const box = await page.locator('.nip').boundingBox()
  check('the picker sits inside the window', box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900, JSON.stringify(box))
  await shot('picker')
  await page.fill('.nip-in', 'rock')
  check('searching "rock" finds the rocket', (await page.locator('.nip-grid button').allTextContents()).join('') === '🚀')
  await page.fill('.nip-in', 'zzzzzz')
  check('a search with no match says so', (await page.locator('.nip-none').textContent()).includes('Nothing matches'))
  await page.fill('.nip-in', '')
  check('Recent is empty at first; the common emoji show', (await page.locator('.nip-h').allTextContents()).join(',').startsWith('Notes') && (await page.locator('.nip-grid button').count()) === 24)
  await page.locator('.nip-grid button', { hasText: '🍳' }).click()
  await settle()
  const cooked = await stored('Zzz qqq')
  check('choosing an emoji saves it, closes the picker and draws it', cooked.icon.emoji === '🍳' && cooked.icon.chosen && (await page.locator('.nip').count()) === 0 && (await tile('Zzz qqq').textContent()) === '🍳', JSON.stringify(cooked.icon))
  const order = (await call('GET', '/notes')).map((note) => note.id)
  check('the list order did not change', order[0] === ids['Grocery ideas'], order.join())

  // A tint, on the open note.
  await tile('Zzz qqq').click()
  await page.waitForSelector('.nip')
  const recentFirst = (await page.locator('.nip-h').allTextContents())[0]
  check('the choice is in Recent now', recentFirst === 'Recent' && (await page.locator('.nip-grid').first().locator('button').first().textContent()) === '🍳')
  await page.locator('.nip-tints button').nth(3).click()
  await settle()
  check('a tint is saved with the emoji', (await stored('Zzz qqq')).icon.tint === 4 && (await page.locator('.nip-tints button').nth(3).getAttribute('aria-pressed')) === 'true')
  await page.keyboard.press('Escape')
  check('Esc closes the picker', (await page.locator('.nip').count()) === 0)

  // Guess from title and Remove.
  await tile('Lisbon trip').click()
  await page.waitForSelector('.nip')
  check('Remove is off while nothing is chosen', await page.locator('[data-remove]').isDisabled())
  await page.locator('[data-guess]').click()
  await settle()
  check('"Guess from title" chooses the guess', (await stored('Lisbon trip')).icon.chosen === true && (await stored('Lisbon trip')).icon.emoji === '✈️')
  await tile('Lisbon trip').click()
  await page.waitForSelector('.nip')
  await page.locator('[data-remove]').click()
  await settle()
  check('"Remove" goes back to the guess', (await stored('Lisbon trip')).icon.chosen === false && (await tile('Lisbon trip').textContent()) === '✈️')

  // The open note: a canvas shows its emoji in the island.
  await row('Startup pitch').click()
  await page.waitForFunction(() => document.querySelector('#island-icon')?.textContent === '🚀', null, { timeout: 15000 })
  await settle(700)
  const islandIcon = await page.locator('#island-icon').boundingBox()
  const islandBox = await page.locator('#island').boundingBox()
  check('a canvas note shows its emoji in the title island', islandIcon && islandIcon.width === 44 && islandIcon.x >= islandBox.x && islandIcon.x + islandIcon.width <= islandBox.x + islandBox.width, JSON.stringify({ islandIcon, islandBox }))
  const titleBox = await page.locator('#island-title').boundingBox()
  check('and the title fits in the island beside it', titleBox.x + titleBox.width <= islandBox.x + islandBox.width + 1 && titleBox.x >= islandIcon.x + islandIcon.width, JSON.stringify({ titleBox, islandBox }))
  await shot('canvas')
  await page.locator('#island-icon').click()
  await page.waitForSelector('.nip')
  await page.fill('.nip-in', 'target')
  await page.locator('.nip-grid button', { hasText: '🎯' }).click()
  await settle()
  check('clicking the island emoji changes it', (await stored('Startup pitch')).icon.emoji === '🎯' && (await page.locator('#island-icon').textContent()) === '🎯' && (await tile('Startup pitch').textContent()) === '🎯')
  // The island's menu has the same thing for a keyboard.
  await page.locator('#share-button').focus()
  await page.keyboard.press('Enter')
  await page.locator('#share-icon').click()
  await page.waitForSelector('.nip')
  await page.keyboard.press('Escape')
  check('the island menu has "Icon", and Esc brings the focus back', (await page.locator('.nip').count()) === 0)

  // A page shows it big above its words (wide screen).
  await row('Grocery ideas').click()
  await page.waitForSelector('.page-icon:not(:empty)', { timeout: 15000 })
  const big = await page.locator('.page-icon').boundingBox()
  check('a page note shows the emoji at 64px above its words', big && big.width === 64 && big.height === 64, JSON.stringify(big))
  check('and the island does not repeat it on a wide screen', !(await page.locator('#island-icon').isVisible()))
  const firstLine = await page.locator('.cm-line').first().boundingBox()
  check('the words start below the emoji', firstLine && firstLine.y >= big.y + big.height, JSON.stringify({ firstLine, big }))
  await shot('page')
  await page.locator('.page-icon').click()
  await page.waitForSelector('.nip')
  await page.locator('.nip-grid button', { hasText: '🌱' }).click()
  await settle()
  check('clicking the big emoji changes it', (await stored('Grocery ideas')).icon.emoji === '🌱' && (await page.locator('.page-icon').textContent()) === '🌱')

  // A rename moves a guessed emoji, never a chosen one.
  await page.locator('#share-button').click()
  await page.locator('#note-title').fill('Wedding plans')
  await page.waitForFunction(async (id) => (await (await fetch('/api/notes')).json()).find((note) => note.id === id)?.title === 'Wedding plans', ids['Grocery ideas'], { timeout: 15000 })
  await settle()
  check('a rename keeps a chosen emoji', (await tile('Grocery ideas').textContent()) === '🌱')
  await page.keyboard.press('Escape')

  // A text save in flight owns the revision: an icon change made meanwhile waits for it, and is not refused.
  await row('Grocery ideas').click()
  await page.waitForSelector('.page-icon:not(:empty)', { timeout: 15000 })
  await settle(600)
  let putSeen = false
  await page.route(/\/api\/notes\/\d+$/, async (route) => {
    if (route.request().method() === 'PUT') { putSeen = true; await new Promise((r) => setTimeout(r, 1500)) }
    await route.continue()
  })
  await page.locator('#share-button').click()
  await page.locator('#note-title').fill('Wedding plans two')
  for (let i = 0; i < 100 && !putSeen; i++) await settle(100) // the save is out (and held for 1.5 s)
  await tile('Grocery ideas').click()
  await page.waitForSelector('.nip')
  await page.fill('.nip-in', 'rock')
  await page.locator('.nip-grid button', { hasText: '🚀' }).click()
  await settle(5000)
  const raced = await stored('Grocery ideas')
  check('an icon change made while a text save is in flight waits for it and is kept', putSeen && raced.title === 'Wedding plans two' && raced.icon.emoji === '🚀', JSON.stringify(raced))
  check('and no "Couldn\'t change" toast showed', !(await page.locator('#toast').textContent().then((t) => t.includes("Couldn't change")).catch(() => false)))
  await page.unroute(/\/api\/notes\/\d+$/)

  // It all survives a reload.
  await open()
  check('the choices survive a reload', (await tile('Zzz qqq').textContent()) === '🍳' && (await tile('Startup pitch').textContent()) === '🎯' && (await tile('Grocery ideas').textContent()) === '🚀')

  // The skins, wide and narrow.
  for (const skin of ['crayon', 'paper', 'night']) {
    await page.evaluate((id) => localStorage.setItem('personal-note:skin', id), skin)
    await open()
    await row('Lisbon trip').click()
    await page.waitForSelector('.page-icon:not(:empty)', { timeout: 15000 })
    await settle(400)
    await shot(`${skin}-desktop`)
  }
  await page.evaluate(() => localStorage.setItem('personal-note:skin', 'paper'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await page.waitForSelector('#toggle-sidebar')
  await page.click('#toggle-sidebar')
  await page.waitForSelector('.notebook-tab')
  await settle(500)
  if ((await row('Lisbon trip').count()) === 0) await page.locator('.notebook-tab').first().click()
  await row('Lisbon trip').waitFor()
  await settle(400)
  const phoneTile = await tile('Lisbon trip').boundingBox()
  const phoneRow = await row('Lisbon trip').boundingBox()
  check('on a phone the tile is 32px and the row at least 48px', phoneTile.width === 32 && phoneRow.height >= 48, JSON.stringify({ phoneTile, phoneRow }))
  await shot('paper-phone-list')
  await tile('Lisbon trip').click()
  await settle(600)
  check('on a phone a tap on the tile opens the note like the row (no picker)', (await page.locator('.nip').count()) === 0 && (await page.locator('#note-title').inputValue()) === 'Lisbon trip')
  await page.waitForSelector('#island-icon:not(:empty)')
  await settle(600)
  const hit = await page.locator('#island-icon').boundingBox()
  check('on a phone the island emoji is a 44px-wide target, as tall as the island', hit.width >= 44 && hit.height >= 38, JSON.stringify(hit))
  await page.mouse.click(hit.x + 4, hit.y + hit.height / 2) // beside the 24px tile, inside the button
  await page.waitForSelector('.nip')
  await settle(400)
  const sheet = await page.locator('.nip').boundingBox()
  check('on a phone the picker is a bottom sheet', sheet.y + sheet.height >= 843 && sheet.width === 390, JSON.stringify(sheet))
  const tintBox = await page.locator('.nip-tints button').first().boundingBox()
  check('the sheet\'s tint buttons are at least 44px', tintBox.width >= 44 && tintBox.height >= 44, JSON.stringify(tintBox))
  const cell = await page.locator('.nip-grid button').first().boundingBox()
  check('its emoji are at least 44px targets', cell.height >= 44 && cell.width >= 44, JSON.stringify(cell))
  await shot('paper-phone-picker')
  // Swipe down on the grabber: a small drag springs back, a long one closes.
  const grab = await page.locator('.nip-grab').boundingBox()
  const x = grab.x + grab.width / 2
  const y = grab.y + grab.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + 30, { steps: 4 })
  await page.mouse.up()
  await settle(400)
  check('a short drag down springs back', (await page.locator('.nip').count()) === 1 && (await page.locator('.nip').boundingBox()).y === sheet.y)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + 140, { steps: 8 })
  await page.mouse.up()
  await settle(300)
  check('a drag down past 80px closes the sheet', (await page.locator('.nip').count()) === 0)
  await settle(800)
  check('on a phone a page shows its emoji in the island', await page.locator('#island-icon').isVisible() && !(await page.locator('.page-icon').isVisible()))
  await shot('paper-phone-page')

  check('no errors in the page', errors.length === 0, errors.join(' | '))
  await page.close()
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  fs.rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
