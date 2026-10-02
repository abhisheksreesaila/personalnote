// F-036 checks, in the real app (Vite dev server on port 4825, mocked in-memory /api, headless Chromium): the dock features the former
// engine had that Leafer needed to catch up on.
//   - the Shape tool: a click places a rounded rectangle in the chosen colour, selected, saved, one undo step; a colour choice recolours
//     the selected shape; it can be moved; a shape near the right edge grows the page grid; the R key picks the tool
//   - Clear all on a canvas note: every object goes (one undo step), the grid folds back, the toast's Undo (and Ctrl+Z) brings it back
//   - voice dictation with no text open: the new box starts 42 px under the note's content (top left of an empty note)
//   - the agent "writing" flag sits over the last text block, and follows the view
//   - the voice-listening outline around the pages
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-dock.mjs
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const PORT = 4825
const now = new Date().toISOString()
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/documents/app-text.json', import.meta.url), 'utf8'))
const stored = { 1: { content: fixture.content, pageState: fixture.pageState, revision: 1 }, 2: { content: { objects: [] }, pageState: { columns: 1, rows: 1 }, revision: 1 } }
const puts = []
let agents = []
let feed = { sequence: 1, changes: [] }

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4829' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    const summary = (id) => ({ id, resourceId: `r${id}`, revision: stored[id].revision, noteType: 'canvas', title: `Note ${id}`, notebookId: 1, createdAt: now, updatedAt: now })
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 2 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary(1), summary(2)])
    const m = p.match(/^\/notes\/(\d+)$/)
    if (m && req.method() === 'GET') return json({ ...summary(Number(m[1])), content: stored[m[1]].content, pageState: stored[m[1]].pageState })
    if (m && req.method() === 'PUT') {
      const body = JSON.parse(req.postData())
      puts.push({ id: Number(m[1]), body })
      stored[m[1]] = { content: body.content, pageState: body.pageState, revision: stored[m[1]].revision + 1 }
      return json({ revision: stored[m[1]].revision, resourceId: `r${m[1]}` })
    }
    if (p.startsWith('/changes')) return json({ ...feed, changes: feed.changes.filter((c) => c.sequence > Number(new URL(req.url()).searchParams.get('since') ?? 0)), agents })
    return json({})
  })
  const scene = (fn, ...args) => page.evaluate(([name, a]) => window.__personalNote.leaferCanvas()[name](...a), [fn, args])
  const doc = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))
  const settle = () => page.waitForTimeout(1400)

  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(500)
  const box = await page.evaluate(() => { const r = document.querySelector('#note-input').getBoundingClientRect(); return { x: r.x, y: r.y } })
  const toClient = (point) => page.evaluate(([px, py]) => { const v = window.__personalNote.leaferCanvas().view(); const r = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: r.left + v.x + px * v.scale, y: r.top + v.y + py * v.scale } }, [point.x, point.y])

  // ---- a note opens with the Text tool, and one click starts typing
  check('opening a note selects the Text tool', await page.evaluate(() => window.__personalNote.state.tool) === 'text')
  const open = await toClient({ x: 600, y: 900 })
  await page.mouse.click(open.x, open.y)
  await page.waitForFunction(() => document.activeElement?.classList?.contains('leafer-text-editor'), null, { timeout: 5000 })
  await page.keyboard.type('hi')
  check('one click then starts typing', await page.evaluate(() => document.activeElement.value ?? document.activeElement.textContent).then((v) => /hi/.test(v)))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // ---- the Shape tool
  const before = (await doc()).objects.length
  await page.keyboard.press('r')
  check('the R key picks the Shape tool', await page.evaluate(() => window.__personalNote.state.tool) === 'shape')
  check('the Shape button is live in the dock', await page.evaluate(() => { const b = document.querySelector('[data-tool="shape"]'); const s = getComputedStyle(b); return s.opacity === '1' && s.pointerEvents !== 'none' }))
  const at = await toClient({ x: 400, y: 700 })
  await page.mouse.click(at.x, at.y)
  await page.waitForTimeout(300)
  let d = await doc()
  const shape = d.objects.at(-1)
  check('a click places one rounded rectangle centred on it', d.objects.length === before + 1 && shape.type === 'shape' && shape.kind === 'rect' && Math.abs(shape.geometry.x + shape.geometry.width / 2 - 400) < 1 && Math.abs(shape.geometry.y + shape.geometry.height / 2 - 700) < 1 && shape.cornerRadius > 0, JSON.stringify(shape))
  check('the tool goes back to Select and the shape is selected', await page.evaluate(() => window.__personalNote.state.tool) === 'select' && (await scene('selection')).includes(shape.id))
  await settle()
  const saved = puts.at(-1)?.body.content
  check('it is saved (JSON Canvas, as a node)', Boolean(saved?.nodes?.some((n) => n.id === shape.id)))
  // recolour with an object colour while it is selected
  await page.evaluate(() => { window.__personalNote.setTool('shape'); window.__personalNote.setTool('select') })
  check('the shape tool offers the five object colours', await page.evaluate(() => document.querySelectorAll('#object-palette [data-object-color]').length) === 5)
  await scene('select', [shape.id])
  await page.evaluate(() => { document.querySelectorAll('#object-palette [data-object-color]')[3].click() })
  await page.waitForTimeout(300)
  d = await doc()
  check('choosing a colour recolours the selected shape', d.objects.find((o) => o.id === shape.id).fill !== shape.fill, JSON.stringify(d.objects.find((o) => o.id === shape.id)))
  await page.evaluate(() => window.__personalNote.setTool('select'))
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(200)
  check('undo steps the colour back', (await doc()).objects.find((o) => o.id === shape.id)?.fill === shape.fill)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(200)
  check('a second undo takes the shape away', (await doc()).objects.length === before)
  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(200)
  check('redo brings it back', (await doc()).objects.some((o) => o.id === shape.id))
  // page growth
  const columnsBefore = (await doc()).page.columns
  await page.evaluate(() => window.__personalNote.setTool('shape'))
  const edge = await toClient({ x: columnsBefore * 860 - 40, y: 400 })
  await page.mouse.click(edge.x, edge.y)
  await page.waitForTimeout(400)
  d = await doc()
  check('a shape near the right edge grows the page grid', d.page.columns > columnsBefore, JSON.stringify(d.page))

  // ---- Clear all
  const countNow = (await doc()).objects.length
  await page.evaluate(() => document.querySelector('#clear-note').click())
  await page.waitForTimeout(400)
  d = await doc()
  check('Clear all empties the canvas note and folds the grid back to one page', d.objects.length === 0 && d.page.columns === 1 && d.page.rows === 1, JSON.stringify(d.page))
  check('it offers Undo in a toast', await page.evaluate(() => !document.querySelector('#toast').hidden && /Note cleared/.test(document.querySelector('#toast').textContent)))
  await page.evaluate(() => document.querySelector('#toast-action').click())
  await page.waitForTimeout(500)
  d = await doc()
  check('Undo brings every object and the grid back, in one step', d.objects.length === countNow && d.page.columns > 1, `${d.objects.length} vs ${countNow}`)
  await page.evaluate(() => document.querySelector('#clear-note').click())
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(400)
  check('Ctrl+Z also undoes it', (await doc()).objects.length === countNow)
  await page.evaluate(() => document.querySelector('#clear-note').click())
  await settle()
  const clearedSave = puts.at(-1)
  check('the cleared note is saved empty', clearedSave.body.content.nodes.length === 0, JSON.stringify(clearedSave.body.content).slice(0, 120))
  await page.evaluate(() => document.querySelector('#toast-action').click())
  await settle()

  // ---- voice dictation with no text open
  const bottom = await page.evaluate(() => {
    const n = window.__personalNote
    const ys = n.leaferEdits.doc.objects.filter((o) => o.type !== 'connector' && o.geometry).map((o) => { const r = n.leaferCanvas().boxes(); return o })
    return ys.length
  })
  check('the restored note has content for dictation to go under', bottom > 0)
  const content = await page.evaluate(() => { const b = window.__personalNote.leaferCanvas().boxes(); return { bottom: Math.max(...b.map((x) => x.top + x.height)), n: b.length } })
  const spot = await page.evaluate(() => window.__personalNote.voiceBoxPoint())
  check('a new dictation box starts 42 px under the content', Math.abs(spot.y - (content.bottom + 42)) < 6, `${JSON.stringify(spot)} vs bottom ${content.bottom}`)
  await page.evaluate(() => document.querySelector('[data-note-id="2"]').click())
  await page.waitForFunction(() => window.__personalNote.state.activeNoteId === 2 && document.documentElement.dataset.leaferSettled === '2', null, { timeout: 15000 })
  const empty = await page.evaluate(() => window.__personalNote.voiceBoxPoint())
  check('on an empty note it starts near the top left of the first page', empty.x === 96 && empty.y === 96, JSON.stringify(empty))

  // ---- the voice-listening outline
  const px = async () => {
    const v = await page.evaluate(() => window.__personalNote.leaferCanvas().view())
    const r = await page.evaluate(() => { const b = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: b.left, y: b.top } })
    const buffer = await page.screenshot({ clip: { x: Math.round(r.x + v.x + 300), y: Math.round(r.y + v.y - 4), width: 2, height: 2 } })
    return buffer
  }
  const off = await px()
  await page.evaluate(() => window.__personalNote.leaferCanvas().setListening(true))
  await page.waitForTimeout(300)
  const on = await px()
  await page.evaluate(() => window.__personalNote.leaferCanvas().setListening(false))
  await page.waitForTimeout(300)
  const off2 = await px()
  check('the pages are outlined while dictation listens, and not otherwise', !on.equals(off) && off.equals(off2))

  // ---- the agent flag
  await page.evaluate(() => document.querySelector('[data-note-id="1"]').click())
  await page.waitForFunction(() => window.__personalNote.state.activeNoteId === 1 && document.documentElement.dataset.leaferSettled === '1', null, { timeout: 15000 })
  agents = [{ agent: 'Claude Code', action: 'writing', noteId: 1 }]
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.waitForFunction(() => !document.querySelector('.agent-flag').hidden, null, { timeout: 8000 })
  const flag = await page.evaluate(() => { const f = document.querySelector('.agent-flag'); const r = f.getBoundingClientRect(); return { text: f.textContent, x: r.x, y: r.bottom } })
  const texts = (await doc()).objects.filter((o) => (o.type === 'text' || o.type === 'sticky') && o.content?.trim()).sort((a, b) => a.geometry.y - b.geometry.y || a.geometry.x - b.geometry.x)
  const last = await toClient(texts.at(-1).geometry)
  check('the writing flag sits over the last text block', /writing/.test(flag.text) && Math.abs(flag.x - last.x) < 4 && Math.abs(flag.y + 4 - last.y) < 8, `${JSON.stringify(flag)} vs ${JSON.stringify(last)}`)
  const v0 = await page.evaluate(() => window.__personalNote.leaferCanvas().view())
  await page.evaluate(() => { const n = window.__personalNote; const v = n.leaferCanvas().view(); n.setCanvasViewportOffset(v.x - 30, v.y) })
  await page.waitForTimeout(300)
  const v1 = await page.evaluate(() => window.__personalNote.leaferCanvas().view())
  const moved = await page.evaluate(() => document.querySelector('.agent-flag').getBoundingClientRect().x)
  check('the flag follows the view', v1.x !== v0.x && Math.abs(moved - flag.x - (v1.x - v0.x)) < 2, `${flag.x} -> ${moved}, view ${v0.x} -> ${v1.x}`)

  // an agent moves that block: the flag is placed again at once
  const lastId = texts.at(-1).id
  const moved1 = JSON.parse(JSON.stringify(stored[1].content))
  const node = moved1.nodes.find((n) => n.id === lastId)
  node.y += 120
  if (node.pn?.geometry) node.pn.geometry.y += 120
  stored[1] = { ...stored[1], content: moved1, revision: stored[1].revision + 1 }
  feed = { sequence: 2, changes: [{ sequence: 2, resourceKind: 'note', resourceId: 'r1', changeType: 'updated', revision: stored[1].revision }] }
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__personalNote.leaferCanvas().view())
  const after = await page.evaluate(() => document.querySelector('.agent-flag').getBoundingClientRect().bottom)
  check('after an agent moves the block the flag is placed again', Math.abs(after - (flag.y + 120 * v1.scale)) < 6 && !(await page.evaluate(() => document.querySelector('.agent-flag').hidden)), `${flag.y} -> ${after}`)

  check('no console errors', errors.length === 0, JSON.stringify(errors))
} finally {
  await browser.close()
  await server.close()
}
console.log(`${results.filter((x) => !x).length} of ${results.length} FAILED`)
process.exitCode = results.every(Boolean) ? 0 : 1
