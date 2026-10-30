// F-105..F-109 checks: mind-map boxes that fit their text, icons, the pencil strike, x of y done and due dates, in the real app.
// The Vite dev server on PN_VERIFY_PORT (never 3137) in front of the real API on the next port, a scratch database (PERSONAL_NOTE_DB),
// headless Chromium. Phone width first, then desktop.
//   F-105  a long label wraps onto lines and the box grows; the drawn text fits inside its box; a bigger font makes a wider box
//   F-106  the Properties panel has 12 icons; tapping toggles them on the selected node (3 at most); they draw before the words and the box grows; saved and back after a reload
//   F-105 fix  editing the long label shows the same lines as the drawn box; Enter commits (no newline in the text); a pasted line break becomes a space
//   F-110 jump  a reminder jump selects its node and brings it to the middle of the view
//
//   PN_VERIFY_PORT=4940 node scripts/verify-mindmap-todos.mjs        (PN_SHOT=/path/shot.png also saves pictures)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4940)
const API_PORT = UI_PORT + 1
await assertPortsFree([UI_PORT, API_PORT])
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-mindmap-todos-'))
const python = path.resolve(fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3')
const env = { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db'), PERSONAL_NOTE_PLUGINS_DIR: path.join(scratch, 'plugins') }
const API = `http://127.0.0.1:${API_PORT}`
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], { env, stdio: process.env.PN_DEBUG ? 'inherit' : 'ignore' })
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const call = async (method, url, body) => { const r = await fetch(`${API}/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })

const LONG = 'Renew the passport and then book the flights for the family trip'
const node = (id, parentId, text, x, y, extra = {}) => ({ id, parentId, text, x, y, color: '#3a7bd5', fontSize: 20, bold: false, font: 'hand', presentation: 'box', curve: 78, ...extra })
const MAP = { version: 1, title: 'Week plan', rootId: 'r', defaultPresentation: 'box', nodes: [
  { ...node('r', null, 'Week plan', 0, 0, { color: '#ef684b', fontSize: 28, bold: true }) },
  node('long', 'r', LONG, 330, -120),
  node('short', 'r', 'Call the bank', 330, 40),
  node('big', 'r', 'Call the bank', 330, 140, { fontSize: 34 }),
  node('clean', 'r', LONG, -330, -60, { font: 'clean' }),
  node('branch', 'r', LONG, -330, 90, { presentation: 'branch' }),
] }

let browser
try {
  await apiUp()
  await server.listen()
  const made = await call('POST', '/notes', { title: 'Week plan', noteType: 'mindmap' })
  const put = await call('PUT', `/notes/${made.body.id}`, { title: 'Week plan', content: MAP, revision: made.body.revision })
  if (put.status !== 200) throw new Error('could not seed the map: ' + JSON.stringify(put))
  const mapId = made.body.id
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const errors = []
  for (const [label, viewport] of [['phone', { width: 390, height: 780 }], ['desktop', { width: 1360, height: 900 }]]) {
    const page = await (await browser.newContext({ viewport, hasTouch: label === 'phone' })).newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    const shot = async (name) => { if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${label}-${name}.png`) }) }
    await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
    await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
    await page.evaluate((n) => window.__personalNote.selectNote(n), mapId)
    await page.waitForSelector('g.map-node[data-node-id="long"]', { timeout: 15000 })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(400)

    // The drawn box (in the map's own units) and the drawn text, for one node.
    const measure = (id) => page.evaluate((nodeId) => {
      const group = document.querySelector(`g.map-node[data-node-id="${nodeId}"]`)
      const card = group.querySelector('.map-idea-card, .map-root-card')
      const label = group.querySelector('.map-node-label, .map-root-label')
      const box = label.getBBox()
      return { lines: [...label.querySelectorAll('tspan')].map((row) => row.textContent), text: { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height }, card: card ? { left: +card.getAttribute('x'), right: +card.getAttribute('x') + +card.getAttribute('width'), top: +card.getAttribute('y'), bottom: +card.getAttribute('y') + +card.getAttribute('height'), width: +card.getAttribute('width'), height: +card.getAttribute('height') } : null }
    }, id)
    const long = await measure('long')
    const short = await measure('short')
    const big = await measure('big')
    const clean = await measure('clean')
    const branch = await measure('branch')
    check(`[${label}] a long label wraps at word breaks onto 3 lines`, long.lines.join('|') === 'Renew the passport and then|book the flights for the|family trip', long.lines.join('|'))
    check(`[${label}] the box grows taller with the lines`, long.card.height === short.card.height + 48 && short.card.height === 40, `${long.card.height} vs ${short.card.height}`)
    const fits = (m) => m.text.left >= m.card.left && m.text.right <= m.card.right && m.text.top >= m.card.top && m.text.bottom <= m.card.bottom
    check(`[${label}] the drawn words sit inside their box, handwritten and clean`, fits(long) && fits(clean) && fits(short) && fits(big), JSON.stringify({ long, clean, big }))
    check(`[${label}] the box is the measured width: no more than 40px of slack around the widest line`, long.card.right - long.card.left - (long.text.right - long.text.left) < 40 && big.card.width - (big.text.right - big.text.left) < 40, JSON.stringify({ long, big }))
    check(`[${label}] a bigger font makes a wider box`, big.card.width > short.card.width + 30, `${big.card.width} vs ${short.card.width}`)
    check(`[${label}] a branch label wraps too, in capitals`, branch.lines.length === 3 && branch.lines[0] === 'RENEW THE PASSPORT AND THEN', branch.lines.join('|'))
    await shot('wrapped')

    // ---- F-106 icons
    const nodeCentre = async (id) => { const r = await page.locator(`g.map-node[data-node-id="${id}"] .map-idea-card, g.map-node[data-node-id="${id}"] .map-root-card`).boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }
    const closeProps = async () => { if (await page.locator('#note-popover').evaluate((e) => !e.hidden)) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); if (await page.locator('#note-popover').evaluate((e) => !e.hidden)) { await page.mouse.click(viewport.width / 2, viewport.height - 20); await page.waitForTimeout(300) } } }
    const select = async (id) => { await closeProps(); await page.waitForTimeout(600); const c = await nodeCentre(id); await page.mouse.click(c.x, c.y); await page.waitForTimeout(120) }
    const openProps = async () => {
      if (!(await page.locator('#note-popover').evaluate((e) => !e.hidden))) { if (!(await page.locator('#share-props').isVisible())) await page.click('#share-button').catch(() => {}); await page.click('#share-props'); await page.waitForTimeout(300) }
    }
    const savedNode = async (id) => (await call('GET', `/notes/${mapId}`)).body.content.nodes.find((n) => n.id === id)
    const waitSaved = async (test, id = 'short', alt) => { for (let i = 0; i < 60; i++) { if ((alt || test)(await savedNode(id))) return true; await page.waitForTimeout(100) } return false }
    await select('short')
    await openProps()
    const widthBefore = (await measure('short')).card.width
    for (const name of ['flag', 'todo', 'fire']) await page.click(`[data-map-icon="${name}"]`)
    await page.waitForTimeout(100)
    await page.click('[data-map-icon="star"]')
    const shown = await page.locator('g.map-node[data-node-id="short"] .map-node-icon').evaluateAll((els) => els.map((e) => e.dataset.icon))
    check(`[${label}] tapping icons toggles them on the selected node, three at most`, shown.join() === 'flag,todo,fire' && (await page.locator('[data-map-icon-count]').textContent()) === '3/3', shown.join())
    const withIcons = await measure('short')
    check(`[${label}] icons draw before the words and the box grew to fit`, withIcons.card.width > widthBefore + 60 && fits(withIcons) && withIcons.card.left < withIcons.text.left - 60, JSON.stringify({ widthBefore, withIcons }))
    await page.click('[data-map-icon="todo"]')
    check(`[${label}] tapping a lit icon turns it off`, (await page.locator('g.map-node[data-node-id="short"] .map-node-icon').count()) === 2)
    await page.click('[data-map-icon="todo"]')
    await waitSaved((n) => n.icons?.join() === 'flag,fire,todo')
    check(`[${label}] icons are saved with the map`, (await savedNode('short')).icons?.join() === 'flag,fire,todo', JSON.stringify((await savedNode('short')).icons))
    await select('r')
    await openProps()
    await page.click('[data-map-icon="idea"]')
    await waitSaved(null, 'r', (n) => n.icons?.join() === 'idea')
    await shot('icons')
    await page.reload()
    await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
    await page.evaluate((n) => window.__personalNote.selectNote(n), mapId)
    await page.waitForSelector('g.map-node[data-node-id="short"]', { timeout: 15000 })
    check(`[${label}] after a reload the icons are back`, (await page.locator('g.map-node[data-node-id="short"] .map-node-icon').count()) === 3 && (await page.locator('g.map-node[data-node-id="r"] .map-node-icon').count()) === 1, JSON.stringify([await page.locator('.map-node-icon').evaluateAll((els) => els.map((e) => e.closest('[data-node-id]').dataset.nodeId + ':' + e.dataset.icon)), (await savedNode('r')).icons]))
    // ---- editing the wrapped label (F-105 fix)
    await select('long')
    const drawn = (await measure('long')).lines
    await page.keyboard.press('F2')
    await page.locator('.mindmap-node-editor').waitFor()
    const editing = await page.locator('.mindmap-node-editor').inputValue()
    check(`[${label}] the editor shows the same lines as the drawn box`, editing.split('\n').join('|') === drawn.join('|'), editing)
    await page.locator('.mindmap-node-editor').fill('Pay rent\nand the bills')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    check(`[${label}] Enter commits and a line break in the text is a space`, (await waitSaved((n) => n.text === 'Pay rent and the bills', 'long')) && (await page.locator('.mindmap-node-editor').count()) === 0, JSON.stringify((await savedNode('long')).text))

    // ---- a reminder jump lands on its node (F-110)
    const other = (await call('POST', '/notes', { title: 'Elsewhere' })).body
    await page.evaluate((n) => window.__personalNote.selectNote(n), other.id)
    await page.waitForFunction((n) => window.__personalNote.state.activeNoteId === n, other.id)
    await page.evaluate((target) => window.__personalNote.jumpToReminder(target), { noteId: mapId, nodeId: 'big' })
    await page.waitForSelector('g.map-node[data-node-id="big"].selected', { timeout: 10000 })
    await page.waitForTimeout(400)
    const where = await nodeCentre('big')
    const stage = await page.locator('[data-map-stage]').boundingBox()
    check(`[${label}] a reminder jump opens the map, selects the node and centres it`, Math.abs(where.x - (stage.x + stage.width / 2)) < 20 && Math.abs(where.y - (stage.y + stage.height / 2)) < 20, JSON.stringify({ where, stage }))
    await call('PUT', `/notes/${mapId}`, { title: 'Week plan', content: MAP, revision: (await call('GET', `/notes/${mapId}`)).body.revision })
    await page.context().close()
  }
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  fs.rmSync(scratch, { recursive: true, force: true }) // the exact folder this run made
}
console.log(results.every(Boolean) ? `\nALL ${results.length} CHECKS PASSED` : `\n${results.filter((r) => !r).length} OF ${results.length} CHECKS FAILED`)
process.exit(results.every(Boolean) ? 0 : 1)
