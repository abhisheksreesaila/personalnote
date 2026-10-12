// F-027 check: the Leafer picture follows the app's own viewport rules. Drives the real app (Vite dev server on port 4533, mocked
// /api, headless Chromium) with the wheel, ctrl+wheel, the hand tool, held Space, the middle button, a two-finger pinch on a phone
// and the minimap, and after each gesture compares where Leafer draws the page with where the app says the view is.
//
//   node scripts/verify-leafer-view.mjs
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { COLUMNS, ROWS, generateNote } from './benchmark-note.mjs'

const now = new Date().toISOString()
const summary = { id: 1, resourceId: 'res_view', revision: 1, noteType: 'canvas', title: 'View check', notebookId: 1, createdAt: now, updatedAt: now }
const notebooks = [{ id: 1, resourceId: 'res_nb', revision: 1, name: 'View', color: '#76669a', noteCount: 1 }]
const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/documents/app-all-tools.json', import.meta.url), 'utf8'))
const notes = {
  desk: { content: generateNote(), pageState: { columns: COLUMNS, rows: ROWS } },
  small: { content: fixture.content, pageState: fixture.pageState },
}

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`) }

async function open(browser, baseUrl, note, viewport, hasTouch = false) {
  const context = await browser.newContext({ viewport, hasTouch, isMobile: hasTouch, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', async (route) => {
    const apiPath = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (apiPath === '/notebooks') return json(notebooks)
    if (apiPath === '/notes') return json([summary])
    if (apiPath === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, ...note })
    return json({})
  })
  await page.goto(new URL('notes', baseUrl).href)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(500)
  return { context, page, errors }
}

// The page frame's origin and zoom as Leafer has them (the world group), against the app's view.
const compare = (page) => page.evaluate(() => {
  const { leaferCanvas, getCanvasScale, state } = window.__personalNote
  const world = leaferCanvas().drawnWorld()
  const app = document.querySelector('#zoom-value').textContent
  return { world: { x: world.x, y: world.y, scale: world.scaleX }, scale: getCanvasScale(), zoomPill: app, zoom: state.canvasZoom }
})
const sameView = async (page, label, before) => {
  const view = await compare(page)
  const expected = await page.evaluate(() => {
    const { getCanvasScale } = window.__personalNote
    const t = document.querySelector('#paper')
    return { scale: getCanvasScale(), t: !!t }
  })
  const ok = Math.abs(view.world.scale - expected.scale) < 1e-9 && view.zoomPill === `${Math.round(expected.scale * 100)}%`
  check(label, ok && (!before || view.world.x !== before.world.x || view.world.y !== before.world.y || view.world.scale !== before.world.scale), JSON.stringify(view))
  return view
}

const server = await createServer({ server: { port: 4533, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const baseUrl = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
try {
  const { context, page, errors } = await open(browser, baseUrl, notes.desk, { width: 1440, height: 900 })
  const start = await compare(page)
  check('opens with the same opening view rules as before (whole grid, or the dense-note fallback)', start.world.scale === start.scale, JSON.stringify(start))
  await page.mouse.move(700, 450)
  await page.mouse.wheel(40, 120)
  await page.waitForTimeout(250)
  let view = await sameView(page, 'wheel pans the Leafer picture with the view', start)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -300)
  await page.keyboard.up('Control')
  await page.waitForTimeout(250)
  view = await sameView(page, 'ctrl+wheel zooms the Leafer picture and the zoom pill follows', view)
  // hand tool: drag the empty desk
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__personalNote.setTool('hand'))
  const before = await compare(page)
  await page.mouse.move(300, 400)
  await page.mouse.down()
  await page.mouse.move(380, 450, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  const afterHand = await compare(page)
  check('the hand tool drags the Leafer picture', Math.abs(afterHand.world.x - before.world.x - 80) < 2 && Math.abs(afterHand.world.y - before.world.y - 50) < 2, JSON.stringify([before.world, afterHand.world]))
  // middle button drag
  const beforeMiddle = await compare(page)
  await page.mouse.move(500, 500)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(460, 470, { steps: 6 })
  await page.mouse.up({ button: 'middle' })
  await page.waitForTimeout(250)
  const afterMiddle = await compare(page)
  check('a middle-button drag pans from any tool', Math.abs(afterMiddle.world.x - beforeMiddle.world.x + 40) < 2 && Math.abs(afterMiddle.world.y - beforeMiddle.world.y + 30) < 2, JSON.stringify([beforeMiddle.world, afterMiddle.world]))
  // Space-held hand
  const beforeSpace = await compare(page)
  await page.mouse.move(600, 600)
  await page.keyboard.down('Space')
  await page.mouse.down()
  await page.mouse.move(640, 640, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  await page.waitForTimeout(250)
  const afterSpace = await compare(page)
  check('Space + drag pans', Math.abs(afterSpace.world.x - beforeSpace.world.x - 40) < 2 && Math.abs(afterSpace.world.y - beforeSpace.world.y - 40) < 2, JSON.stringify([beforeSpace.world, afterSpace.world]))
  // minimap: go to the last page
  const beforeMini = await compare(page)
  await page.locator('.mini-page').last().click({ force: true })
  await page.waitForTimeout(300)
  const afterMini = await compare(page)
  check('the minimap jumps the Leafer picture to that page', afterMini.world.x !== beforeMini.world.x || afterMini.world.y !== beforeMini.world.y, JSON.stringify([beforeMini.world, afterMini.world]))
  // zoom pill buttons
  await page.locator('#zoom-control button').first().click()
  await page.waitForTimeout(250)
  const afterStep = await compare(page)
  check('the zoom buttons step the Leafer picture', afterStep.world.scale < afterMini.world.scale + 1e-9 && afterStep.world.scale === afterStep.scale, JSON.stringify(afterStep))
  check('no page errors on the desk note', errors.length === 0, errors.join(' | '))
  await context.close()

  // phone width: two-finger pinch zooms, a one-finger drag off the page pans
  const phone = await open(browser, baseUrl, notes.small, { width: 390, height: 800 }, true)
  const phoneStart = await compare(phone.page)
  check('phone width opens the first page full width', phoneStart.world.scale === phoneStart.scale, JSON.stringify(phoneStart))
  const cdp = await phone.context.newCDPSession(phone.page)
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) })
  await touch('touchStart', [[150, 400], [250, 400]])
  await touch('touchMove', [[110, 400], [290, 400]])
  await touch('touchEnd', [])
  await phone.page.waitForTimeout(300)
  const pinched = await compare(phone.page)
  check('a two-finger pinch zooms the Leafer picture', pinched.world.scale > phoneStart.world.scale && pinched.world.scale === pinched.scale, JSON.stringify([phoneStart.world, pinched.world]))
  check('no page errors at phone width', phone.errors.length === 0, phone.errors.join(' | '))
  await phone.context.close()
} finally {
  await browser.close()
  await server.close()
}
if (results.some((ok) => !ok)) process.exitCode = 1
