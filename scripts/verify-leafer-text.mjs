// F-029 checks, in the real app (Vite dev server on port 4760, mocked in-memory /api that keeps what the app saves and serves it back
// on reload, headless Chromium): create and edit text and stickies on the Leafer canvas, multiline, wrapping and auto-grow, font size,
// font, colour and sticky colour, undo and redo of a typing session, a reload shows the same words and geometry, the overlay editor lines
// up with the drawn text (50%, 100%, 200% and turned), the input method (composition through the DevTools protocol: CJK, accents,
// emoji) writes each character once, and the words keep their line breaks when the edit ends.
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-text.mjs
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { readJsonCanvas, writeJsonCanvas } from '../src/core/document/jsoncanvas.js'

const PORT = 4760
const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'pn-shots-')) // a folder of this run's own
fs.mkdirSync(SHOTS, { recursive: true })
const now = new Date().toISOString()
const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/documents/app-all-tools.json', import.meta.url), 'utf8'))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

const [itext, , sticky] = fixture.content.objects
const clone = (object, changes) => ({ ...structuredClone(object), ...changes })
const BOX = 'res_00000000000040008000000000000091'
const TURNED_TEXT = 'res_00000000000040008000000000000092'
const TURNED_STICKY = 'res_00000000000040008000000000000093'
fixture.content.objects.push(
  clone(fixture.content.objects[1], { type: 'Textbox', semanticId: BOX, text: 'A text box that wraps its words onto several lines when it is narrow', left: 420, top: 1010, width: 220, height: 100 }),
  clone(itext, { semanticId: TURNED_TEXT, text: 'Turned words\nsecond line', left: 140, top: 1010, width: 170, height: 66, angle: 20 }),
  clone(sticky, { semanticId: TURNED_STICKY, text: 'Turned note', left: 700, top: 840, angle: -15 }),
)
let stored = { content: fixture.content, pageState: fixture.pageState, revision: 1 }
const puts = []
const puts2 = []
let holdPutMs = 0 // the response to a save is held back this long
let putStarted = 0
let enforceRevision = false // a stale save is refused, as the real server does
let changeSeq = 1
const changeLog = []
// An agent writes the note: `rewrite` [{ id, content }], `remove` [ids], `append` [{ id, content }]. The server canonicalizes what it stores.
const agentWrite = ({ rewrite = [], remove = [], append = [] }) => {
  const doc = readJsonCanvas(stored.content)
  const g = { x: 600, y: 940, width: 200, height: 60, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
  for (const { id, content } of rewrite) doc.objects.find((o) => o.id === id).content = content
  doc.objects = doc.objects.filter((o) => !remove.includes(o.id))
  for (const { id, content } of append) doc.objects.push({ id, type: 'text', mode: 'box', z: doc.objects.length + 50, content, geometry: { ...g } })
  stored.content = writeJsonCanvas(doc, { derived: 'omit' })
  stored.revision += 1
  changeSeq += 1
  changeLog.push({ sequence: changeSeq, resourceKind: 'note', resourceId: 'r1', changeType: 'updated', revision: stored.revision })
}

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4769' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

async function mock(page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    const summary = { id: 1, resourceId: 'r1', revision: stored.revision, noteType: 'canvas', title: 'Text', notebookId: 1, createdAt: now, updatedAt: now }
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    const second = { ...summary, id: 2, resourceId: 'r2', title: 'Other', revision: 1 }
    if (p === '/notes' && req.method() === 'GET') return json([summary, second])
    if (p === '/notes/2' && req.method() === 'GET') return json({ ...second, content: { version: '7.4.0', objects: [] }, pageState: { columns: 1, rows: 1 } })
    if (p === '/notes/2' && req.method() === 'PUT') { puts2.push(JSON.parse(req.postData())); return json({ revision: 2, resourceId: 'r2' }) }
    if (p === '/changes') { const since = Number(new URL(req.url()).searchParams.get('since') ?? changeSeq); return json({ sequence: changeSeq, changes: changeLog.filter((c) => c.sequence > since), agents: [] }) }
    if (p === '/notes/1' && req.method() === 'GET') return json({ ...summary, content: stored.content, pageState: stored.pageState })
    if (p === '/notes/1' && req.method() === 'PUT') {
      const body = JSON.parse(req.postData())
      putStarted += 1
      if (holdPutMs) await new Promise((resolve) => setTimeout(resolve, holdPutMs))
      if (enforceRevision && body.revision !== stored.revision) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'revision conflict' }) })
      puts.push(body)
      stored = { content: body.content, pageState: body.pageState, revision: stored.revision + 1 }
      return json({ revision: stored.revision, resourceId: 'r1' })
    }
    return json({})
  })
}

