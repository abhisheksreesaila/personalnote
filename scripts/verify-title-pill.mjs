// F-075 and F-084 checks, in the real app (Vite dev server on PN_VERIFY_PORT, mocked in-memory /api, headless Chromium, real mouse and keyboard):
// the top of the window is three islands: the notes circle (top left), the dynamic island with the note's title (top centre), the search circle (top right).
//   - at rest the island is only the title; a click opens the card (editable title, where it is saved, Focus first, then every old ... menu action)
//   - editing the title saves it; a failed save shows in the card's save state AND on the island (danger colour, reason, Try again), never in a modal
//   - every old menu action is on the card and works (print preview, picture, backup, Markdown, vault, Clear all + undo, Settings), from the mouse and the keyboard
//   - the Focus pill is gone: Focus is the card's first action; the island wears the focus face in focus mode; Ctrl+K opens search from the top right circle
//   - the agent chip is gone: an agent shows as a face on the island, cut before it reaches the circles
//   - at 1280x800 and 1440x900 the islands are inset 16px, do not overlap, and a long title stays one line within 300px
//
//   PN_VERIFY_PORT=4895 node scripts/verify-title-pill.mjs      (PN_SHOT=/var/tmp/f084 also saves screenshots)
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const PORT = basePort(4895)
await assertPortsFree([PORT])
const now = new Date().toISOString()
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
let content = { objects: [] }
let failSave = false
let agents = []
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
      if (failSave) return json({ error: 'Disk is full' }, 500)
      const body = JSON.parse(req.postData() || '{}')
      if (body.title) savedTitle = body.title
      if (body.content) content = body.content
      return json({ revision: 2, resourceId: `r${m[1]}` })
    }
    if (p.startsWith('/changes')) return json({ sequence: 1, changes: [], agents })
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
  // the island has stopped growing or shrinking (its width/height transition and the faces' fades are over)
  const settle = () => page.waitForFunction(() => document.querySelector('#island').getAnimations({ subtree: true }).every((a) => a.effect.getComputedTiming().iterations === Infinity), null, { timeout: 5000 })
  const cardHidden = () => page.evaluate(() => document.querySelector('#share-menu').hidden)
  const openCard = async () => { if (await cardHidden()) await click('#island'); await settle() }
  const pickItem = async (id) => { await openCard(); await click(id); await page.waitForTimeout(250) }
  const face = () => page.evaluate(() => document.querySelector('#island').dataset.face)
  const inFocus = () => page.evaluate(() => document.querySelector('.app-shell').classList.contains('focus-mode'))
  const overlap = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b

  await load()

  // --- the shape of the islands
  check('the breadcrumb is gone', await page.evaluate(() => !document.querySelector('#breadcrumb')))
  check('the Focus pill and the agent chip are gone', await page.evaluate(() => !document.querySelector('#focus-button') && !document.querySelector('#agent-chip') && !document.querySelector('.focus-pill')))
  const islands = async () => ({ notes: await rect('#toggle-sidebar'), island: await rect('#island'), search: await rect('#search-button') })
  const layoutChecks = async (label, width, height) => {
    await settle()
    const i = await islands()
    check(`${label}: islands sit inside the 16px inset`, i.island.y >= 16 && i.search.y >= 16 && i.search.r <= width - 16, JSON.stringify(i))
    check(`${label}: the island is centred on the window`, Math.abs((i.island.x + i.island.r) / 2 - width / 2) <= 1, JSON.stringify(i.island))
    check(`${label}: the search circle is at the top right, level with the island`, i.search.x > width / 2 && Math.abs(i.search.y - i.island.y) <= 1 && i.search.w === i.search.h, JSON.stringify(i))
    const names = Object.keys(i)
    let clash = null
    for (const a of names) for (const b of names) if (a < b && overlap(i[a], i[b])) clash = `${a}/${b}`
    check(`${label}: no two islands overlap`, !clash, `${clash} ${JSON.stringify(i)}`)
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).backgroundColor)
    check(`${label}: no full-width bar behind the islands`, bg === 'rgba(0, 0, 0, 0)', bg)
  }
  await layoutChecks('1280x800', 1280, 800)
  const rest = await page.evaluate(() => ({ text: document.querySelector('#island').innerText.trim(), cardHidden: document.querySelector('#share-menu').hidden, saveShown: document.querySelector('#save-state').getBoundingClientRect().width }))
  check('at rest the island is only the title: no save text, no menu button', rest.text === 'Garden plan' && rest.cardHidden && rest.saveShown === 0, JSON.stringify(rest))
  check('at rest it is one line, 44px high, at most 300px of title', (await rect('#island')).h === 44 && (await rect('#island')).w <= 300 + 36 + 2)
  await shot('1280x800-rest')

  // --- the card: the title, the save state, Focus first and wide, every old action
  await openCard()
  const labels = await page.evaluate(() => [...document.querySelectorAll('#share-menu button:not([hidden])')].map((b) => b.querySelector('span')?.textContent.trim()))
  check('the card lists Focus first, then print, picture, backup, Markdown, Obsidian, Icon, Link note, Settings and Clear all (Fold all only when it shows)', JSON.stringify(labels) === JSON.stringify(['Focus', 'Print', 'Picture', 'Backup', 'Markdown', 'Obsidian', 'Icon', 'Link note', 'Settings', 'Clear all']), JSON.stringify(labels))
  const tiles = await page.evaluate(() => { const w = (s) => document.querySelector(s).getBoundingClientRect(); return { focus: w('#share-focus'), print: w('#share-print'), focusKbd: /[.]/.test(document.querySelector('#focus-top-kbd').textContent), printTitle: document.querySelector('#share-print').title } })
  check('Focus is wide, above the others, and shows its key cap; Print\'s tooltip has its shortcut', tiles.focus.width > tiles.print.width * 3 && tiles.focus.bottom <= tiles.print.top && tiles.focusKbd && /[PK]|Ctrl|⌘/.test(tiles.printTitle) && /P\)$/.test(tiles.printTitle), JSON.stringify(tiles))
  const card = await rect('#island')
  check('the card is 420px wide, centred, opens from the top of the island and stays inside the window', Math.abs(card.w - 422) <= 2 && Math.abs((card.x + card.r) / 2 - 640) <= 1 && card.y === (await rect('#toggle-sidebar')).y && card.b <= 800, JSON.stringify(card))
  const meta = await page.evaluate(() => ({ saved: document.querySelector('#save-state').textContent, notebook: document.querySelector('#island-notebook').textContent, title: document.querySelector('#note-title').value }))
  check('the card shows the editable title, where it is saved and the notebook', meta.title === 'Garden plan' && /^Saved on this/.test(meta.saved) && meta.notebook === 'Garden', JSON.stringify(meta))
  await shot('1280x800-card')

  // --- title editing and the save state
  await page.click('#note-title', { clickCount: 3 })
  await page.keyboard.type('Garden plan, revised')
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#save-state').textContent), null, { timeout: 8000 })
  check('editing the title saves it', savedTitle === 'Garden plan, revised' && (await page.inputValue('#note-title')) === 'Garden plan, revised', savedTitle)
  await page.keyboard.press('Enter')
  await settle()
  check('Enter in the title closes the card, and the island shows the new title', (await cardHidden()) && (await page.evaluate(() => document.querySelector('#island').innerText.trim())) === 'Garden plan, revised')
  await openCard()
  failSave = true
  await page.click('#note-title', { clickCount: 3 })
  await page.keyboard.type('Garden plan, third')
  await page.waitForFunction(() => document.querySelector('#save-state').classList.contains('error'), null, { timeout: 8000 })
  const err = await page.evaluate(() => { const s = document.querySelector('#save-state'); return { text: s.textContent, color: getComputedStyle(s).color, modal: !!document.querySelector('dialog[open]') } })
  const dangerRgb = await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--sk-danger)'; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c })
  check('a failed save shows its error on the card, in the danger colour, not in a modal', err.text.length > 0 && !/^Saved/.test(err.text) && !err.modal && err.color === dangerRgb, JSON.stringify(err))
  await page.keyboard.press('Escape')
  await settle()
  const bad = await page.evaluate(() => { const i = document.querySelector('#island'); return { face: i.dataset.face, text: i.innerText.replace(/\s+/g, ' ').trim(), border: getComputedStyle(i).borderColor, retry: Boolean(i.querySelector('[data-island-action="retry"]')) } })
  check('with the card closed the island itself says it: Couldn\'t save, why, and Try again (it stays)', bad.face === 'error' && /Couldn’t save/.test(bad.text) && /Disk is full/.test(bad.text) && bad.retry && bad.border !== (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sk-edge'))), JSON.stringify(bad))
  await shot('1280x800-error')
  await page.waitForTimeout(1500)
  check('and it is still there a moment later', (await face()) === 'error')
  failSave = false
  await click('[data-island-action="retry"]')
  await page.waitForFunction(() => document.querySelector('#island').dataset.face !== 'error', null, { timeout: 8000 })
  check('Try again saves, and the error goes (the island says Saved, then rests)', savedTitle === 'Garden plan, third')
  await page.waitForFunction(() => document.querySelector('#island').dataset.face === 'rest', null, { timeout: 4000 })
  await settle()
  const backTitle = await page.evaluate(() => document.querySelector('#island').innerText.trim())
  check('the island is back to the title', backTitle === 'Garden plan, third', JSON.stringify(backTitle))

  // --- the card from the keyboard
  await page.focus('#share-button')
  await page.keyboard.press('Enter')
  await settle()
  const firstFocus = await page.evaluate(() => document.activeElement.id)
  await page.keyboard.press('ArrowDown')
  const secondFocus = await page.evaluate(() => document.activeElement.id)
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  const titleFocus = await page.evaluate(() => document.activeElement.id)
  await page.keyboard.press('ArrowUp')
  const wrapFocus = await page.evaluate(() => document.activeElement.id)
  check('Enter opens the card on Focus; arrows move through the actions, up reaches the title, and it wraps', firstFocus === 'share-focus' && secondFocus === 'share-print' && titleFocus === 'note-title' && wrapFocus === 'clear-note', `${firstFocus} ${secondFocus} ${titleFocus} ${wrapFocus}`)
  await page.keyboard.press('Escape')
  await settle()
  check('Esc closes the card and returns to the island', (await cardHidden()) && (await page.evaluate(() => document.activeElement.id)) === 'share-button')
  await page.keyboard.press('Space')
  await settle()
  check('Space opens it too', !(await cardHidden()))
  await page.mouse.click(640, 500)
  await settle()
  check('a click on the desk closes the card', await cardHidden())

  // each item, with the real mouse
  await pickItem('#share-print')
  check('Print opens the preview from the card', await page.evaluate(() => !document.querySelector('#print-preview').hidden))
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
  check('Picture downloads a PNG named after the title', downloads.slice(downloadsBefore).some((n) => /^Garden plan, third\.png$/.test(n)), JSON.stringify(downloads))
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
  check('Settings opens its panel from the card', await page.evaluate(() => document.querySelector('#properties-panel').classList.contains('open')))
  await click('#close-properties')
  await page.waitForTimeout(400)
  await page.keyboard.press('Escape')

  // --- Focus is on the card; the island wears the focus face; Ctrl+K opens search from the circle
  const islandsBeforeFocus = JSON.stringify(await islands())
  await pickItem('#share-focus')
  await page.waitForTimeout(700)
  check('Focus on the card enters focus mode and hides the other islands', (await inFocus()) && await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).display === 'none'))
  check('the island wears the focus face there (out of sight until the mouse goes to the top)', (await face()) === 'focus' && await page.evaluate(() => getComputedStyle(document.querySelector('#island')).opacity === '0'))
  check('the notes button is hidden with the rest in focus mode', (await rect('#toggle-sidebar')).w === 0)
  await page.mouse.move(640, 20)
  await page.waitForTimeout(400)
  await shot('focus')
  await page.mouse.move(640, 400)
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
  await page.waitForTimeout(500)
  check('Ctrl+K opens the search field at the top right, growing from the circle', await page.evaluate(() => { const p = document.querySelector('.spotlight'); const b = document.querySelector('#search-button').getBoundingClientRect(); if (!p) return false; const r = p.getBoundingClientRect(); return r.width >= 370 && Math.abs(r.right - b.right) <= 2 && Math.abs(r.top - b.top) <= 2 }))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await click('#search-button')
  await page.waitForTimeout(500)
  check('clicking the search circle opens it too', await page.evaluate(() => document.querySelector('.spotlight')?.getBoundingClientRect().width >= 370))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // --- a long title, and the other size
  const longTitle = 'A very long title that goes on and on about the whole garden plan for the spring season and beyond it'
  const setTitle = async (text) => {
    await openCard()
    await page.click('#note-title', { clickCount: 3 })
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    await settle()
  }
  await setTitle(longTitle)
  const long = await rect('#island')
  check('a long title stays one line, cut with an ellipsis, in at most 300px of text', long.w <= 300 + 36 + 2 && long.h === 44 && await page.evaluate(() => { const t = document.querySelector('#island-title'); return t.scrollWidth > t.clientWidth && getComputedStyle(t).textOverflow === 'ellipsis' }), JSON.stringify(long))
  await layoutChecks('1280x800 long title', 1280, 800)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(400)
  await layoutChecks('1440x900 long title', 1440, 900)
  await setTitle('Garden plan')
  await layoutChecks('1440x900', 1440, 900)
  await shot('1440x900-rest')

  // --- an agent: a face on the island, in place of the old chip; a long name is cut, never reaching the circles
  agents = [{ agent: 'Claude Code', action: 'writing', noteId: 1, noteTitle: 'Garden plan' }]
  for (const [w, h] of [[1280, 800], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(400)
    await setTitle(longTitle)
    await page.waitForFunction(() => document.querySelector('#island').dataset.face === 'agent', null, { timeout: 8000 })
    await settle()
    const label = await page.evaluate(() => document.querySelector('#island').innerText.trim())
    check(`${w}: the island reads the agent and what it does`, label === 'Claude Code is writing', label)
    check(`${w}: it is announced politely to screen readers`, await page.evaluate(() => document.querySelector('.isl-moment').getAttribute('aria-live') === 'polite' && document.querySelector('.isl-moment').getAttribute('role') === 'status'))
    await layoutChecks(`${w}x${h} long title with an agent at work`, w, h)
    await shot(`${w}x${h}-agent`)
    await click('#island')
    await settle()
    check(`${w}: with the agent face showing, a click still opens the card`, !(await cardHidden()))
    await page.keyboard.press('Escape')
  }
  agents = [{ agent: 'A remarkably verbose local agent called Claude Code Deluxe', action: 'writing', noteId: 1, noteTitle: 'x' }]
  await page.waitForFunction(() => /verbose/.test(document.querySelector('#island').innerText), null, { timeout: 8000 })
  await settle()
  const longAgent = await islands()
  check('a very long agent label is cut before it reaches the circles', longAgent.island.x > longAgent.notes.r + 8 && longAgent.island.r < longAgent.search.x - 8, JSON.stringify(longAgent))
  agents = []
  await page.waitForFunction(() => document.querySelector('#island').dataset.face === 'rest', null, { timeout: 8000 })

  // --- keyboard: Tab out of the card closes it; Settings opened by keyboard gives focus back on Esc
  await page.focus('#share-button')
  await page.keyboard.press('Enter')
  await settle()
  for (let i = 0; i < 12 && !(await cardHidden()); i++) await page.keyboard.press('Tab')
  check('Tab out of the open card closes it, focus does not fall to the page', (await cardHidden()) && (await page.evaluate(() => document.activeElement !== document.body)))
  await page.focus('#share-button')
  await page.keyboard.press('Enter')
  await settle()
  await page.keyboard.press('ArrowUp') // (the title)
  await page.keyboard.press('ArrowUp') // (wraps to Clear all)
  await page.keyboard.press('ArrowUp')
  const settingsFocus = await page.evaluate(() => document.activeElement.id)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  check('Settings opens from the card by keyboard', settingsFocus === 'top-properties' && await page.evaluate(() => document.querySelector('#properties-panel').classList.contains('open')), settingsFocus)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('Esc closes Settings and puts the focus back on the island', (await page.evaluate(() => !document.querySelector('#properties-panel').classList.contains('open'))) && (await page.evaluate(() => document.activeElement.id)) === 'share-button')

  // --- the middle widths
  for (const [w, h] of [[1101, 800], [1000, 700], [820, 700]]) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(400)
    await setTitle(longTitle)
    await layoutChecks(`${w}x${h} long title`, w, h)
  }

  // --- a phone width: the island reaches its card, which fits
  await page.setViewportSize({ width: 390, height: 780 })
  await page.waitForTimeout(500)
  await settle()
  const more = await rect('#island')
  check('on a phone width the island is on screen, at least 40px high, and between the two circles', more && more.x >= 56 && more.r <= 390 - 56 && more.h >= 40, JSON.stringify(more))
  await click('#island')
  await settle()
  const narrowCard = await rect('#island')
  check('the card stays inside a narrow window and is 350px wide', !(await cardHidden()) && narrowCard.x >= 0 && narrowCard.r <= 390 && Math.abs(narrowCard.w - 352) <= 2, JSON.stringify(narrowCard))
  await shot('390-card')
  await page.keyboard.press('Escape')

  // --- the same island on the Mac host (the traffic lights push the bar to the right on narrow windows)
  await page.goto(`${url}?host=desktop&chrome=mac`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  agents = [{ agent: 'A remarkably verbose local agent called Claude Code Deluxe', action: 'writing', noteId: 1, noteTitle: 'x' }]
  for (const [w, h] of [[1101, 800], [1280, 800], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForFunction(() => document.querySelector('#island').dataset.face === 'agent', null, { timeout: 8000 })
    await settle()
    const m = await islands()
    check(`mac host ${w}: the island clears the notes button and the search circle`, m.island.x >= m.notes.r + 8 && m.island.r <= m.search.x - 8, JSON.stringify(m))
    check(`mac host ${w}: no two islands overlap`, !Object.keys(m).some((a) => Object.keys(m).some((b) => a < b && overlap(m[a], m[b]))), JSON.stringify(m))
  }

  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} of ${results.length} FAILED` : `all ${results.length} passed`)
process.exit(failed ? 1 : 0)
