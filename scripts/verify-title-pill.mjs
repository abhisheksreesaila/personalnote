// F-075 checks, in the real app (Vite dev server on PN_VERIFY_PORT, mocked in-memory /api, headless Chromium, real mouse and keyboard):
// the top bar is floating islands: a centred title pill (title, save state, a ... menu), and a Focus pill beside the search pill at the top right.
//   - editing the title saves it; a failed save shows in the pill in the danger colour (no modal)
//   - the ... menu holds every old top-bar action and each one works (print preview, picture, backup, Markdown, vault, Clear all + undo, Settings)
//   - the menu works from the keyboard (arrows, Esc back to the button)
//   - the Focus pill enters and leaves focus mode; Ctrl+K opens search from the top right; the old breadcrumb is gone
//   - at 1280x800 and 1440x900 the islands are inset 16px, do not overlap, and a long title stays one line within 40% of the window
//
//   PN_VERIFY_PORT=4895 node scripts/verify-title-pill.mjs      (PN_SHOT=/var/tmp/f075 also saves screenshots)
import { createServer } from 'vite'
import { chromium } from 'playwright'

const PORT = Number(process.env.PN_VERIFY_PORT || 4895)
if (PORT === 3137) throw new Error('never the real app port')
const now = new Date().toISOString()
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
let content = { objects: [] }
let failSave = false
const requests = []
let savedTitle = 'Garden plan'

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': `http://127.0.0.1:${PORT + 1}` } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  const downloads = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('download', (download) => downloads.push(download.suggestedFilename()))
  await context.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    requests.push(`${req.method()} ${p}`)
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const summary = (id) => ({ id, resourceId: `r${id}`, revision: 1, noteType: 'canvas', title: id === 1 ? savedTitle : `Note ${id}`, notebookId: 1, createdAt: now, updatedAt: now })
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'Garden', category: 'projects', color: '#76669a', noteCount: 1 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary(1)])
    if (p.startsWith('/export/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    const m = p.match(/^\/notes\/(\d+)$/)
    if (m && req.method() === 'GET') return json({ ...summary(1), content, pageState: { columns: 1, rows: 1 } })
    if (m && req.method() === 'PUT') {
      if (failSave) return json({ detail: 'Disk is full' }, 500)
      const body = JSON.parse(req.postData() || '{}')
      if (body.title) savedTitle = body.title
      if (body.content) content = body.content
      return json({ revision: 2, resourceId: `r${m[1]}` })
    }
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
  const rect = (selector) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && { x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height } }, selector)
  const center = async (selector) => { const r = await rect(selector); return { x: r.x + r.w / 2, y: r.y + r.h / 2 } }
  const click = async (selector) => { const c = await center(selector); await page.mouse.click(c.x, c.y) }
  const menuHidden = () => page.evaluate(() => document.querySelector('#share-menu').hidden)
  const openMenu = async () => { if (await menuHidden()) await click('#share-button'); await page.waitForTimeout(250) }
  const pickItem = async (id) => { await openMenu(); await click(id); await page.waitForTimeout(250) }
  const inFocus = () => page.evaluate(() => document.querySelector('.app-shell').classList.contains('focus-mode'))
  const overlap = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b

  await load()

  // --- the shape of the islands
  check('the breadcrumb is gone', await page.evaluate(() => !document.querySelector('#breadcrumb')))
  const islands = async () => ({ notes: await rect('#toggle-sidebar'), title: await rect('.topbar-title'), focus: await rect('#focus-button'), search: await rect('#search-button') })
  const layoutChecks = async (label, width, height) => {
    const i = await islands()
    const inset = i.title.y >= 16 && i.focus.y >= 16 && i.search.y >= 16 && i.focus.r <= width - 16 && i.search.r <= width - 16
    check(`${label}: islands sit inside the 16px inset`, inset, JSON.stringify(i))
    check(`${label}: the title pill is centred on the window`, Math.abs((i.title.x + i.title.r) / 2 - width / 2) <= 1, JSON.stringify(i.title))
    check(`${label}: the Focus pill sits beside the search pill, Focus on the left, both at the top right`, i.focus.r < i.search.x && i.search.x > width / 2 && i.focus.x > width / 2 && Math.abs(i.focus.y - i.search.y) <= 4, JSON.stringify(i))
    const names = Object.keys(i)
    let clash = null
    for (const a of names) for (const b of names) if (a < b && overlap(i[a], i[b])) clash = `${a}/${b}`
    check(`${label}: no two islands overlap`, !clash, `${clash} ${JSON.stringify(i)}`)
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).backgroundColor)
    check(`${label}: no full-width bar behind the islands`, bg === 'rgba(0, 0, 0, 0)', bg)
  }
  await layoutChecks('1280x800', 1280, 800)
  check('the search pill lives at the top right now', (await rect('#search-button')).x > 640)
  check('the Focus pill reads Focus with a key cap', await page.evaluate(() => /Focus/.test(document.querySelector('#focus-button').textContent) && /[.]/.test(document.querySelector('#focus-button kbd').textContent)))

  // --- title editing and the save state
  await page.click('#note-title', { clickCount: 3 })
  await page.keyboard.type('Garden plan, revised')
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#save-state').textContent), null, { timeout: 8000 })
  check('editing the title saves it and the pill says so', savedTitle === 'Garden plan, revised' && (await page.inputValue('#note-title')) === 'Garden plan, revised', savedTitle)
  const savedBox = await rect('#save-state')
  const pillBox = await rect('.topbar-title')
  check('the save state is inside the title pill', savedBox.x >= pillBox.x && savedBox.r <= pillBox.r && savedBox.y >= pillBox.y && savedBox.b <= pillBox.b, JSON.stringify({ savedBox, pillBox }))
  failSave = true
  await page.click('#note-title', { clickCount: 3 })
  await page.keyboard.type('Garden plan, third')
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => document.querySelector('#save-state').classList.contains('error'), null, { timeout: 8000 })
  const err = await page.evaluate(() => { const s = document.querySelector('#save-state'); const d = document.querySelector('#save-state > span'); return { text: s.textContent, color: getComputedStyle(s).color, dot: getComputedStyle(d).backgroundColor, danger: getComputedStyle(document.documentElement).getPropertyValue('--sk-danger').trim(), modal: !!document.querySelector('dialog[open]') } })
  check('a failed save shows its error in the pill, not in a modal', err.text.length > 0 && !/^Saved/.test(err.text) && !err.modal, JSON.stringify(err))
  const dangerRgb = await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--sk-danger)'; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c })
  check('the error is in the danger colour', err.color === dangerRgb, `${err.color} vs ${dangerRgb}`)
  failSave = false
  await page.click('#note-title')
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#save-state').textContent), null, { timeout: 8000 })
  check('the error clears when a save works again', !(await page.evaluate(() => document.querySelector('#save-state').classList.contains('error'))))

  // --- the menu holds everything the top right used to hold
  await openMenu()
  const labels = await page.evaluate(() => [...document.querySelectorAll('#share-menu button:not([hidden])')].map((b) => b.querySelector('span')?.textContent.trim()))
  check('the menu lists print, picture, backup, Markdown, vault, Clear all and Settings (Fold all only when it shows)', JSON.stringify(labels) === JSON.stringify(['Print preview', 'Note as picture (PNG)', 'Download backup', 'Markdown + assets', 'Obsidian vault', 'Clear all', 'Settings and properties']), JSON.stringify(labels))
  check('the print item shows its key cap', await page.evaluate(() => /[PK]/.test(document.querySelector('#print-kbd').textContent)))
  const menuBox = await rect('#share-menu')
  check('the menu opens under the pill, inside the window', menuBox.y > pillBox.b - 1 && menuBox.r <= 1280 && menuBox.x >= 0 && menuBox.b <= 800, JSON.stringify(menuBox))
  // keyboard: arrows move, Esc closes and returns to the button
  const firstFocus = await page.evaluate(() => document.activeElement.id)
  await page.keyboard.press('ArrowDown')
  const secondFocus = await page.evaluate(() => document.activeElement.id)
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  const wrapFocus = await page.evaluate(() => document.activeElement.id)
  check('arrows move through the items and wrap', firstFocus === 'share-print' && secondFocus === 'share-png' && wrapFocus === 'top-properties', `${firstFocus} ${secondFocus} ${wrapFocus}`)
  await page.keyboard.press('Escape')
  check('Esc closes the menu and returns to the ... button', (await menuHidden()) && (await page.evaluate(() => document.activeElement.id)) === 'share-button')
  await openMenu()
  await page.mouse.click(640, 500)
  check('a click on the desk closes the menu', await menuHidden())

  // each item, with the real mouse
  await pickItem('#share-print')
  check('Print preview opens from the menu', await page.evaluate(() => !document.querySelector('#print-preview').hidden))
  await click('#close-print')
  await page.waitForTimeout(300)
  check('closing the preview returns to the page', await page.evaluate(() => document.querySelector('#print-preview').hidden))
  await page.keyboard.press('Control+p')
  await page.waitForTimeout(300)
  check('Ctrl+P still opens the print preview', await page.evaluate(() => !document.querySelector('#print-preview').hidden))
  await click('#close-print')
  await page.waitForTimeout(300)

  const downloadsBefore = downloads.length
  await pickItem('#share-png')
  await page.waitForTimeout(1500)
  check('Note as picture downloads a PNG named after the title', downloads.slice(downloadsBefore).some((n) => /^Garden plan, third!\.png$/.test(n)), JSON.stringify(downloads))
  for (const [id, path] of [['#share-backup', '/export/workspace'], ['#share-markdown', '/export/markdown'], ['#share-vault', '/export/vault']]) {
    await pickItem(id)
    await page.waitForTimeout(600)
    check(`${id.slice(7)} asks the app for ${path}`, requests.includes(`GET ${path}`), requests.filter((r) => r.includes('export')).join(','))
  }

  // Clear all with undo
  await load()
  await page.waitForTimeout(500)
  const host = await rect('#leafer-host')
  await page.mouse.click(host.x + 200, host.y + 200)
  await page.waitForTimeout(500)
  await page.keyboard.type('Plant the beans first')
  await page.waitForTimeout(900)
  await page.keyboard.press('Escape')
  const words = () => page.evaluate(() => JSON.stringify(window.__personalNote.leaferEdits.doc))
  const before = await words()
  check('the note has words to clear', /Plant the beans/.test(before), before.slice(0, 200))
  await pickItem('#clear-note')
  check('Clear all empties the note', !/Plant the beans/.test(await words()))
  check('and offers Undo', await page.evaluate(() => /Undo/.test(document.body.innerText)))
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click()
  await page.waitForTimeout(500)
  check('Undo brings the words back', /Plant the beans/.test(await words()))

  // Settings
  await pickItem('#top-properties')
  check('Settings and properties opens its panel from the menu', await page.evaluate(() => document.querySelector('#properties-panel').classList.contains('open')))
  await click('#close-properties')
  await page.waitForTimeout(400)
  await page.keyboard.press('Escape')
  await shot('1280x800-menu-closed')
  await openMenu()
  await shot('1280x800-menu-open')
  await page.keyboard.press('Escape')

  // --- Focus pill and search pill
  const islandsBeforeFocus = JSON.stringify(await islands())
  await click('#focus-button')
  await page.waitForTimeout(700)
  check('the Focus pill enters focus mode and hides every island', (await inFocus()) && await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).display === 'none'))
  check('the notes button is hidden with the rest in focus mode', (await rect('#toggle-sidebar')).w === 0)
  await shot('focus')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  check('Esc leaves focus mode and the islands are back where they were', !(await inFocus()) && JSON.stringify(await islands()) === islandsBeforeFocus)
  await page.keyboard.press('Control+.')
  await page.waitForTimeout(700)
  check('Ctrl+. still enters focus mode', await inFocus())
  await page.keyboard.press('Control+.')
  await page.waitForTimeout(700)
  check('and leaves it', !(await inFocus()))
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(400)
  check('Ctrl+K opens the search panel, large and centred', await page.evaluate(() => { const p = document.querySelector('.spotlight'); if (!p) return false; const r = p.getBoundingClientRect(); return r.width >= 400 && Math.abs((r.x + r.right) / 2 - innerWidth / 2) <= 2 }))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await click('#search-button')
  await page.waitForTimeout(400)
  check('clicking the search pill at the top right opens it too', await page.evaluate(() => !!document.querySelector('.spotlight')?.getBoundingClientRect().width))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // --- a long title, and the other size
  const longTitle = 'A very long title that goes on and on about the whole garden plan for the spring season and beyond it'
  await page.click('#note-title', { clickCount: 3 })
  await page.keyboard.type(longTitle)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(300)
  const long = await rect('.topbar-title')
  check('a long title stays one line inside 40% of the window', long.w <= 1280 * 0.4 + 1 && long.h <= 48, JSON.stringify(long))
  await layoutChecks('1280x800 long title', 1280, 800)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(400)
  await layoutChecks('1440x900 long title', 1440, 900)
  await page.click('#note-title', { clickCount: 3 })
  await page.keyboard.type('Garden plan')
  await page.keyboard.press('Tab')
  await page.waitForTimeout(300)
  await layoutChecks('1440x900', 1440, 900)
  await shot('1440x900-menu-closed')
  await openMenu()
  await shot('1440x900-menu-open')
  await page.keyboard.press('Escape')

  // --- the middle widths, where the right-hand pills shrink
  for (const [w, h] of [[1101, 800], [1000, 700], [820, 700]]) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(400)
    await page.click('#note-title', { clickCount: 3 })
    await page.keyboard.type(longTitle)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)
    await layoutChecks(`${w}x${h} long title`, w, h)
  }

  // --- a narrow window keeps the ... reachable
  await page.setViewportSize({ width: 390, height: 780 })
  await page.waitForTimeout(400)
  const more = await rect('#share-button')
  check('on a phone width the ... button is on screen and the menu opens', more && more.r <= 390 && more.x >= 0 && more.w > 0)
  await click('#share-button')
  await page.waitForTimeout(300)
  const narrowMenu = await rect('#share-menu')
  check('the menu stays inside a narrow window', !(await menuHidden()) && narrowMenu.x >= 0 && narrowMenu.r <= 390, JSON.stringify(narrowMenu))
  await page.keyboard.press('Escape')

  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} of ${results.length} FAILED` : `all ${results.length} passed`)
process.exit(failed ? 1 : 0)
