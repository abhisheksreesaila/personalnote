// F-105..F-109 checks: mind-map boxes that fit their text, icons, the pencil strike, x of y done and due dates, in the real app.
// The Vite dev server on PN_VERIFY_PORT (never 3137) in front of the real API on the next port, a scratch database (PERSONAL_NOTE_DB),
// headless Chromium. Phone width first, then desktop.
//   F-105  a long label wraps onto lines and the box grows; the drawn text fits inside its box; a bigger font makes a wider box
//   F-106  the Properties panel has 12 icons; tapping toggles them on the selected node (3 at most); they draw before the words and the box grows; saved and back after a reload
//   F-105 fix  editing the long label shows the same lines as the drawn box; Enter commits (no newline in the text); a pasted line break becomes a space
//   F-107  a sideways swipe on a SELECTED node's label (real mouse on desktop, real touch on the phone) draws a pencil line; past 60% it finishes and the node is done
//          (check instead of the to-do box, dimmed, struck, saved); short of it the line fades; a vertical drag or an unselected node still drags; swipe again or tap the check clears
//   F-108  a parent shows 1/4 for the tasks under it, counting up as they are struck (a check when all are done), down when one is unstruck or deleted
//   F-109  the Properties panel sets a due date and optional time; a chip by the label says Today / 11:59 PM / a weekday / Nov 3, amber on the day, red when overdue,
//          gone once the node is done; saved, back after a reload; an invalid saved value is dropped; Clear removes it
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
    await call('PUT', `/notes/${mapId}`, { title: 'Week plan', content: MAP, revision: (await call('GET', `/notes/${mapId}`)).body.revision })
    const context = await browser.newContext({ viewport, hasTouch: label === 'phone' })
    const page = await context.newPage()
    await page.addInitScript(() => { window.__vib = []; navigator.vibrate = (pattern) => { window.__vib.push(pattern); return true }; window.__audio = 0; const Audio = window.AudioContext; if (Audio) window.AudioContext = class extends Audio { constructor(...args) { super(...args); window.__audio += 1 } } })
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
    const unfocus = async () => { if (label === 'phone') { await page.click('[data-map-action="zoom-reset"]'); await page.waitForTimeout(500) } } // (on the phone a tapped node zooms into its branch)
    const select = async (id) => { await closeProps(); await unfocus(); await page.waitForTimeout(600); const c = await nodeCentre(id); await page.mouse.click(c.x, c.y); await page.waitForTimeout(600) }
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

    // ---- F-107 the pencil strike
    const cdp = await context.newCDPSession(page)
    if (process.env.PN_DEBUG_TOUCH) { page.on('console', (m) => console.log('page:', m.text())); await page.evaluate(() => { for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) document.addEventListener(t, (e) => console.log(t, e.pointerType, e.target.tagName, e.target.getAttribute?.('class'), Math.round(e.clientX), Math.round(e.clientY)), true) }) }
    const labelBox = (id) => page.locator(`g.map-node[data-node-id="${id}"] .map-node-label`).evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2, width: r.width } })
    const swipe = async (from, to, kind) => {
      const steps = 14
      const at = (i) => ({ id: 1, radiusX: 4, radiusY: 4, force: 1, x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps + (kind === 'touch' ? 0 : Math.sin(i) * 1.2) })
      if (kind === 'touch') {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(0)] })
        for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(i)] }); await page.waitForTimeout(16) }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } else {
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        for (let i = 1; i <= steps; i++) { await page.mouse.move(at(i).x, at(i).y); await page.waitForTimeout(16) }
        await page.mouse.up()
      }
      await page.waitForTimeout(700) // (the line finishes itself with a spring, then fades)
    }
    const kind = label === 'phone' ? 'touch' : 'mouse'
    const sideways = async (id, from = 0.08, to = 1.02) => { const b = await labelBox(id); await swipe({ x: b.left + b.width * from, y: b.mid }, { x: b.left + b.width * to, y: b.mid }, kind) }
    const isDone = async (id) => (await savedNode(id)).done === true
    const domDone = (id) => page.locator(`g.map-node[data-node-id="${id}"] .map-node-label.done`).count()
    // an unselected node: the same swipe drags it, it does not strike
    await closeProps()
    await unfocus()
    const empty = await page.evaluate(() => { const stage = document.querySelector('[data-map-stage]').getBoundingClientRect(); for (let y = stage.top + 20; y < stage.bottom - 20; y += 20) for (let x = stage.left + 20; x < stage.right - 20; x += 20) { const hit = document.elementFromPoint(x, y); if (hit?.closest('.mindmap-canvas') && !hit.closest('[data-node-id], .map-branch-hit, .mindmap-hint')) return { x, y } } })
    await page.mouse.click(empty.x, empty.y) // (nothing selected)
    await page.waitForTimeout(400)
    await sideways('big', 0.3, 0.9)
    await waitSaved((n) => n.x !== 330, 'big')
    check(`[${label}] a swipe on a node that is not selected drags it and strikes nothing`, (await savedNode('big')).x > 330 + 10 && !(await isDone('big')) && (await domDone('big')) === 0, JSON.stringify(await savedNode('big')))
    await page.waitForTimeout(400)
    // selected, vertical: still a drag
    await select('big')
    const bigBefore = (await savedNode('big')).y
    const bigBox = await labelBox('big')
    await swipe({ x: bigBox.left + bigBox.width / 2, y: bigBox.mid }, { x: bigBox.left + bigBox.width / 2, y: bigBox.mid + 60 }, kind)
    await waitSaved((n) => n.y !== bigBefore, 'big')
    check(`[${label}] a vertical drag on a selected label still moves the node`, (await savedNode('big')).y > bigBefore + 20 && (await domDone('big')) === 0, String(bigBefore))
    await page.waitForTimeout(400)
    // selected, sideways but short: the line fades and nothing changes
    await select('short')
    await sideways('short', 0.1, 0.4)
    check(`[${label}] a short swipe fades and changes nothing`, (await domDone('short')) === 0 && !(await isDone('short')) && (await page.locator('.map-strike-live').count()) === 0)
    // selected, sideways, past 60%: done
    await sideways('short')
    await shot('struck')
    await waitSaved((n) => n.done === true)
    check(`[${label}] a full swipe strikes the label and marks the node done`, (await isDone('short')) && (await domDone('short')) === 1 && (await page.locator('g.map-node[data-node-id="short"] .map-strike').count()) === 1, JSON.stringify(await savedNode('short')))
    const iconsNow = await page.locator('g.map-node[data-node-id="short"] .map-node-icon').evaluateAll((els) => els.map((e) => e.dataset.icon))
    check(`[${label}] the to-do box became the done check, the other icons stayed`, iconsNow.join() === 'flag,fire,done', iconsNow.join())
    check(`[${label}] the label is dimmed`, Number(await page.locator('g.map-node[data-node-id="short"] .map-node-label').evaluate((e) => getComputedStyle(e).opacity)) < 0.8)
    check(`[${label}] the scratch sound played${label === 'phone' ? ' and the phone buzzed' : ''}`, (await page.evaluate(() => window.__audio)) >= 1 && (label !== 'phone' || (await page.evaluate(() => window.__vib.length)) >= 1), JSON.stringify(await page.evaluate(() => [window.__audio, window.__vib])))
    // swipe again: cleared
    await sideways('short')
    await waitSaved((n) => n.done !== true)
    check(`[${label}] swiping across a struck label again clears it`, !(await isDone('short')) && (await domDone('short')) === 0 && (await page.locator('g.map-node[data-node-id="short"] .map-strike').count()) === 0)
    // strike again, then tap the check
    await sideways('short')
    await waitSaved((n) => n.done === true)
    const check1 = await page.locator('g.map-node[data-node-id="short"] [data-done-toggle]').boundingBox()
    if (kind === 'touch') { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: check1.x + check1.width / 2, y: check1.y + check1.height / 2 }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) } else await page.mouse.click(check1.x + check1.width / 2, check1.y + check1.height / 2)
    await waitSaved((n) => n.done !== true)
    check(`[${label}] tapping the done check clears it`, !(await isDone('short')) && (await domDone('short')) === 0)
    // undo brings the strike back
    await sideways('short')
    await waitSaved((n) => n.done === true)
    await page.keyboard.press('Control+z')
    await waitSaved((n) => n.done !== true)
    check(`[${label}] undo takes the strike back`, !(await isDone('short')))
    await page.keyboard.press('Control+Shift+z')
    await waitSaved((n) => n.done === true)
    // reload
    await page.reload()
    await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
    await page.evaluate((n) => window.__personalNote.selectNote(n), mapId)
    await page.waitForSelector('g.map-node[data-node-id="short"]', { timeout: 15000 })
    check(`[${label}] after a reload the node is still done and struck`, (await domDone('short')) === 1 && (await page.locator('g.map-node[data-node-id="short"] .map-strike').count()) === 1)
    // a node without the to-do box shows the check when struck
    await select('big')
    await sideways('big')
    await waitSaved((n) => n.done === true, 'big')
    check(`[${label}] striking a node with no to-do box shows the done check in front`, (await page.locator('g.map-node[data-node-id="big"] .map-node-icon').evaluateAll((els) => els.map((e) => e.dataset.icon))).join() === 'done')

    // ---- F-108 x of y done
    const TASKS = { version: 1, title: 'Errands', rootId: 'r', defaultPresentation: 'box', nodes: [
      node('r', null, 'Errands', 0, 0, { color: '#ef684b', fontSize: 28 }),
      node('e', 'r', 'This week', 300, 0),
      node('c1', 'e', 'Post office', 600, -150, { icons: ['todo'], done: true }),
      node('c2', 'e', 'Pharmacy', 600, -50, { icons: ['todo'] }),
      node('c3', 'e', 'Bank', 600, 50, { icons: ['todo'] }),
      node('c4', 'e', 'Library', 600, 150, { icons: ['todo'] }),
    ] }
    const tasksNote = (await call('POST', '/notes', { title: 'Errands', noteType: 'mindmap' })).body
    await call('PUT', `/notes/${tasksNote.id}`, { title: 'Errands', content: TASKS, revision: tasksNote.revision })
    await page.evaluate((n) => window.__personalNote.selectNote(n), tasksNote.id)
    await page.waitForSelector('g.map-node[data-node-id="c4"]', { timeout: 15000 })
    await page.waitForTimeout(600)
    const badgeOf = async (id) => { const b = page.locator(`[data-task-badge="${id}"]`); return (await b.count()) ? (await b.getAttribute('data-all-done')) === 'true' ? 'check' : (await b.textContent()).trim() : null }
    const badgeIs = async (id, want) => { for (let i = 0; i < 30; i++) { if ((await badgeOf(id)) === want) return true; await page.waitForTimeout(100) } return false }
    check(`[${label}] a parent with tasks under it shows 1/4, on the branch and on the centre idea`, (await badgeIs('e', '1/4')) && (await badgeIs('r', '1/4')) && (await badgeOf('c1')) === null, `${await badgeOf('e')} ${await badgeOf('r')}`)
    await shot('badge')

    await select('c2'); await sideways('c2')
    check(`[${label}] striking a task counts it: 2/4`, await badgeIs('e', '2/4'), await badgeOf('e'))
    await select('c3'); await sideways('c3')
    await shot('before-c4'); await select('c4'); await sideways('c4')
    check(`[${label}] when every task is done the badge turns into a check`, await badgeIs('e', 'check') && await badgeIs('r', 'check'), await badgeOf('e'))
    await shot('badge-done')
    await sideways('c4')
    check(`[${label}] clearing a strike counts it back: 3/4`, await badgeIs('e', '3/4'), await badgeOf('e'))
    await select('c1'); await page.keyboard.press('Delete')
    check(`[${label}] deleting a done task takes it out of the count: 2/3`, await badgeIs('e', '2/3'), await badgeOf('e'))
    // ---- F-109 due dates
    const ymd = (offset) => page.evaluate((days) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }, offset)
    const chipOf = async (id) => { const c = page.locator(`g.map-node[data-node-id="${id}"] .map-due-chip`); return (await c.count()) ? { text: (await c.locator('text').textContent()).trim(), state: await c.getAttribute('data-due-state'), fill: await c.locator('rect').getAttribute('fill') } : null }
    const chipIs = async (id, want) => { for (let i = 0; i < 30; i++) { const got = await chipOf(id); if (want === null ? got === null : got && got.text === want) return want === null ? true : got; await page.waitForTimeout(100) } return false }
    const savedTask = async (id) => (await call('GET', `/notes/${tasksNote.id}`)).body.content.nodes.find((n) => n.id === id)
    const waitTask = async (id, test) => { for (let i = 0; i < 60; i++) { if (test(await savedTask(id))) return true; await page.waitForTimeout(100) } return false }
    const today = await ymd(0)
    await select('c4')
    await openProps()
    await page.fill('[data-map-due-date]', today)
    check(`[${label}] a due date today shows Today in amber`, (await chipIs('c4', 'Today')) && (await chipOf('c4')).state === 'today' && (await chipOf('c4')).fill === '#fde7b0' && await waitTask('c4', (n) => n.due === today), JSON.stringify(await chipOf('c4')))
    await closeProps(); await page.waitForTimeout(600); await shot('due-chip-today'); await openProps()
    await page.fill('[data-map-due-time]', '23:59')
    check(`[${label}] adding a time shows it and saves date and time`, (await chipIs('c4', '11:59 PM')) && await waitTask('c4', (n) => n.due === `${today}T23:59`), JSON.stringify(await chipOf('c4')))
    await page.fill('[data-map-due-time]', '')
    await page.fill('[data-map-due-date]', await ymd(-2))
    const lateChip = await chipOf('c4')
    check(`[${label}] a date in the past is red`, lateChip?.state === 'overdue' && lateChip.fill === '#fbd3cd' && /^[A-Z][a-z]{2} \d{1,2}$/.test(lateChip.text), JSON.stringify(lateChip))
    await closeProps(); await page.waitForTimeout(600); await shot('due-chip-overdue'); await openProps()
    const soon = await ymd(3)
    await page.fill('[data-map-due-date]', soon)
    const weekday = await page.evaluate((d) => new Date(`${d}T12:00`).toLocaleDateString('en-US', { weekday: 'short' }), soon)
    check(`[${label}] a date this week shows the weekday`, !!(await chipIs('c4', weekday)) && (await chipOf('c4')).state === 'later', weekday)
    await page.click('[data-map-due-clear]')
    check(`[${label}] Clear removes the chip and the saved date`, (await chipIs('c4', null)) === true && await waitTask('c4', (n) => n.due === undefined))
    await page.fill('[data-map-due-date]', today)
    await waitTask('c4', (n) => n.due === today)
    await select('c4'); await sideways('c4')
    check(`[${label}] striking the node takes the chip away (the date is kept)`, (await chipIs('c4', null)) === true && await waitTask('c4', (n) => n.done === true && n.due === today))
    await select('e')
    await openProps()
    const later = await ymd(20)
    await page.fill('[data-map-due-date]', later)
    await waitTask('e', (n) => n.due === later)
    const laterText = await page.evaluate((d) => { const at = new Date(`${d}T12:00`); return `${at.toLocaleDateString('en-US', { month: 'short' })} ${at.getDate()}` }, later)
    await shot('due-later')
    await page.reload()
    await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
    await page.evaluate((n) => window.__personalNote.selectNote(n), tasksNote.id)
    await page.waitForSelector('g.map-node[data-node-id="e"]', { timeout: 15000 })
    check(`[${label}] after a reload the date is still there`, !!(await chipIs('e', laterText)))
    const stored = (await call('GET', `/notes/${tasksNote.id}`)).body
    await call('PUT', `/notes/${tasksNote.id}`, { title: 'Errands', content: { ...stored.content, nodes: stored.content.nodes.map((n) => (n.id === 'e' ? { ...n, due: '2026-02-30' } : n)) }, revision: stored.revision })
    await page.reload()
    await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
    await page.evaluate((n) => window.__personalNote.selectNote(n), tasksNote.id)
    await page.waitForSelector('g.map-node[data-node-id="e"]', { timeout: 15000 })
    check(`[${label}] a saved value that is not a real date is dropped`, (await chipIs('e', null)) === true)
    await page.evaluate((n) => window.__personalNote.selectNote(n), mapId)
    await page.waitForSelector('g.map-node[data-node-id="short"]', { timeout: 15000 })

    // ---- a reminder jump lands on its node (F-110)
    const other = (await call('POST', '/notes', { title: 'Elsewhere' })).body
    await page.evaluate((n) => window.__personalNote.selectNote(n), other.id)
    await page.waitForFunction((n) => window.__personalNote.state.activeNoteId === n, other.id)
    await page.evaluate((target) => window.__personalNote.jumpToReminder(target), { noteId: mapId, nodeId: 'big' })
    await page.waitForSelector('g.map-node[data-node-id="big"].selected', { timeout: 10000 })
    await page.waitForTimeout(400)
    await shot('jump')
    const where = await nodeCentre('big')
    const stage = await page.locator('[data-map-stage]').boundingBox()
    check(`[${label}] a reminder jump opens the map, selects the node and centres it`, Math.abs(where.x - (stage.x + stage.width / 2)) < 20 && Math.abs(where.y - (stage.y + stage.height / 2)) < 20, JSON.stringify({ where, stage }))
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
