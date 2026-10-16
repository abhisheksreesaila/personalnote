// F-076 checks, in the real app (Vite dev server on PN_VERIFY_PORT, mocked in-memory /api, headless Chromium, real mouse and keyboard):
// the bottom dock is a slim vertical tool island on the right edge, undo/redo is a small island bottom left and zoom one bottom right.
//   - the shape of the islands: select, text, pen, shape, sticky | colour dot | + | mic; no quick swatches, no page minimap; the page
//     count is the fit button's tooltip; at 1280x800 and 1440x900 (also with ?host=desktop&chrome=mac) nothing overlaps and the paper
//     at its default view is clear of the island
//   - each of the five tools: click it, then draw or place with it (a pen stroke, a shape, a sticky, typed text, a selection)
//   - the colour dot: opens beside the island, recolours the pen, the sticky and the shape, sets the pen width
//   - the +: hand, highlighter, connect, image (file input), eraser (erases a stroke) and prettify, each from the flyout; the + wears the
//     tool picked from it; hold-for-options on a tool and on the highlighter in the flyout
//   - every keyboard shortcut, Space-to-pan, double-tap Control and the middle click, each shown on the island
//   - undo and redo from the corner island, zoom out/in/reset/fit from the other
//   - a mind-map note shows its actions in the same right island, a page note shows no tools (as before)
//   - focus mode hides every island and brings them back; narrow windows keep the mobile controls and no island
//   - the selection bar, the voice caption and the eraser cursor are not covered by the island
//
//   PN_VERIFY_PORT=4905 node scripts/verify-tool-island.mjs      (PN_SHOT=/var/tmp/f076 also saves screenshots)
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const PORT = Number(process.env.PN_VERIFY_PORT || 4905)
if (PORT === 3137) throw new Error('never the real app port')
const now = new Date().toISOString()
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

// A 64 x 48 PNG made here (no fixture file): the picture the image button places.
function png(width, height) {
  const crcTable = (n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable((c ^ b) & 0xff) ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(8 + data.length + 4); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length); return out }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const o = y * (width * 3 + 1) + 1 + x * 3; rows[o] = 40 + x * 3; rows[o + 1] = 120; rows[o + 2] = 200 - y * 3 }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

