// F-074 checks, in the real app (Vite dev server on PN_VERIFY_PORT, mocked in-memory /api, headless Chromium, real mouse and keyboard):
// the one round notes button at the top left opens the sidebar as a floating panel over the desk.
//   - closed by default; the button is a 44px circle; opening does not move or resize the paper; no scrim on a wide window
//   - Esc and a click on the desk close it; the choice survives a reload; a broken localStorage does not break the app
//   - opening a note keeps it open on a wide window and closes it on a narrow one (where the scrim is back)
//   - the panel's Quick note button, rows and skin dots are really clickable (nothing covers them)
//
//   PN_VERIFY_PORT=4891 node scripts/verify-notes-panel.mjs      (PN_SHOT=/var/tmp/f074 also saves screenshots)
import { createServer } from 'vite'
import { chromium } from 'playwright'

const PORT = Number(process.env.PN_VERIFY_PORT || 4891)
if (PORT === 3137) throw new Error('never the real app port')
const now = new Date().toISOString()
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const content = { objects: [] }

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': `http://127.0.0.1:${PORT + 1}` } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await context.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    const summary = (id) => ({ ...(id === 3 ? { secure: true } : {}), id, resourceId: `r${id}`, revision: 1, noteType: 'canvas', title: `Note ${id}`, notebookId: 1, createdAt: now, updatedAt: now })
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'Garden', category: 'projects', color: '#76669a', noteCount: 2 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary(1), summary(2), summary(3)])
    const m = p.match(/^\/notes\/(\d+)$/)
    if (m && req.method() === 'GET') return json({ ...summary(Number(m[1])), ...(m[1] === '3' ? { locked: true, content: null, pageState: null } : { content, pageState: { columns: 1, rows: 1 } }) })
    if (m && req.method() === 'PUT') return json({ revision: 2, resourceId: `r${m[1]}` })
    if (p.startsWith('/changes')) return json({ sequence: 1, changes: [], agents: [] })
    return json({})
  })
  const url = `http://127.0.0.1:${PORT}/notes`
  const load = async () => {
    await page.goto(url)
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
    await page.waitForTimeout(400)
  }
  const shot = async (name) => { if (process.env.PN_SHOT) await page.screenshot({ path: `${process.env.PN_SHOT}-${name}.png` }) }
  const isOpen = () => page.evaluate(() => document.querySelector('#sidebar').classList.contains('open'))
  const visible = () => page.evaluate(() => { const s = getComputedStyle(document.querySelector('#sidebar')); return s.visibility !== 'hidden' && Number(s.opacity) > 0.99 })
  const paper = () => page.evaluate(() => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(',') })
  const scrimShown = () => page.evaluate(() => getComputedStyle(document.querySelector('#sidebar-scrim')).display !== 'none')
  const toggleBox = () => page.evaluate(() => { const r = document.querySelector('#toggle-sidebar').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  const clickToggle = async () => { const b = await toggleBox(); await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2) }
  const settleFade = () => page.waitForTimeout(300)

  await load()
  const b = await toggleBox()
  check('closed by default', !(await isOpen()) && !(await visible()))
  check('the notes button is a 44px circle at the top left', b.w === 44 && b.h === 44 && b.x === 16 && b.y === 16, JSON.stringify(b))
  check('it is a panel icon, not a hamburger', await page.evaluate(() => document.querySelector('#toggle-sidebar svg, #toggle-sidebar i')?.getAttribute('data-lucide') === 'panel-left' || !!document.querySelector('#toggle-sidebar svg.lucide-panel-left')))
  const closedPaper = await paper()
  await shot('closed-1280x800')

  await clickToggle()
  await settleFade()
  check('the button opens the panel', (await isOpen()) && (await visible()))
  check('opening the panel does not move or resize the paper', (await paper()) === closedPaper, `${closedPaper} -> ${await paper()}`)
  const geo = await page.evaluate(() => { const r = document.querySelector('#sidebar').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, bottom: innerHeight - r.bottom } })
  check('the panel floats 16px in from the left and bottom, 280px wide, 72px from the top', geo.x === 16 && geo.w === 280 && geo.y === 72 && geo.bottom === 16, JSON.stringify(geo))
  check('no scrim on a wide window', !(await scrimShown()))
  check('the button reads as pressed', await page.evaluate(() => document.querySelector('#toggle-sidebar').getAttribute('aria-expanded') === 'true'))
  await shot('open-1280x800')

  const hit = (selector) => page.evaluate((sel) => { const el = document.querySelector(sel); const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!at && (el === at || el.contains(at)) }, selector)
  check('Quick note, the shelves and the skin dots are clickable inside the panel', (await hit('#rail-new-note')) && (await hit('#notebook-list [data-note-id]')) && (await hit('.skin-swatch')))
  const skinBefore = await page.evaluate(() => document.documentElement.dataset.skin)
  await page.click('.skin-swatch:nth-child(3)')
  const skinAfter = await page.evaluate(() => document.documentElement.dataset.skin)
  check('a skin dot changes the skin from inside the panel', skinAfter && skinAfter !== skinBefore, `${skinBefore} -> ${skinAfter}`)
  check('the panel stays open after using it', await isOpen())

  await page.keyboard.press('Escape')
  await settleFade()
  check('Esc closes the panel', !(await isOpen()) && !(await visible()))
  check('closing does not move the paper', (await paper()) === closedPaper)

  await clickToggle()
  await settleFade()
  const desk = { x: 900, y: 600 }
  await page.mouse.click(desk.x, desk.y)
  await settleFade()
  check('a click on the desk closes the panel', !(await isOpen()))

  await clickToggle()
  await settleFade()
  await page.click('#notebook-list [data-note-id="2"]')
  await page.waitForFunction(() => window.__personalNote.state.activeNoteId === 2)
  await settleFade()
  check('opening a note keeps the panel open on a wide window', await isOpen())

  // a locked secure note covers the desk; the notes button and the panel must stay reachable above that cover
  await page.click('#notebook-list [data-note-id="3"]')
  await page.waitForFunction(() => window.__personalNote.state.activeNoteId === 3 && document.querySelector('.secure-cover'))
  await settleFade()
  const overToggle = async () => page.evaluate(() => { const r = document.querySelector('#toggle-sidebar').getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!at?.closest('#toggle-sidebar') })
  check('with a locked note open, the notes button is what is under the pointer', await overToggle())
  check('and the panel is clickable over the cover', await page.evaluate(() => { const r = document.querySelector('#notebook-list [data-note-id="1"]').getBoundingClientRect(); return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('#sidebar') }))
  await page.keyboard.press('Escape')
  await settleFade()
  check('Esc closes the panel over a locked note', !(await isOpen()))
  await clickToggle()
  await settleFade()
  check('the button opens it again over the cover', await isOpen())
  await page.click('#notebook-list [data-note-id="2"]')
  await page.waitForFunction(() => window.__personalNote.state.activeNoteId === 2)
  await settleFade()

  // the Quick note hold menu: Esc closes the menu first and leaves the panel open
  const rq = await page.evaluate(() => { const r = document.querySelector('#rail-new-note').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  await page.mouse.move(rq.x, rq.y)
  await page.mouse.down()
  await page.waitForFunction(() => !document.querySelector('#note-create-menu').hidden, null, { timeout: 4000 })
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await settleFade()
  check('Esc with the Quick note menu open closes only the menu', await page.evaluate(() => document.querySelector('#note-create-menu').hidden) && (await isOpen()))
  await page.keyboard.press('Escape')
  await settleFade()
  check('a second Esc closes the panel', !(await isOpen()))
  await clickToggle()
  await settleFade()

  await load()
  check('open survives a reload', (await isOpen()) && (await visible()))
  await page.keyboard.press('Escape')
  await settleFade()
  await load()
  check('closed survives a reload', !(await isOpen()))

  // storage that throws must not break the app
  const blocked = await context.newPage()
  await blocked.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied') } }) })
  const blockedErrors = []
  blocked.on('pageerror', (error) => blockedErrors.push(String(error)))
  await blocked.goto(url)
  await blocked.waitForSelector('#toggle-sidebar')
  await blocked.click('#toggle-sidebar')
  check('with localStorage blocked the button still opens the panel', await blocked.evaluate(() => document.querySelector('#sidebar').classList.contains('open')), blockedErrors.join('; '))
  await blocked.close()

  // 1440x900
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(300)
  await shot('closed-1440x900')
  await clickToggle()
  await settleFade()
  await shot('open-1440x900')
  await page.keyboard.press('Escape')

  // narrow
  await page.setViewportSize({ width: 600, height: 900 })
  await page.waitForTimeout(400)
  check('narrow: closed', !(await isOpen()))
  await clickToggle()
  await page.waitForTimeout(500)
  check('narrow: the scrim is back with the panel', (await isOpen()) && (await scrimShown()))
  await page.click('#notebook-list [data-note-id="1"]')
  await page.waitForTimeout(500)
  check('narrow: opening a note closes the panel', !(await isOpen()))

  check('no page errors', errors.length === 0, errors.join('; '))
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
