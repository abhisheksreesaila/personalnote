// F-105..F-109 checks: mind-map boxes that fit their text, icons, the pencil strike, x of y done and due dates, in the real app.
// The Vite dev server on PN_VERIFY_PORT (never 3137) in front of the real API on the next port, a scratch database (PERSONAL_NOTE_DB),
// headless Chromium. Phone width first, then desktop.
//   F-105  a long label wraps onto lines and the box grows; the drawn text fits inside its box; a bigger font makes a wider box
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