const stored = {
  1: { noteType: 'canvas', title: 'Garden plan', content: { objects: [] }, pageState: { columns: 1, rows: 1 } },
  2: { noteType: 'mindmap', title: 'Ideas map', content: null, pageState: {} },
  3: { noteType: 'page', title: 'Page note', content: { version: 1, markdown: '# A page\n\nSome words.', ink: [] }, pageState: {} },
}
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
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const summary = (id) => ({ id, resourceId: `r${id}`, revision: 1, noteType: stored[id].noteType, title: stored[id].title, notebookId: 1, createdAt: now, updatedAt: now })
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'Garden', category: 'projects', color: '#76669a', noteCount: 3 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary(1), summary(2), summary(3)])
    if (p === '/media' && req.method() === 'POST') return json({ id: `${createHash('sha256').update(req.postDataBuffer() ?? '').digest('hex')}.png` })
    const m = p.match(/^\/notes\/(\d+)$/)
    if (m && req.method() === 'GET') return json({ ...summary(Number(m[1])), content: stored[m[1]].content, pageState: stored[m[1]].pageState })
    if (m && req.method() === 'PUT') {
      const body = JSON.parse(req.postData() || '{}')
      if (body.content) stored[m[1]].content = body.content
      return json({ revision: 2, resourceId: `r${m[1]}` })
    }
    if (p.startsWith('/changes')) return json({ sequence: 1, changes: [], agents: [] })
    return json({})
  })
  const url = `http://127.0.0.1:${PORT}/notes`
  const load = async (query = '') => {
    await page.goto(url + query)
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
    await page.waitForTimeout(500)
  }
  const shot = async (name) => { if (process.env.PN_SHOT) await page.screenshot({ path: `${process.env.PN_SHOT}-${name}.png` }) }
  const rect = (selector) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && { x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height } }, selector)
  const center = async (selector) => { const r = await rect(selector); return { x: r.x + r.w / 2, y: r.y + r.h / 2 } }
  const click = async (selector) => { const c = await center(selector); await page.mouse.click(c.x, c.y) }
  const overlap = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b
  const tool = () => page.evaluate(() => window.__personalNote.state.tool)
  const objects = (type) => page.evaluate((t) => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc.objects.filter((o) => !t || o.type === t))), type)
  const toClient = (point) => page.evaluate(([px, py]) => { const v = window.__personalNote.leaferCanvas().view(); const r = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: r.left + v.x + px * v.scale, y: r.top + v.y + py * v.scale } }, [point.x, point.y])
  const buttonOn = (selector) => page.evaluate((s) => document.querySelector(s).classList.contains('active'), selector)
  const moreShows = () => page.evaluate(() => ({ active: document.querySelector('#dock-more').classList.contains('active'), tool: document.querySelector('#dock-more-tool').innerHTML.includes('<svg'), plusHidden: getComputedStyle(document.querySelector('#dock-more .more-plus')).display === 'none' }))
  const popoverOpen = () => page.evaluate(() => !document.querySelector('#ink-options-popover').hidden)
  const flyoutOpen = () => page.evaluate(() => !document.querySelector('#dock-flyout').hidden)
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  // One move per frame, like a hand does; the view is let to settle first (a drawing tool opens the page up).
  const dragOnPage = async (points) => {
    await page.waitForTimeout(600)
    const screen = []
    for (const p of points) screen.push(await toClient(p))
    await page.mouse.move(screen[0].x, screen[0].y)
    await page.mouse.down()
    for (let i = 1; i < screen.length; i += 1) {
      const q = screen[i - 1]; const p = screen[i]
      for (let k = 1; k <= 5; k += 1) { await page.mouse.move(q.x + ((p.x - q.x) * k) / 5, q.y + ((p.y - q.y) * k) / 5); await frame() }
    }
    await page.mouse.up()
    await page.waitForTimeout(300)
  }
  const away = async () => { await click('#save-state'); await page.waitForTimeout(200) } // a harmless place that is not the canvas
  const clickPage = async (point) => { await page.waitForTimeout(500); const c = await toClient(point); await page.mouse.click(c.x, c.y); await page.waitForTimeout(250) }
  const openFlyout = async () => { if (!(await flyoutOpen())) await click('#dock-more'); await page.waitForTimeout(200) }
  const fromFlyout = async (selector) => { await openFlyout(); await click(selector); await page.waitForTimeout(200) }
  const openPanel = async () => { if (!(await page.evaluate(() => document.querySelector('#sidebar').classList.contains('open')))) await click('#toggle-sidebar'); await page.waitForTimeout(400) }
  const tools = ['select', 'text', 'pen', 'shape', 'sticky']

  await load()

  // ================= the shape of the islands
  check('opening a note selects the Text tool and the island shows it', (await tool()) === 'text' && await buttonOn('[data-tool="text"]'))
  const dock = await rect('.tool-dock')
  const layout = async (label, width, height) => {
    const d = await rect('.tool-dock')
    check(`${label}: the tool island is on the right edge, inset 16px, 56px wide, vertically centred`, Math.abs(d.r - (width - 16)) <= 1 && Math.abs(d.w - 56) <= 1 && Math.abs((d.y + d.b) / 2 - height / 2) <= 2, JSON.stringify(d))
    const i = { notes: await rect('#toggle-sidebar'), title: await rect('.topbar-title'), focus: await rect('#focus-button'), search: await rect('#search-button'), dock: d, history: await rect('#history-island'), zoom: await rect('#zoom-control') }
    const names = Object.keys(i)
    let clash = null
    for (const a of names) for (const b of names) if (a < b && overlap(i[a], i[b])) clash = `${a}/${b}`
    check(`${label}: no two islands overlap`, !clash, `${clash} ${JSON.stringify(i)}`)
    check(`${label}: the corner islands sit inside the 16px inset, undo/redo left and zoom right`, i.history.x >= 16 - 1 && i.history.b <= height - 16 + 1 && i.zoom.r <= width - 16 + 1 && i.zoom.b <= height - 16 + 1 && i.history.r < width / 2 && i.zoom.x > width / 2, JSON.stringify({ h: i.history, z: i.zoom }))
    check(`${label}: undo/redo are clear of the notes button and the notes panel's own button`, !overlap(i.history, i.notes))
    const paper = await page.evaluate(() => { const n = window.__personalNote; const v = n.leaferCanvas().view(); const r = document.querySelector('#leafer-host').getBoundingClientRect(); return { right: r.left + v.x + 860 * v.scale, left: r.left + v.x } })
    check(`${label}: the paper at the default view is clear of the island (right edge ${Math.round(paper.right)} vs island ${Math.round(d.x)})`, paper.right <= d.x - 8, JSON.stringify(paper))
    return i
  }
  await layout('1280x800', 1280, 800)
  const labels = await page.evaluate(() => [...document.querySelectorAll('.tool-dock #dock-canvas > .tool-group > button, .tool-dock #dock-canvas > button, .tool-dock #dock-canvas .dock-more-wrap > button')].map((b) => b.dataset.tool || b.id))
  check('the island lists select, text, pen, shape, sticky, colour dot, +, mic in that order', JSON.stringify(labels) === JSON.stringify(['select', 'text', 'pen', 'shape', 'sticky', 'ink-options-trigger', 'dock-more', 'voice-button']), JSON.stringify(labels))
  const ys = await page.evaluate(() => ['select', 'text', 'pen', 'shape', 'sticky'].map((t) => document.querySelector(`[data-tool="${t}"]`).getBoundingClientRect().y).concat(['ink-options-trigger', 'dock-more', 'voice-button'].map((id) => document.getElementById(id).getBoundingClientRect().y)))
  check('they run top to bottom', ys.every((y, k) => k === 0 || y > ys[k - 1]), JSON.stringify(ys))
  const sizes = await page.evaluate(() => ({ buttons: [...document.querySelectorAll('.tool-dock #dock-canvas > .tool-group > button, #dock-more, #voice-button, #ink-options-trigger')].map((b) => [Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]), dot: document.querySelector('#ink-options-dot').getBoundingClientRect().width, round: getComputedStyle(document.querySelector('#voice-button')).borderRadius, dividers: document.querySelectorAll('.tool-dock #dock-canvas > .dock-divider').length }))
  check('44px buttons, a 28px colour dot, a round mic and two dividers', sizes.buttons.every(([w, h]) => w === 44 && h === 44) && sizes.dot === 28 && sizes.round === '50%' && sizes.dividers === 2, JSON.stringify(sizes))
  check('the five quick swatches and the page minimap are gone', await page.evaluate(() => !document.querySelector('.ink-swatch') && !document.querySelector('#page-minimap') && !document.querySelector('.mini-page')))
  check('the page count is the fit button\'s tooltip', await page.evaluate(() => document.querySelector('#zoom-fit').title === 'Zoom to fit all pages (1 page · 1 × 1)'), await page.evaluate(() => document.querySelector('#zoom-fit').title))
  const skin = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector('.tool-dock')); const root = getComputedStyle(document.documentElement); const probe = document.createElement('i'); probe.style.color = 'var(--sk-ink)'; document.body.append(probe); const ink = getComputedStyle(probe).color; probe.remove(); const active = getComputedStyle(document.querySelector('[data-tool="text"]')); return { bg: cs.backgroundColor, panel: root.getPropertyValue('--sk-panel').trim(), activeBg: active.backgroundColor, ink, radius: cs.borderRadius, token: root.getPropertyValue('--sk-radius').trim() } })
  check('the active tool is a solid ink circle', skin.activeBg === skin.ink && (await page.evaluate(() => getComputedStyle(document.querySelector('[data-tool="text"]')).borderRadius)) === '50%', JSON.stringify(skin))
  await shot('1280x800-rest')

  // ================= the five tools: click each, then draw or place with it
  const home = await page.evaluate(() => window.__personalNote.leaferCanvas().view())
  for (const t of tools) {
    await click(`[data-tool="${t}"]`)
    check(`clicking ${t} selects it and the island shows it`, (await tool()) === t && await buttonOn(`[data-tool="${t}"]`) && (await page.evaluate(() => document.querySelectorAll('.tool-dock .tool-button.active').length)) === 1)
  }
  await click('[data-tool="pen"]')
  await dragOnPage([{ x: 100, y: 700 }, { x: 200, y: 740 }, { x: 300, y: 700 }, { x: 400, y: 740 }])
  let ink = await objects('ink')
  check('the pen draws a stroke with the mouse', ink.length === 1 && ink[0].kind === 'stroke' && ink[0].tool === 'pen', JSON.stringify(ink).slice(0, 200))
  await click('[data-tool="shape"]')
  await clickPage({ x: 560, y: 420 })
  check('the shape tool places a rounded rectangle and goes back to select', (await objects('shape')).length === 1 && (await tool()) === 'select' && await buttonOn('[data-tool="select"]'))
  const selbar = await rect('#selection-bar')
  const dockNow = await rect('.tool-dock')
  check('the selection bar shows for the shape and is not covered by the island', await page.evaluate(() => !document.querySelector('#selection-bar').hidden) && !overlap(selbar, dockNow), JSON.stringify({ selbar, dockNow }))
  await click('[data-tool="sticky"]')
  await clickPage({ x: 180, y: 400 })
  await page.waitForTimeout(300)
  await page.keyboard.type('buy milk')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const stickies = await objects('sticky')
  check('the sticky tool places a note that takes typing', stickies.length === 1 && /buy milk/.test(stickies[0].content), JSON.stringify(stickies).slice(0, 200))
  await click('[data-tool="text"]')
  await clickPage({ x: 100, y: 300 })
  await page.waitForFunction(() => document.activeElement?.classList?.contains('leafer-text-editor') || document.querySelector('.md-editor'), null, { timeout: 5000 })
  await page.keyboard.type('island words')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  check('the text tool types a text', (await objects('text')).some((o) => /island words/.test(o.content)), JSON.stringify((await objects('text')).map((o) => o.content)))
  await click('[data-tool="select"]')
  const shapeObj = (await objects('shape'))[0]
  const shapeAt = await toClient({ x: shapeObj.geometry.x + shapeObj.geometry.width / 2, y: shapeObj.geometry.y + shapeObj.geometry.height / 2 })
  await page.mouse.click(shapeAt.x, shapeAt.y)
  await page.waitForTimeout(250)
  check('the select tool selects what is clicked', await page.evaluate((id) => window.__personalNote.leaferCanvas().selection().includes(id), shapeObj.id))

  // ================= the colour dot
  const bgOf = (selector) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, selector)
  await click('[data-tool="pen"]')
  check('with the pen the dot shows the ink colour', (await bgOf('#ink-options-dot')) === 'rgb(32, 32, 30)', await bgOf('#ink-options-dot'))
  await click('#ink-options-trigger')
  check('the dot opens the ink options', await popoverOpen() && await page.evaluate(() => document.querySelector('#ink-options-trigger').getAttribute('aria-expanded') === 'true'))
  const pop = await rect('#ink-options-popover')
  const dockR = await rect('.tool-dock')
  check('the options sit beside the island, inside the window, not under it', pop.r <= dockR.x && pop.x >= 0 && pop.y >= 0 && pop.b <= 800 && !overlap(pop, dockR), JSON.stringify({ pop, dockR }))
  check('the options hold the palette and the pen widths', await page.evaluate(() => document.querySelectorAll('#ink-palette .palette-swatch').length === 12 && document.querySelectorAll('#stroke-widths [data-stroke-width]').length === 4))
  await shot('1280x800-colour')
  const red = await center('#ink-palette [data-color="#d14b3f"]')
  await page.mouse.click(red.x, red.y)
  await page.waitForTimeout(200)
  check('choosing red recolours the pen and the dot', await page.evaluate(() => window.__personalNote.state.color) === '#d14b3f' && (await bgOf('#ink-options-dot')) === 'rgb(209, 75, 63)', await bgOf('#ink-options-dot'))
  if (!(await popoverOpen())) await click('#ink-options-trigger')
  const wide = await center('#stroke-widths [data-stroke-width="6"]')
  await page.mouse.click(wide.x, wide.y)
  await page.waitForTimeout(200)
  check('the width buttons set the pen width', await page.evaluate(() => window.__personalNote.state.penWidth) === 6)
  await away()
  await page.waitForTimeout(200)
  check('a click away closes the options', !(await popoverOpen()))
  await dragOnPage([{ x: 100, y: 800 }, { x: 250, y: 840 }, { x: 400, y: 800 }])
  ink = await objects('ink')
  check('the next stroke is red and 6 wide', ink.length === 2 && ink[1].color === '#d14b3f' && ink[1].width === 6, JSON.stringify(ink.map((o) => [o.color, o.width])))
  await click('[data-tool="sticky"]')
  check('with the sticky tool the dot shows the object colour and the options hold the object palette', await page.evaluate(() => { const dot = getComputedStyle(document.querySelector('#ink-options-dot')).backgroundColor; return dot !== 'rgb(209, 75, 63)' }))
  await click('#ink-options-trigger')
  check('the object palette replaces the ink palette', await page.evaluate(() => document.querySelector('#ink-palette').hidden && !document.querySelector('#object-palette').hidden && document.querySelectorAll('#object-palette [data-object-color]').length === 5))
  const third = await center('#object-palette [data-object-color="2"]')
  await page.mouse.click(third.x, third.y)
  await page.waitForTimeout(200)
  const objectFill = await page.evaluate(() => document.querySelector('#object-palette [data-object-color="2"]').style.getPropertyValue('--swatch'))
  const fillRgb = await page.evaluate((c) => { const probe = document.createElement('i'); probe.style.color = c; document.body.append(probe); const v = getComputedStyle(probe).color; probe.remove(); return v }, objectFill)
  check('picking an object colour shows it in the dot', (await bgOf('#ink-options-dot')) === fillRgb, `${await bgOf('#ink-options-dot')} vs ${fillRgb}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  check('Esc closes the options', !(await popoverOpen()))

  // ================= the +
  await click('#dock-more')
  check('the + opens a flyout', await flyoutOpen() && await page.evaluate(() => document.querySelector('#dock-more').getAttribute('aria-expanded') === 'true'))
  const fly = await rect('#dock-flyout')
  const more = await rect('#dock-more')
  const dockR2 = await rect('.tool-dock')
  check('the flyout is left of the island, level with the +, inside the window', fly.r <= dockR2.x && fly.x >= 0 && fly.y >= 0 && fly.b <= 800 && Math.abs((fly.y + fly.b) / 2 - (more.y + more.b) / 2) <= 8, JSON.stringify({ fly, more }))
  const flyLabels = await page.evaluate(() => [...document.querySelectorAll('#dock-flyout button')].map((b) => b.dataset.tool || b.id))
  check('it holds hand, highlighter, connect, image, eraser and prettify', JSON.stringify(flyLabels) === JSON.stringify(['hand', 'highlight', 'connect', 'add-image', 'eraser', 'prettify']), JSON.stringify(flyLabels))
  await shot('1280x800-plus')
  await page.keyboard.press('Escape')
  check('Esc closes the flyout', !(await flyoutOpen()))
  await click('#dock-more')
  await away()
  check('a click away closes the flyout', !(await flyoutOpen()))

  await fromFlyout('[data-tool="hand"]')
  let w = await moreShows()
  check('the hand from the flyout is the tool, the flyout closes and the + shows it active with the hand icon', (await tool()) === 'hand' && !(await flyoutOpen()) && w.active && w.tool && w.plusHidden, JSON.stringify(w))
  const before = await page.evaluate(() => window.__personalNote.leaferCanvas().view())
  const a = await toClient({ x: 300, y: 600 })
  await page.mouse.move(a.x, a.y); await page.mouse.down(); for (let k = 1; k <= 6; k += 1) { await page.mouse.move(a.x + k * 12, a.y + k * 6); await frame() } await page.mouse.up()
  const after = await page.evaluate(() => window.__personalNote.leaferCanvas().view())
  check('the hand drags the canvas', Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 5, JSON.stringify({ before, after }))
  await page.evaluate((v) => window.__personalNote.setViewTo(v), home)
  await click('[data-tool="pen"]')
  w = await moreShows()
  check('picking a main tool puts the + back to a plain +', !w.active && !w.tool && !w.plusHidden, JSON.stringify(w))

  await fromFlyout('[data-tool="highlight"]')
  w = await moreShows()
  check('the highlighter from the flyout is the tool and the + wears it', (await tool()) === 'highlight' && w.active && w.tool)
  await dragOnPage([{ x: 120, y: 600 }, { x: 300, y: 606 }])
  ink = await objects('ink')
  check('the highlighter draws a wide translucent stroke', ink.at(-1).tool === 'highlight' && ink.at(-1).alpha < 0.5, JSON.stringify({ all: ink.map((o) => [o.tool, o.kind, o.alpha, Math.round(o.geometry.x), Math.round(o.geometry.y)]), view: await page.evaluate(() => window.__personalNote.leaferCanvas().view()) }))

  await fromFlyout('[data-tool="connect"]')
  w = await moreShows()
  check('connect from the flyout is the tool and the + wears it', (await tool()) === 'connect' && w.active && w.tool)
  const sticky = (await objects('sticky'))[0]
  const aCenter = { x: sticky.geometry.x + sticky.geometry.width / 2, y: sticky.geometry.y + sticky.geometry.height / 2 }
  const bCenter = { x: shapeObj.geometry.x + shapeObj.geometry.width / 2, y: shapeObj.geometry.y + shapeObj.geometry.height / 2 }
  const connectors = (await objects('connector')).length
  await dragOnPage([aCenter, bCenter])
  check('connect draws an arrow from one object to another', (await objects('connector')).length === connectors + 1, `${connectors} -> ${(await objects('connector')).length}`)

  await fromFlyout('[data-tool="eraser"]')
  w = await moreShows()
  check('the eraser from the flyout is the tool and the + wears it', (await tool()) === 'eraser' && w.active && w.tool)
  const firstStroke = (await objects('ink')).find((o) => o.tool === 'pen' && Math.round(o.geometry.y) === 700)
  await dragOnPage([{ x: 90, y: 740 }, { x: 250, y: 700 }, { x: 420, y: 740 }])
  const afterErase = await objects('ink')
  check('the eraser cuts the stroke it crosses (the whole stroke is gone, its pieces left)', Boolean(firstStroke) && !afterErase.some((o) => o.id === firstStroke.id) && afterErase.some((o) => o.tool === 'pen' && o.geometry.y >= 690 && o.geometry.y <= 760 && o.geometry.width < firstStroke.geometry.width), JSON.stringify(afterErase.map((o) => [o.tool, Math.round(o.geometry.x), Math.round(o.geometry.y), Math.round(o.geometry.width)])))
  await page.mouse.move(400, 400)
  const cursor = await page.evaluate(() => { const c = document.querySelector('#eraser-cursor'); return { hidden: c.hidden, z: Number(getComputedStyle(c).zIndex), dockZ: Number(getComputedStyle(document.querySelector('.tool-dock')).zIndex) } })
  check('the eraser cursor shows and sits above the island', !cursor.hidden && cursor.z > cursor.dockZ, JSON.stringify(cursor))

  const images = (await objects('image')).length
  await openFlyout()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), click('#add-image')])
  await chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png(64, 48) })
  await page.waitForFunction((n) => window.__personalNote.leaferEdits.doc.objects.filter((o) => o.type === 'image').length > n, images, { timeout: 8000 })
  check('the image button opens the file input and places the picture', (await objects('image')).length === images + 1 && !(await flyoutOpen()))

  await click('[data-tool="text"]')
  await clickPage({ x: 100, y: 960 })
  await page.waitForFunction(() => document.querySelector('.leafer-text-editor, .md-editor'), null, { timeout: 5000 })
  await page.keyboard.type('- one   ')
  await click('#dock-more')
  check('opening the + while typing keeps the text open', await page.evaluate(() => Boolean(document.querySelector('.leafer-text-editor, .md-editor'))) && await flyoutOpen())
  await click('#prettify')
  await page.waitForTimeout(300)
  const typed = (await objects('text')).concat([]).map((o) => o.content)
  const editorText = await page.evaluate(() => { const e = document.querySelector('.leafer-text-editor, .md-editor'); return e ? (e.value ?? e.textContent) : null })
  check('Prettify from the flyout tidies the text being typed and leaves the editor open', editorText !== null && /^• one\s*$/.test(editorText.replace(/\n$/, '')) , JSON.stringify({ editorText, typed }))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // ================= hold-for-options
  await page.mouse.move(640, 500)
  const penBtn = await center('[data-tool="pen"]')
  await page.mouse.move(penBtn.x, penBtn.y)
  await page.mouse.down()
  await page.waitForTimeout(650)
  await page.mouse.up()
  await page.waitForTimeout(200)
  check('holding the pen opens its colour and width beside the island', (await tool()) === 'pen' && await popoverOpen() && (await rect('#ink-options-popover')).r <= (await rect('.tool-dock')).x)
  await page.keyboard.press('Escape')
  const hl = async () => { await click('#dock-more'); const c = await center('[data-tool="highlight"]'); await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up(); await page.waitForTimeout(250) }
  await hl()
  const popH = await rect('#ink-options-popover')
  check('holding the highlighter in the flyout opens the options level with the dot, closes the flyout and wears the +', (await tool()) === 'highlight' && await popoverOpen() && !(await flyoutOpen()) && popH.r <= (await rect('.tool-dock')).x && popH.y >= 0 && popH.b <= 800 && (await moreShows()).tool, JSON.stringify(popH))
  check('the highlighter options hold its widths', await page.evaluate(() => [...document.querySelectorAll('#stroke-widths [data-stroke-width]')].map((b) => b.dataset.strokeWidth).join() === '10,20,32,48'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check('holding text opens its colour options too', await (async () => { const c = await center('[data-tool="text"]'); await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up(); await page.waitForTimeout(200); return (await tool()) === 'text' && await popoverOpen() })())
  await page.keyboard.press('Escape')
  await away()

  // ================= every shortcut, with the island showing it
  await click('[data-tool="select"]')
  await away()
  await page.evaluate(() => { document.activeElement?.blur?.() })
  const keys = [['v', 'select'], ['h', 'hand'], ['t', 'text'], ['d', 'pen'], ['p', 'pen'], ['m', 'highlight'], ['r', 'shape'], ['n', 'sticky'], ['c', 'connect'], ['e', 'eraser']]
  for (const [key, expected] of keys) {
    await page.keyboard.press(key)
    await page.waitForTimeout(80)
    const main = tools.includes(expected)
    const shows = main ? await buttonOn(`[data-tool="${expected}"]`) : await page.evaluate((t) => document.querySelector(`#dock-flyout [data-tool="${t}"]`) && document.querySelector('#dock-more').classList.contains('active') && document.querySelector('#dock-more-tool').innerHTML.includes('<svg'), expected)
    check(`the ${key.toUpperCase()} key picks ${expected} and the island shows it`, (await tool()) === expected && Boolean(shows), `${await tool()} ${shows}`)
  }
  await page.keyboard.press('v')
  const chooser2 = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.keyboard.press('i')]).then(([c]) => c, () => null)
  await chooser2?.setFiles([])
  check('the I key opens the image file input', Boolean(chooser2), await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className} tool=${window.__personalNote.state.tool}`))
  await page.keyboard.press('t')
  await page.keyboard.down(' ')
  await page.waitForTimeout(120)
  const holdingSpace = { tool: await tool(), more: await moreShows() }
  await page.keyboard.up(' ')
  await page.waitForTimeout(120)
  check('holding Space is the hand (the + shows it) and letting go goes back to text', holdingSpace.tool === 'hand' && holdingSpace.more.active && (await tool()) === 'text' && await buttonOn('[data-tool="text"]'), JSON.stringify(holdingSpace))
  const doubleTap = async () => { for (let i = 0; i < 2; i += 1) { await page.keyboard.down('Control'); await page.keyboard.up('Control'); await page.waitForTimeout(60) } await page.waitForTimeout(150) }
  await away()
  await page.keyboard.press('d')
  await page.keyboard.press('t')
  await doubleTap()
  check('double-tapping Control goes to the pen and the island shows it', (await tool()) === 'pen' && await buttonOn('[data-tool="pen"]'), await tool())
  await doubleTap()
  check('double-tapping Control again goes back to text', (await tool()) === 'text' && await buttonOn('[data-tool="text"]'), await tool())
  const mid = await toClient({ x: 600, y: 900 })
  await page.mouse.click(mid.x, mid.y, { button: 'middle' })
  await page.waitForTimeout(250)
  check('a middle click toggles to the pen and the island shows it', (await tool()) === 'pen' && await buttonOn('[data-tool="pen"]'), await tool())
  await page.mouse.click(mid.x, mid.y, { button: 'middle' })
  await page.waitForTimeout(250)
  check('and back to text', (await tool()) === 'text', await tool())

  // ================= corner islands
  await page.keyboard.press('Escape')
  await click('[data-tool="pen"]')
  const strokesNow = (await objects('ink')).length
  await dragOnPage([{ x: 500, y: 1000 }, { x: 600, y: 1040 }])
  check('a fresh stroke exists to undo', (await objects('ink')).length === strokesNow + 1)
  await click('#undo')
  await page.waitForTimeout(250)
  check('the corner undo takes the stroke away', (await objects('ink')).length === strokesNow)
  await click('#redo')
  await page.waitForTimeout(250)
  check('the corner redo brings it back', (await objects('ink')).length === strokesNow + 1)
  await page.evaluate(() => window.__personalNote.setViewTo({ x: 200, y: 100, scale: 1 }))
  await page.waitForTimeout(300)
  const zoomText = () => page.evaluate(() => document.querySelector('#zoom-value').textContent)
  await click('#zoom-out')
  await page.waitForTimeout(500)
  const zoomedOut = await zoomText()
  check('zoom out lowers the percentage', parseInt(zoomedOut, 10) < 100, zoomedOut)
  await click('#zoom-in')
  await page.waitForTimeout(500)
  check('zoom in raises it again', parseInt(await zoomText(), 10) > parseInt(zoomedOut, 10), await zoomText())
  await click('#zoom-out')
  await page.waitForTimeout(400)
  await click('#zoom-value')
  await page.waitForTimeout(500)
  check('the percentage button resets to 100%', (await zoomText()) === '100%', await zoomText())
  await click('[data-tool="shape"]')
  await clickPage({ x: 820, y: 400 }) // near the right edge: the grid grows to two pages
  await page.waitForTimeout(500)
  await click('#zoom-fit')
  await page.waitForTimeout(700)
  check('fit zooms out to show every page', parseInt(await zoomText(), 10) < 100, await zoomText())
  check('the fit tooltip counts the pages', await page.evaluate(() => /^Zoom to fit all pages \(2 pages · 2 × 1\)$/.test(document.querySelector('#zoom-fit').title)), await page.evaluate(() => document.querySelector('#zoom-fit').title))
  await shot('1280x800-fit')

  // ================= the voice caption is clear of every island
  await page.evaluate(() => { const c = document.querySelector('#voice-caption'); c.hidden = false; document.querySelector('#voice-status').textContent = 'Listening for a long while to check the width of the caption' })
  const cap = await rect('#voice-caption')
  const all = [await rect('.tool-dock'), await rect('#history-island'), await rect('#zoom-control')]
  check('the voice caption is not covered by an island', all.every((r) => !overlap(cap, r)), JSON.stringify({ cap, all }))
  await page.evaluate(() => { document.querySelector('#voice-caption').hidden = true })
  check('the mic is the foot of the island and is live', await page.evaluate(() => { const b = document.querySelector('#voice-button'); return !b.disabled && getComputedStyle(b).pointerEvents !== 'none' }))

  // ================= the inspector panel would cover the right-hand islands: they stand clear of it
  await click('#share-button')
  await click('#top-properties')
  await page.waitForTimeout(500)
  const panelBox = await rect('#properties-panel')
  const dockBesidePanel = await rect('.tool-dock')
  const zoomBesidePanel = await rect('#zoom-control')
  check('with the inspector open the tool island and zoom island sit left of it', dockBesidePanel.r <= panelBox.x - 8 && zoomBesidePanel.r <= panelBox.x - 8, JSON.stringify({ panelBox, dockBesidePanel, zoomBesidePanel }))
  await click('[data-tool="select"]')
  check('and a tool can still be clicked there', (await tool()) === 'select')
  await click('#close-properties')
  await page.waitForTimeout(500)
  check('closing the inspector puts the islands back at the edge', Math.abs((await rect('.tool-dock')).r - 1264) <= 1)

  // ================= focus mode
  await page.evaluate(() => window.__personalNote.setViewTo({ x: 200, y: 100, scale: 1 }))
  const restDock = await rect('.tool-dock')
  const restHist = await rect('#history-island')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+.')
  await page.waitForTimeout(700)
  check('focus mode hides the tool island and both corner islands', await page.evaluate(() => ['.tool-dock', '#history-island', '#zoom-control'].every((s) => getComputedStyle(document.querySelector(s)).display === 'none')))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const backDock = await rect('.tool-dock')
  check('leaving focus mode restores them where they were', Math.abs(backDock.x - restDock.x) <= 1 && Math.abs(backDock.y - restDock.y) <= 1 && Math.abs((await rect('#history-island')).x - restHist.x) <= 1 && (await rect('#zoom-control')).w > 0)

  // ================= a mind map and a page note
  await openPanel()
  await click('[data-note-id="2"]')
  await page.waitForSelector('.mindmap-host:not([hidden]) svg', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const rail = await page.evaluate(() => { const d = document.querySelector('.tool-dock').getBoundingClientRect(); const buttons = [...document.querySelectorAll('#mindmap-rail-actions [data-map-action]')].map((b) => { const r = b.getBoundingClientRect(); return { a: b.dataset.mapAction, x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height } }); return { d: { x: d.x, y: d.y, r: d.right, b: d.bottom }, buttons, canvasHidden: getComputedStyle(document.querySelector('#dock-canvas')).display === 'none', history: getComputedStyle(document.querySelector('#history-island')).display, zoom: getComputedStyle(document.querySelector('#zoom-control')).display, tools: document.querySelectorAll('.tool-dock [data-tool]').length && [...document.querySelectorAll('.tool-dock [data-tool]')].some((b) => b.getBoundingClientRect().width > 0) } })
  check('a mind map shows its actions in the same right island (image, import, export JSON, export PNG, undo, redo, clean up, fit)', rail.buttons.map((b) => b.a).join() === 'image,import,export-json,export-png,undo,redo,clean,fit' && rail.buttons.every((b) => b.w === 44 && b.x >= rail.d.x && b.r <= rail.d.r && b.y >= rail.d.y && b.b <= rail.d.b) && Math.abs(rail.d.r - 1264) <= 1, JSON.stringify(rail))
  check('the canvas tools, the corner undo and the zoom island are not shown for a mind map', rail.canvasHidden && !rail.tools && rail.history === 'none' && rail.zoom === 'none', JSON.stringify(rail))
  const mapOverlaps = await page.evaluate(() => { const d = document.querySelector('.tool-dock').getBoundingClientRect(); return ['.mindmap-zoom', '.mindmap-minimap', '.mindmap-hint'].map((s) => { const e = document.querySelector(s); if (!e || getComputedStyle(e).display === 'none') return null; const r = e.getBoundingClientRect(); return r.x < d.right && d.x < r.right && r.y < d.bottom && d.y < r.bottom ? s : null }).filter(Boolean) })
  check('the island does not cover the mind map\'s own zoom, minimap or hint', mapOverlaps.length === 0, JSON.stringify(mapOverlaps))
  await shot('1280x800-mindmap')
  for (const action of ['clean', 'fit']) { const c = await center(`[data-map-action="${action}"]`); await page.mouse.click(c.x, c.y); await page.waitForTimeout(200) }
  check('the mind map actions can be clicked in the island without errors', errors.length === 0, JSON.stringify(errors))
  await openPanel()
  await click('[data-note-id="3"]')
  await page.waitForSelector('.page-host:not([hidden]) .cm-content', { timeout: 20000 })
  await page.waitForTimeout(500)
  check('a page note shows no tool island and no corner undo, as before', await page.evaluate(() => ['.tool-dock', '#history-island', '#zoom-control'].every((s) => getComputedStyle(document.querySelector(s)).display === 'none')))
  await openPanel()
  await click('[data-note-id="1"]')
  await page.waitForFunction(() => window.__personalNote.state.activeNoteId === 1 && document.querySelector('#dock-canvas') && getComputedStyle(document.querySelector('#dock-canvas')).display !== 'none', null, { timeout: 15000 })
  await page.waitForTimeout(500)
  check('back on the canvas note the tools and the corner islands return', await page.evaluate(() => ['.tool-dock', '#history-island'].every((s) => getComputedStyle(document.querySelector(s)).display !== 'none')))

  // ================= other windows
  stored[1].content = { objects: [] }
  stored[1].pageState = { columns: 1, rows: 1 }
  for (const [label, width, height, query] of [['1440x900', 1440, 900, ''], ['1280x800 mac window', 1280, 800, '?host=desktop&chrome=mac'], ['1440x900 mac window', 1440, 900, '?host=desktop&chrome=mac']]) {
    await page.setViewportSize({ width, height })
    await load(query)
    await layout(label, width, height)
    await shot(`${width}x${height}${query ? '-mac' : ''}-rest`)
  }
  // screenshots (PN_SHOT only): a note with words, a stroke and a sticky, at rest, with the + open, with the colour options open, and a mind map
  if (process.env.PN_SHOT) {
    for (const [width, height] of [[1280, 800], [1440, 900]]) {
      await page.setViewportSize({ width, height })
      stored[1].content = { objects: [] }
      stored[1].pageState = { columns: 1, rows: 1 }
      await load()
      await page.keyboard.type('# Q4 launch board\nShip the beta by Nov 1. Pricing page, onboarding email, demo video.')
      await page.keyboard.press('Escape')
      await click('[data-tool="sticky"]')
      await clickPage({ x: 520, y: 260 })
      await page.waitForTimeout(300)
      await page.keyboard.type('Key feedback: keep the chrome invisible until hovered')
      await page.keyboard.press('Escape')
      await click('[data-tool="pen"]')
      await dragOnPage([{ x: 120, y: 420 }, { x: 220, y: 380 }, { x: 330, y: 440 }, { x: 440, y: 390 }])
      await click('[data-tool="text"]')
      await page.keyboard.press('Escape')
      await page.mouse.move(width / 2, height / 2)
      await page.waitForTimeout(800)
      await shot(`${width}x${height}-note-rest`)
      await click('#dock-more')
      await page.waitForTimeout(300)
      await shot(`${width}x${height}-note-plus`)
      await page.keyboard.press('Escape')
      await click('[data-tool="pen"]')
      await click('#ink-options-trigger')
      await page.waitForTimeout(300)
      await shot(`${width}x${height}-note-colour`)
      await page.keyboard.press('Escape')
      await openPanel()
      await click('[data-note-id="2"]')
      await page.waitForSelector('.mindmap-host:not([hidden]) svg', { timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(900)
      await click('#toggle-sidebar')
      await page.waitForTimeout(500)
      await shot(`${width}x${height}-mindmap`)
    }
  }
  // narrow windows keep the mobile controls and show no island
  await page.setViewportSize({ width: 500, height: 800 })
  await load()
  check('at 500px wide the island and corner islands are gone and the mobile controls show', await page.evaluate(() => ['.tool-dock', '#history-island', '#zoom-control'].every((s) => getComputedStyle(document.querySelector(s)).display === 'none') && getComputedStyle(document.querySelector('.mobile-capture-controls')).display !== 'none'))
  await page.setViewportSize({ width: 390, height: 800 })
  await load()
  check('at 390px the same', await page.evaluate(() => ['.tool-dock', '#history-island'].every((s) => getComputedStyle(document.querySelector(s)).display === 'none') && getComputedStyle(document.querySelector('.mobile-capture-controls')).display !== 'none'))
  await page.setViewportSize({ width: 700, height: 800 })
  await load()
  const mid700 = await page.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const d = r('.tool-dock'); return { x: d.x, r: d.right, w: d.width, shows: getComputedStyle(document.querySelector('.tool-dock')).display !== 'none', mobile: getComputedStyle(document.querySelector('.mobile-capture-controls')).display } })
  check('at 700px (no mobile controls yet) the island is at the right edge', mid700.shows && mid700.mobile === 'none' && mid700.r <= 700 - 8 + 1 && mid700.w === 56, JSON.stringify(mid700))

  // reduced motion: the flyout does not animate
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await load()
  await click('#dock-more')
  check('with reduced motion the flyout shows without animation', await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#dock-flyout')).animationDuration) < 0.001))
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  check('no page errors', errors.length === 0, JSON.stringify(errors))
} finally {
  await browser.close()
  await server.close()
}
console.log(`${results.filter((x) => !x).length} of ${results.length} FAILED`)
process.exitCode = results.every(Boolean) ? 0 : 1