const scene = (page, name, ...args) => page.evaluate(([n, a]) => window.__personalNote.leaferCanvas()[n](...a), [name, args])
async function open(page) {
  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(400)
}
const live = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))
const steps = (page) => page.evaluate(() => window.__personalNote.leaferEdits.stats().undoSteps)
const savedDoc = () => readJsonCanvas(puts.at(-1).content)
const waitForSave = async (page, before) => { for (let i = 0; i < 40 && puts.length <= before; i += 1) await page.waitForTimeout(150); await page.waitForTimeout(100); return puts.length > before }
const view = (page) => page.evaluate(() => {
  const world = window.__personalNote.leaferCanvas().drawnWorld()
  const rect = document.querySelector('#leafer-host').getBoundingClientRect()
  return { x: rect.left + world.x, y: rect.top + world.y, scale: world.scaleX }
})
async function pagePoint(page, x, y) { const v = await view(page); return { x: v.x + x * v.scale, y: v.y + y * v.scale } }
async function centre(page, id) {
  const { box, host } = await page.evaluate((target) => ({ box: window.__personalNote.leaferCanvas().screenBox(target), host: (() => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: r.left, y: r.top } })() }), id)
  return { x: host.x + box.x + box.width / 2, y: host.y + box.y + box.height / 2, left: host.x + box.x, top: host.y + box.y, width: box.width, height: box.height }
}
const editorOpen = (page) => page.evaluate(() => Boolean(document.querySelector('.leafer-text-editor')))
const editorValue = (page) => page.evaluate(() => document.querySelector('.leafer-text-editor')?.value ?? null)
const objectOf = (doc, id) => doc.objects.find((object) => object.id === id)
const newObjects = (before, after) => after.objects.filter((object) => !before.objects.some((old) => old.id === object.id))
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance

// ---- the shape of the drawn words, measured from a screenshot: the bounding box of everything that is not the background
async function inkBox(page, clip) {
  const png = await page.screenshot({ clip })
  return await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    const key = (i) => `${data[i]},${data[i + 1]},${data[i + 2]}`
    const counts = new Map()
    for (let i = 0; i < data.length; i += 4) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1)
    const [background] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    const [br, bg, bb] = background.split(',').map(Number)
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, ink = 0
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) > 90) { ink += 1; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    }
    return { minX, minY, maxX, maxY, ink }
  }, png.toString('base64'))
}

// The lines a textarea breaks its words into, read off a mirror with the same font and width.
const overlayLines = (page) => page.evaluate(() => {
  const area = document.querySelector('.leafer-text-editor')
  const style = getComputedStyle(area)
  const mirror = document.createElement('div')
  Object.assign(mirror.style, { position: 'absolute', left: '-9999px', top: '0', width: style.width, font: style.font, letterSpacing: style.letterSpacing, whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, wordBreak: style.wordBreak, textAlign: style.textAlign, lineHeight: style.lineHeight })
  mirror.textContent = area.value
  document.body.append(mirror)
  const text = mirror.firstChild
  const lines = []
  let top = null
  let line = ''
  for (let i = 0; i < area.value.length; i += 1) {
    const ch = area.value[i]
    if (ch === '\n') { lines.push(line); line = ''; top = null; continue }
    const range = document.createRange()
    range.setStart(text, i); range.setEnd(text, i + 1)
    const rect = range.getClientRects()[0]
    if (!rect) { line += ch; continue }
    if (top !== null && Math.abs(rect.top - top) > 2) { lines.push(line); line = '' }
    top = rect.top
    line += ch
  }
  lines.push(line)
  mirror.remove()
  return lines.map((l) => l.replace(/\s+$/, ''))
})

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await mock(page)
  await open(page)
  const cdp = await context.newCDPSession(page)

  const act = async (fn) => { const n = puts.length; await fn(); return await waitForSave(page, n) }
  const stillSteps = await steps(page)
  const initial = await live(page)
  const T = initial.objects.filter((o) => o.type === 'text')[0].id
  const S = initial.objects.filter((o) => o.type === 'sticky')[0].id
  const TURNED_T = objectOf(initial, TURNED_TEXT) ? TURNED_TEXT : null
  const idOf = (fabricId) => fabricId
  void idOf
  const emptySpot = await pagePoint(page, 60, 60)
  const deselect = async () => { const p = await pagePoint(page, 820, 20); await page.mouse.click(p.x, p.y); await page.waitForTimeout(80) }

  // ---- create text with the Text tool
  await page.click('[data-tool="text"]')
  let before = await live(page)
  let stepsBefore = await steps(page)
  const saved = await act(async () => {
    await page.mouse.click(emptySpot.x, emptySpot.y)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.type('Hello text')
    check('while typing nothing is in the document yet (a new text exists only with words)', (await live(page)).objects.length === before.objects.length)
    await page.keyboard.press('Escape')
  })
  let after = await live(page)
  const made = newObjects(before, after)
  check('a new text uses the monospace default font', made[0]?.style.fontFamily === '"Geist Mono", monospace', JSON.stringify(made[0]?.style))
  check('the Text tool makes one text from a click and typing', made.length === 1 && made[0].type === 'text' && made[0].content === 'Hello text', JSON.stringify(made))
  const N1 = made[0]?.id
  check('creating a text is one undo step', (await steps(page)) === stepsBefore + 1, `${stepsBefore} -> ${await steps(page)}`)
  check('the text is saved, as JSON Canvas text with its words', saved && objectOf(savedDoc(), N1)?.content === 'Hello text')
  check('the geometry is the measured size of the words, at the click', made[0] && made[0].geometry.width > 40 && made[0].geometry.height > 15 && near(made[0].geometry.x, (emptySpot.x - (await view(page)).x) / (await view(page)).scale, 1.5), JSON.stringify(made[0]?.geometry))
  check('Esc leaves the Select tool on', await page.evaluate(() => window.__personalNote.state.tool) === 'select')
  const info = await scene(page, 'textInfo', N1)
  check('the Leafer text shows the typed words and the overlay is gone', info && info.rows.join('\n') === 'Hello text' && info.visible && !(await editorOpen(page)), JSON.stringify(info))

  // an empty text is not made, and costs no step
  await page.click('[data-tool="text"]')
  stepsBefore = await steps(page)
  const emptyAt = await pagePoint(page, 60, 140)
  await page.mouse.click(emptyAt.x, emptyAt.y)
  await page.waitForSelector('.leafer-text-editor')
  await page.keyboard.type('   ')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check('a text left empty is not made', (await live(page)).objects.length === after.objects.length && (await steps(page)) === stepsBefore)

  // ---- multiline
  await page.click('[data-tool="text"]')
  before = await live(page)
  const multiAt = await pagePoint(page, 60, 220)
  await act(async () => {
    await page.mouse.click(multiAt.x, multiAt.y)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.type('first line')
    await page.keyboard.press('Enter')
    await page.keyboard.type('second line')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('after a blank line')
    await page.keyboard.press('Control+Enter')
  })
  after = await live(page)
  const multi = newObjects(before, after)[0]
  const multiInfo = await scene(page, 'textInfo', multi?.id)
  check('Enter makes a new line, a blank line stays, Ctrl+Enter ends the edit', multi?.content === 'first line\nsecond line\n\nafter a blank line' && !(await editorOpen(page)), JSON.stringify(multi?.content))
  check('the drawn text has the same four lines, and the box is four lines tall', multiInfo?.rows.length === 4 && near(multi.geometry.height, multiInfo.lineHeight * 4, 1), JSON.stringify([multiInfo?.rows, multi?.geometry]))

  // ---- edit by double click (Select tool); a typing session is one undo step
  await page.click('[data-tool="select"]')
  await deselect()
  let c = await centre(page, N1)
  stepsBefore = await steps(page)
  await act(async () => {
    await page.mouse.dblclick(c.x, c.y)
    await page.waitForSelector('.leafer-text-editor')
    check('a double click opens the editor with the words in it', (await editorValue(page)) === 'Hello text')
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' and more')
    await page.keyboard.press('Home')
    await page.keyboard.type('>> ')
    await deselect() // click away ends the edit
  })
  check('click-away ends the edit and keeps what was typed', objectOf(await live(page), N1)?.content === '>> Hello text and more', objectOf(await live(page), N1)?.content)
  check('a whole typing session is one undo step', (await steps(page)) === stepsBefore + 1, `${stepsBefore} -> ${await steps(page)}`)
  await page.click('#undo')
  check('undo takes back the whole session', objectOf(await live(page), N1)?.content === 'Hello text')
  await page.click('#redo')
  check('redo puts it back', objectOf(await live(page), N1)?.content === '>> Hello text and more')
  await page.waitForTimeout(900)

  // ---- a double click on empty paper makes a text; deleting every word removes the text
  const dbl = await pagePoint(page, 60, 420)
  before = await live(page)
  await page.mouse.dblclick(dbl.x, dbl.y)
  await page.waitForSelector('.leafer-text-editor')
  await page.keyboard.type('made by double click')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  check('a double click on empty paper makes a text', newObjects(before, await live(page)).some((o) => o.content === 'made by double click'))
  const dblId = newObjects(before, await live(page))[0]?.id
  stepsBefore = await steps(page)
  await scene(page, 'editText', dblId)
  await page.waitForSelector('.leafer-text-editor')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  check('emptying a text removes it (one step, undo brings it back)', !objectOf(await live(page), dblId) && (await steps(page)) === stepsBefore + 1)
  await page.click('#undo')
  check('undo of the removal restores the original words', objectOf(await live(page), dblId)?.content === 'made by double click')
  await page.waitForTimeout(900)

  // ---- stickies
  await page.click('[data-tool="sticky"]')
  before = await live(page)
  stepsBefore = await steps(page)
  const stickyAt = await pagePoint(page, 690, 330)
  await act(async () => {
    await page.mouse.click(stickyAt.x, stickyAt.y)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.type('Buy paper')
    await page.keyboard.press('Escape')
  })
  after = await live(page)
  const st = newObjects(before, after)[0]
  check('the Sticky tool makes a sticky centred on the click, with its words', st?.type === 'sticky' && st.content === 'Buy paper' && near(st.geometry.x + st.geometry.width / 2, 690, 3) && near(st.geometry.y + st.geometry.height / 2, 330, 3) && st.geometry.height === 200, JSON.stringify(st))
  check('a new sticky and its first words are one undo step', (await steps(page)) === stepsBefore + 1, `${stepsBefore} -> ${await steps(page)}`)
  check('a sticky has the Caveat handwriting and the palette colour', st?.style.fontFamily === 'Caveat' && st.style.fontSize === 34 && /^#[0-9a-f]{6}$/i.test(st.color), JSON.stringify(st?.style))
  await page.click('#undo')
  check('undo removes the whole sticky', !objectOf(await live(page), st.id))
  await page.click('#redo')
  check('redo brings it back with its words', objectOf(await live(page), st.id)?.content === 'Buy paper')
  await page.waitForTimeout(900)

  // auto-grow: a sticky grows to hold its words, never below 200
  const stickyId = st.id
  await scene(page, 'editText', stickyId)
  await page.waitForSelector('.leafer-text-editor')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight')
  const live1 = await scene(page, 'textInfo', stickyId)
  void live1
  const grownPaper = await page.evaluate((id) => window.__personalNote.leaferCanvas().screenBox(id).height, stickyId)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const grown = objectOf(await live(page), stickyId)
  const grownInfo = await scene(page, 'textInfo', stickyId)
  check('a sticky grows to hold its words (height = text + padding)', grown.geometry.height > 200 && near(grown.geometry.height, grownInfo.height + 44, 1.5), JSON.stringify([grown.geometry.height, grownInfo.height]))
  check('the paper grew while typing, not only afterwards', grownPaper > 200 * (await view(page)).scale + 5, String(grownPaper))
  await scene(page, 'editText', stickyId)
  await page.waitForSelector('.leafer-text-editor')
  await page.keyboard.press('Control+A')
  await page.keyboard.type('short')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  check('a sticky shrinks back to what its words need, never below 200 (as the Fabric sticky does)', objectOf(await live(page), stickyId).geometry.height === 200, String(objectOf(await live(page), stickyId).geometry.height))
  await page.waitForTimeout(900)

  // ---- wrap and auto-grow of a text box
  const boxObject = initial.objects.find((o) => o.type === 'text' && o.mode === 'box' && o.content.startsWith('A text box'))
  await scene(page, 'editText', boxObject.id)
  await page.waitForSelector('.leafer-text-editor')
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' plus a good many more words so that it has to wrap onto further lines')
  const lines = await overlayLines(page)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  const boxNow = objectOf(await live(page), boxObject.id)
  const boxInfo = await scene(page, 'textInfo', boxObject.id)
  check('a text box wraps at its width and grows to its lines', boxNow.geometry.width === boxObject.geometry.width && near(boxNow.geometry.height, boxInfo.lineHeight * boxInfo.rows.length, 1) && boxInfo.rows.length >= 4, JSON.stringify([boxNow.geometry, boxInfo.rows]))
  check('after the edit the drawn text breaks its lines where the editor did', JSON.stringify(lines) === JSON.stringify(boxInfo.rows.map((r) => r.replace(/\s+$/, ''))), JSON.stringify([lines, boxInfo.rows]))
  await page.waitForTimeout(900)

  // ---- typography: font size, font, colour, sticky colour (from the real controls)
  await deselect()
  await scene(page, 'select', [N1])
  const sizesBefore = await live(page)
  await act(async () => {
    await page.evaluate(() => { const input = document.querySelector('#font-size-control'); input.value = '40'; input.dispatchEvent(new Event('input', { bubbles: true })) })
  })
  let styled = objectOf(await live(page), N1)
  check('the size slider changes the selected text, and its box follows the new size', styled.style.fontSize === 40 && styled.geometry.height > objectOf(sizesBefore, N1).geometry.height * 1.3, JSON.stringify(styled.style))
  await page.evaluate(() => document.querySelector('[data-font-family="IBM Plex Sans"]').click())
  styled = objectOf(await live(page), N1)
  check('the font buttons change the selected text', styled.style.fontFamily === 'IBM Plex Sans')
  const swatch = await page.evaluate(() => document.querySelectorAll('.ink-swatch')[2].dataset.color)
  await page.evaluate(() => document.querySelectorAll('.ink-swatch')[2].click())
  styled = objectOf(await live(page), N1)
  check('a colour swatch changes the text colour', styled.style.color === swatch, `${styled.style.color} vs ${swatch}`)
  const styledInfo = await scene(page, 'textInfo', N1)
  check('Leafer draws the new size, font and colour', styledInfo.fontSize === 40 && /IBM Plex Sans/.test(styledInfo.fontFamily) && styledInfo.fill === swatch, JSON.stringify(styledInfo))
  await scene(page, 'select', [stickyId])
  const palette = await page.evaluate(() => { const b = document.querySelectorAll('[data-object-color]'); b[1].click(); return getComputedStyle(b[1]).getPropertyValue('--swatch').trim() })
  const restyled = objectOf(await live(page), stickyId)
  check('the sticky colour changes the paper and its writing', restyled.color === palette && restyled.style.color !== grown.style.color, JSON.stringify([restyled.color, palette, restyled.style.color]))
  await page.click('#undo')
  check('undo takes back the sticky colour', objectOf(await live(page), stickyId).color === grown.color)
  await page.waitForTimeout(900)

  // ---- reload shows the same words and geometry
  await page.waitForTimeout(500)
  const beforeReload = await live(page)
  const savedCount = puts.length
  await open(page)
  const reloaded = await live(page)
  const strip = (doc) => doc.objects.filter((o) => ['text', 'sticky'].includes(o.type)).map((o) => ({ id: o.id, type: o.type, content: o.content, color: o.color, g: ['x', 'y', 'width', 'height', 'rotation'].map((k) => Math.round((o.geometry[k] ?? 0) * 100) / 100), size: o.style?.fontSize, font: o.style?.fontFamily }))
  check('reload shows identical text, colours and geometry', JSON.stringify(strip(beforeReload)) === JSON.stringify(strip(reloaded)), JSON.stringify([strip(beforeReload), strip(reloaded)]))
  check('opening the note again saves nothing', puts.length === savedCount)

  // ---- words typed are saved as they are typed, inside the one undo step
  {
    await scene(page, 'clearSelection')
    const draftSteps = await steps(page)
    const putsBefore = puts.length
    await scene(page, 'editText', N1)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' DRAFT')
    check('typed words reach a save without ending the session', await (async () => { for (let i = 0; i < 40 && puts.length === putsBefore; i += 1) await page.waitForTimeout(100); return puts.length > putsBefore && objectOf(savedDoc(), N1)?.content.endsWith(' DRAFT') && (await editorOpen(page)) })(), JSON.stringify(puts.at(-1) && objectOf(savedDoc(), N1)?.content))
    check('the session is still a single undo step while it saves', (await steps(page)) === draftSteps, `${draftSteps} -> ${await steps(page)}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('ending the session makes it one undo step', (await steps(page)) === draftSteps + 1, `${draftSteps} -> ${await steps(page)}`)
    await page.click('#undo')
    check('undo takes back everything typed in the session at once', !objectOf(await live(page), N1).content.endsWith(' DRAFT'))
    await page.click('#redo')
    // a new text made by drafts, mid-session
    await page.click('[data-tool="text"]')
    const at = await pagePoint(page, 60, 520)
    const stepsNew = await steps(page)
    const before = await live(page)
    await page.mouse.click(at.x, at.y)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.type('made while typing')
    await page.waitForTimeout(1200)
    const midway = newObjects(before, await live(page))
    check('a new text is made at its first pause in typing, inside the session', midway.length === 1 && midway[0].content === 'made while typing' && (await editorOpen(page)) && (await steps(page)) === stepsNew, JSON.stringify(midway.map((o) => o.content)))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('creating that text is still one undo step', (await steps(page)) === stepsNew + 1, `${stepsNew} -> ${await steps(page)}`)
    // typed and emptied again inside one session: nothing is made
    await page.click('[data-tool="text"]')
    const at2 = await pagePoint(page, 60, 600)
    const stepsGone = await steps(page)
    await page.mouse.click(at2.x, at2.y)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.type('gone')
    await page.waitForTimeout(1100)
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Delete')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    check('words typed and deleted again in one session leave no text and no step', (await steps(page)) === stepsGone && !(await live(page)).objects.some((o) => o.content === 'gone'))
    await page.waitForTimeout(900)
  }

  // ---- an agent rewrites, deletes and appends while words are typed: everything survives; a close right after keeps the words
  {
    await page.evaluate(() => { window.__saveStates = []; new MutationObserver(() => window.__saveStates.push(document.querySelector('#save-state').dataset.state)).observe(document.querySelector('#save-state'), { attributes: true, childList: true }) })
    enforceRevision = true
    await scene(page, 'clearSelection')
    const boxId = initial.objects.find((o) => o.type === 'text' && o.mode === 'box' && o.content.startsWith('A text box')).id
    const doomed = (await live(page)).objects.find((o) => o.type === 'text' && o.content === 'made by double click').id
    await scene(page, 'editText', N1)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' [typing]')
    agentWrite({ rewrite: [{ id: boxId, content: 'REWRITTEN BY AGENT' }], remove: [doomed], append: [{ id: 'agent_node_1', content: 'agent was here' }] })
    await page.waitForTimeout(4500)
    const mid = await live(page)
    check('the editor stays open on the typed text through the merge', (await editorOpen(page)) && (await editorValue(page)).endsWith(' [typing]'), String(await editorValue(page)))
    check('an agent rewrite of another object arrives at once', objectOf(mid, boxId)?.content === 'REWRITTEN BY AGENT', objectOf(mid, boxId)?.content)
    check('an agent deletion arrives and is not brought back', !objectOf(mid, doomed))
    check('an agent append arrives', objectOf(mid, 'agent_node_1')?.content === 'agent was here')
    check('the typed words are kept beside them', objectOf(mid, N1)?.content.endsWith(' [typing]'), objectOf(mid, N1)?.content)
    check('the drawn rewrite is on screen', (await scene(page, 'textInfo', boxId)).rows.join(' ').startsWith('REWRITTEN'), JSON.stringify(await scene(page, 'textInfo', boxId)))
    check('the words typed since the agent wrote are already saved, with the agent\'s changes, while the editor is open', objectOf(savedDoc(), N1)?.content.endsWith(' [typing]') && objectOf(savedDoc(), boxId)?.content === 'REWRITTEN BY AGENT' && !objectOf(savedDoc(), doomed) && Boolean(objectOf(savedDoc(), 'agent_node_1')), JSON.stringify(objectOf(savedDoc(), N1)?.content))
    await page.keyboard.type(' more')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    const done = await live(page)
    check('after the session the words, the rewrite, the deletion and the append are all in place and saved', objectOf(done, N1)?.content.endsWith(' [typing] more') && objectOf(savedDoc(), N1)?.content.endsWith(' [typing] more') && objectOf(savedDoc(), boxId)?.content === 'REWRITTEN BY AGENT' && !objectOf(savedDoc(), doomed))
    // the window closes right after an agent write
    await scene(page, 'editText', N1)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' CLOSE')
    agentWrite({ append: [{ id: 'agent_node_2', content: 'second write' }] })
    await page.waitForTimeout(4500)
    await page.keyboard.type(' LAST')
    const putsBefore = puts.length
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    await waitForSave(page, putsBefore)
    const closed = savedDoc()
    check('a close right after an agent write keeps every typed word and the agent\'s block', objectOf(closed, N1)?.content.endsWith(' CLOSE LAST') && Boolean(objectOf(closed, 'agent_node_2')), objectOf(closed, N1)?.content)
    const states = await page.evaluate(() => window.__saveStates)
    check('a refused stale save is never shown as an error', !states.includes('Could not save'), JSON.stringify([...new Set(states)]))
    enforceRevision = false
    await page.waitForTimeout(600)
  }


  // ---- an agent deletes the text being typed while the typing never pauses: the text and every word survive
  {
    enforceRevision = true
    await scene(page, 'clearSelection')
    const target = (await live(page)).objects.find((o) => o.type === 'text' && o.content === 'made while typing').id
    await scene(page, 'editText', target)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.press('Control+End')
    let typed = ''
    for (let i = 0; i < 16; i += 1) { // a key every 300 ms: no pause long enough for a draft
      await page.keyboard.type(String.fromCharCode(97 + i))
      typed += String.fromCharCode(97 + i)
      if (i === 3) agentWrite({ remove: [target] })
      await page.waitForTimeout(300)
    }
    check('the editor stays open and keeps every word through an agent deletion of its text', (await editorOpen(page)) && (await editorValue(page)).endsWith(typed), String(await editorValue(page)))
    const during = objectOf(await live(page), target)
    check('the deleted text is still there, with the words typed up to the merge', during?.content.startsWith('made while typingabc'), during?.content)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1800)
    check('the text and its words are in the document and saved', objectOf(await live(page), target)?.content.endsWith(typed) && objectOf(savedDoc(), target)?.content.endsWith(typed), objectOf(savedDoc(), target)?.content)
    enforceRevision = false
  }

  // ---- the base for the next merge is not moved by a save that a merge overtook
  {
    await page.waitForTimeout(800)
    holdPutMs = 3500
    const started = putStarted
    await scene(page, 'editText', N1)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' HELD')
    await page.keyboard.press('Escape')
    for (let i = 0; i < 40 && putStarted === started; i += 1) await page.waitForTimeout(100)
    agentWrite({ append: [{ id: 'agent_node_3', content: 'while saving' }] })
    await page.waitForTimeout(5500) // the merge happens (the changes feed), then the held save lands
    holdPutMs = 0
    const base = await page.evaluate(() => window.__personalNote.leaferBase().objects.map((o) => o.id))
    check('a save that a merge overtook does not move the base back', base.includes('agent_node_3'), JSON.stringify(base.slice(-4)))
    await page.waitForTimeout(1500)
  }

  // ---- the overlay lines up with the drawn text, at three zooms, upright and turned
  const lineUp = async (id, label) => {
    const hostBox = await page.evaluate(() => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
    const box = await page.evaluate((target) => window.__personalNote.leaferCanvas().screenBox(target), id)
    const clip = { x: Math.max(0, Math.round(hostBox.x + box.x - 8)), y: Math.max(0, Math.round(hostBox.y + box.y - 8)), width: Math.min(Math.ceil(box.width + 16), 600), height: Math.min(Math.ceil(box.height + 16), 400) }
    await scene(page, 'clearSelection')
    await page.mouse.move(2, 2)
    await page.waitForTimeout(120)
    const drawn = await inkBox(page, clip)
    await scene(page, 'editText', id, { select: false })
    await page.waitForSelector('.leafer-text-editor')
    await page.evaluate(() => { document.querySelector('.leafer-text-editor').style.caretColor = 'transparent' })
    await page.waitForTimeout(120)
    const typed = await inkBox(page, clip)
    await page.screenshot({ path: `${SHOTS}/${label}.png`, clip })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    const tol = 1
    const ok = drawn.ink > 20 && ['minX', 'minY', 'maxX', 'maxY'].every((k) => near(drawn[k], typed[k], tol)) && near(drawn.ink, typed.ink, drawn.ink * 0.4)
    check(`overlay lines up with the drawn text within 1px: ${label}`, ok, JSON.stringify({ drawn, typed }))
  }
  const ids = {
    point: N1, box: boxObject.id, sticky: stickyId, multi: multi.id,
    turnedText: reloaded.objects.find((o) => o.type === 'text' && (o.geometry.rotation ?? 0) !== 0)?.id,
    turnedSticky: reloaded.objects.find((o) => o.type === 'sticky' && (o.geometry.rotation ?? 0) !== 0)?.id,
  }
  for (const zoom of [0.5, 1, 2]) {
    for (const [kind, id] of Object.entries(ids)) {
      // put the object in the middle of the view at this zoom
      await page.evaluate(([target, z]) => {
        const scene = window.__personalNote.leaferCanvas()
        const object = window.__personalNote.leaferEdits.doc.objects.find((x) => x.id === target)
        const g = object.geometry
        const r = document.querySelector('#leafer-host').getBoundingClientRect()
        scene.setView({ x: r.width / 2 - (g.x + g.width / 2) * z, y: r.height / 2 - (g.y + g.height / 2) * z, scale: z })
      }, [id, zoom])
      await page.waitForTimeout(200)
      await lineUp(id, `${kind} at ${zoom * 100}%`)
    }
  }
  await page.evaluate(() => window.__personalNote.leaferCanvas().setView({ x: 80, y: 40, scale: 1 }))
  await page.waitForTimeout(200)

  // ---- the input method: composition through the DevTools protocol
  await page.evaluate(() => {
    window.__ime = []
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) document.addEventListener(type, (event) => { if (event.target?.className === 'leafer-text-editor') window.__ime.push(`${type}:${event.data ?? event.inputType ?? ''}`) }, true)
  })
  const imeAt = await pagePoint(page, 420, 380) // (clear of the dock, which is live now)
  await page.click('[data-tool="text"]')
  before = await live(page)
  await page.mouse.click(imeAt.x, imeAt.y)
  await page.waitForSelector('.leafer-text-editor')
  for (const [text, from, to] of [['に', 1, 1], ['にほ', 2, 2], ['にほん', 3, 3]]) await cdp.send('Input.imeSetComposition', { text, selectionStart: from, selectionEnd: to })
  check('while composing, the field shows the candidate text once', (await editorValue(page)) === 'にほん', await editorValue(page))
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 }) // Enter that picks a candidate
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  check('Enter that belongs to the input method does not end the edit or break the line', (await editorOpen(page)) && !(await editorValue(page)).includes('\n'), String(await editorValue(page)))
  await cdp.send('Input.insertText', { text: '日本' }) // the chosen candidate replaces the composition
  check('the chosen candidate replaces the composition: no doubled characters', (await editorValue(page)) === '日本', await editorValue(page))
  await cdp.send('Input.imeSetComposition', { text: 'ご', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.imeSetComposition', { text: 'ごさ', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '語' })
  check('a second composition after the first appends once', (await editorValue(page)) === '日本語', await editorValue(page))
  await page.keyboard.press('Space')
  await page.keyboard.type('caf')
  await cdp.send('Input.insertText', { text: 'é' }) // an accent (dead key result)
  await page.keyboard.type(' ')
  await cdp.send('Input.insertText', { text: '😀👍🏽' }) // emoji, one with a skin tone
  check('accents and emoji arrive exactly once', (await editorValue(page)) === '日本語 café 😀👍🏽', await editorValue(page))
  const events = await page.evaluate(() => window.__ime)
  check('composition events were seen (start, updates, end)', events.includes('compositionstart:') && events.some((e) => e.startsWith('compositionupdate:')) && events.some((e) => e.startsWith('compositionend:')), JSON.stringify(events))
  await cdp.send('Input.imeSetComposition', { text: 'x', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 229 }) // Esc to cancel a candidate list
  check('Esc that belongs to the input method does not end the edit', await editorOpen(page))
  await cdp.send('Input.insertText', { text: '' })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const ime = newObjects(before, await live(page))[0]
  check('the committed words are exactly what was composed', ime?.content?.startsWith('日本語 café 😀👍🏽'), JSON.stringify(ime?.content))
  check('CJK, accents and emoji survive the save and the reload', await (async () => { await page.waitForTimeout(900); return objectOf(savedDoc(), ime.id)?.content === ime.content })())
  const imeInfo = await scene(page, 'textInfo', ime.id)
  check('Leafer draws the composed words as one line', imeInfo.rows.length === 1 && imeInfo.rows[0] === ime.content, JSON.stringify(imeInfo.rows))

  // a CJK paragraph wraps in a sticky the same way in the editor and on the canvas
  await scene(page, 'editText', stickyId)
  await page.waitForSelector('.leafer-text-editor')
  await page.keyboard.press('Control+A')
  await cdp.send('Input.insertText', { text: '日本語の文章はスペースがなくても折り返されます。これは長い文章で、何行かになるはずです。' })
  const cjkLines = await overlayLines(page)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  const cjkInfo = await scene(page, 'textInfo', stickyId)
  check('a CJK paragraph breaks into the same lines in the editor and on the canvas', JSON.stringify(cjkLines) === JSON.stringify(cjkInfo.rows.map((r) => r.replace(/\s+$/, ''))), JSON.stringify([cjkLines, cjkInfo.rows]))

  check('spellcheck is on and the field takes plain text', await (async () => { await scene(page, 'editText', N1); await page.waitForSelector('.leafer-text-editor'); const r = await page.evaluate(() => { const a = document.querySelector('.leafer-text-editor'); return [a.spellcheck, a.tagName] }); await page.keyboard.press('Escape'); return r[0] === true && r[1] === 'TEXTAREA' })())
  check('the app shortcuts do not fire while typing (T, N, V, Delete are letters there)', await (async () => {
    await scene(page, 'editText', N1); await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.press('Control+End'); await page.keyboard.type('tnv pdc'); await page.keyboard.press('Backspace')
    const v = await editorValue(page); const tool = await page.evaluate(() => window.__personalNote.state.tool)
    await page.keyboard.press('Escape'); await page.waitForTimeout(100)
    return v.endsWith('tnv pd') && tool === 'select'
  })())

  // ---- the caret goes where the double click was
  {
    await page.evaluate(() => window.__personalNote.leaferCanvas().setView({ x: 80, y: 40, scale: 1 }))
    await page.waitForTimeout(200)
    await deselect()
    const m = objectOf(await live(page), multi.id) // 'first line\nsecond line\n\nafter a blank line'
    const pitch = m.geometry.height / 4
    const caretAfterDblClick = async (px, py) => {
      const p = await pagePoint(page, px, py)
      await page.mouse.dblclick(p.x, p.y)
      await page.waitForSelector('.leafer-text-editor')
      const at = await page.evaluate(() => document.querySelector('.leafer-text-editor').selectionStart)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      await deselect()
      return at
    }
    const start2 = await caretAfterDblClick(m.geometry.x + 2, m.geometry.y + pitch * 1.5)
    check('a double click at the start of line 2 puts the caret there', start2 === 11, String(start2))
    const mid4 = await caretAfterDblClick(m.geometry.x + 80, m.geometry.y + pitch * 3.5)
    check('a double click in the middle of line 4 puts the caret inside that line', mid4 >= 24 + 3 && mid4 <= 24 + 12, String(mid4))
    const end1 = await caretAfterDblClick(m.geometry.x + m.geometry.width - 1, m.geometry.y + pitch * 0.5)
    check('a double click past the end of line 1 puts the caret at its end', end1 === 10, String(end1))
  }

  // ---- style controls act on the text just edited with the Text tool (nothing is selected then)
  {
    await page.evaluate(() => window.__personalNote.leaferCanvas().setView({ x: 80, y: -300, scale: 1 })) // the bottom of the page, clear of the dock
    await page.waitForTimeout(200)
    await page.click('[data-tool="text"]')
    const at = await pagePoint(page, 60, 700)
    const before = await live(page)
    await page.mouse.click(at.x, at.y)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.type('tool styled')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    const made = newObjects(before, await live(page))[0]
    await page.evaluate(() => document.querySelector('[data-font-family="Source Serif 4"]').click())
    check('the font buttons act on the text just made with the Text tool', objectOf(await live(page), made.id).style.fontFamily === 'Source Serif 4', JSON.stringify(objectOf(await live(page), made.id).style))
    // a real click on a swatch while that kind of text is still being typed ends the edit and styles it
    await page.click('[data-tool="text"]')
    const at2 = await pagePoint(page, 60, 760)
    const before2 = await live(page)
    await page.mouse.click(at2.x, at2.y)
    await page.waitForSelector('.leafer-text-editor')
    await page.keyboard.type('colour me')
    const color = await page.evaluate(() => document.querySelectorAll('.ink-swatch')[3].dataset.color)
    await page.locator('.ink-swatch').nth(3).click()
    await page.waitForTimeout(200)
    const made2 = newObjects(before2, await live(page))[0]
    check('a swatch clicked while typing ends the edit and colours that text', made2?.content === 'colour me' && made2.style.color === color && !(await editorOpen(page)), JSON.stringify(made2?.style))
    await page.click('[data-tool="select"]')
    await page.waitForTimeout(900)
  }

  // ---- Prettify and voice are visibly off, not silently dead
  check('Prettify and voice are live on the Leafer canvas (F-035; checked in verify-leafer-voice.mjs)', await page.evaluate(() => ['prettify', 'voice-button'].every((id) => !document.getElementById(id).disabled)))

  // ---- the editor is open and the page goes away, the window flushes, or another note is chosen
  {
    await page.waitForTimeout(900)
    await deselect()
    const typeInto = async (word) => {
      await scene(page, 'editText', N1)
      await page.waitForSelector('.leafer-text-editor')
      await page.keyboard.press('Control+End')
      await page.keyboard.type(word)
    }
    let n = puts.length
    await typeInto(' FLUSH')
    await page.evaluate(() => window.personalNote.flush())
    await waitForSave(page, n)
    check('flush() with the editor open saves the typed words', objectOf(savedDoc(), N1)?.content.endsWith(' FLUSH') && !(await editorOpen(page)), objectOf(savedDoc(), N1)?.content)
    await page.waitForTimeout(800)
    n = puts.length
    await typeInto(' HIDE')
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    await waitForSave(page, n)
    check('the page going away with the editor open saves the typed words', puts.length > n && objectOf(savedDoc(), N1)?.content.endsWith(' HIDE'), objectOf(savedDoc(), N1)?.content)
    await page.waitForTimeout(800)
    n = puts.length
    await typeInto(' SWITCH')
    holdPutMs = 1200 // the save of the note being left is still out when the other note appears
    await page.evaluate(() => window.__personalNote.selectNote(2))
    holdPutMs = 0
    await waitForSave(page, n)
    await page.waitForTimeout(500)
    check('choosing another note with the editor open saves the words into the note being left', objectOf(savedDoc(), N1)?.content.endsWith(' SWITCH') && !(await editorOpen(page)), objectOf(savedDoc(), N1)?.content)
    check('the base for merges is the note now open, not the one left', await page.evaluate(() => window.__personalNote.leaferBase().objects.length === 0))
    check('and puts nothing into the note chosen', puts2.length === 0 && (await live(page)).objects.length === 0, JSON.stringify([puts2.length, (await live(page)).objects.length]))
  }
  await page.screenshot({ path: `${SHOTS}/final.png` })
  const realErrors = errors.filter((e) => !/status of 409|revision conflict/.test(e)) // the refused stale saves of the mock server, logged by the browser and the app
  check('no page errors', realErrors.length === 0, realErrors.join(' | '))
  void stillSteps
  void TURNED_T
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
