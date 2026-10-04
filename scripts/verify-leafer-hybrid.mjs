// F-034: the hybrid render mode (the default; src/modules/canvas-leafer/tiles.js, perf.js), in the real app (Vite dev server on port 4850, mocked
// /api, proxy to a dead port, headless Chromium at devicePixelRatio 2, the software rasteriser):
//   - navigation (pan, wheel zoom) shows page bitmaps at every zoom level from the first step, and the vectors come back when it settles
//   - the settled picture is the picture a plain vector render gives (pixel check), and a bitmap at 100% is not blurry (measured, numbers printed)
//   - editing is live vectors; an edit makes only the pages it touched out of date; they are made again in idle time
//   - a drag of a crowd (more than 3 objects) is drawn at 1x on the drag layer and is sharp on drop
//   - a view too far in for crisp bitmaps does not use them; the bitmap memory stays inside the budget (printed for a 3420x2214 screen at dpr 2)
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-hybrid.mjs
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { generateStressDocument } from '../src/modules/speedtest/stress-note.js'
import { writeJsonCanvas } from '../src/core/document/jsoncanvas.js'

const PORT = 4850
const now = new Date().toISOString()
const doc = generateStressDocument(1500, { columns: 4, rows: 4 })
// one shape whose stroke keeps its screen width at every zoom (the bitmaps must not leave it at a stale width)
doc.objects.push({ id: 'uniform', type: 'shape', kind: 'rect', z: doc.objects.length, fill: '#ffffff', stroke: '#cc0000', strokeWidth: 6, strokeUniform: true, geometry: { x: 300, y: 300, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 } })
const stress = { content: writeJsonCanvas(doc, { derived: 'omit' }), pageState: { columns: doc.page.columns, rows: doc.page.rows } }
const summary = { id: 1, resourceId: 'r1', revision: 1, noteType: 'canvas', title: 'Stress', notebookId: 1, createdAt: now, updatedAt: now }
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const info = (text) => console.log(`INFO  ${text}`)

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4859' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

async function open(perf, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  if (perf) await page.addInitScript((value) => { window.__pnPerf = value }, perf)
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    if (p === '/notes') return json([summary])
    if (p === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, content: stress.content, pageState: stress.pageState })
    return json({ revision: 2, resourceId: 'r1' })
  })
  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 120000 })
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__personalNote.setTool('select'))
  return { context, page, errors }
}
const zoomTo = (page, zoom, offset) => page.evaluate(([z, at]) => {
  const { state, getCanvasScale, setCanvasViewportOffset, viewSize } = window.__personalNote
  state.canvasZoom = z === 1 ? 1 : z / state.displayScale
  const scale = getCanvasScale()
  setCanvasViewportOffset(at ? at[0] : z === 1 ? viewSize.width / 2 - 430 * scale : 24, at ? at[1] : z === 1 ? 104 : 24)
  return scale
}, [zoom, offset ?? null])
const lod = (page) => page.evaluate(() => window.__personalNote.leaferCanvas().lodState())
const stage = (page) => page.evaluate(() => window.__personalNote.leaferCanvas().leafer.children.map((node) => node.tag + (node.children ? `(${node.children.length})` : '')))
const vectorsOn = async (page) => (await stage(page)).some((entry) => /Group\(\d{3,}\)/.test(entry))
const rafs = (page, n = 2) => page.evaluate((count) => new Promise((resolve) => { let left = count; const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick) }), n)
// Until the pages on screen have their bitmaps (they are made in idle time after a settle).
const idle = async (page) => {
  await page.waitForFunction(() => { const s = window.__personalNote.leaferCanvas().lodState(); return !s.active && s.visibleReady }, null, { timeout: 90000 })
  await page.waitForTimeout(200)
}
const wheel = async (page, count, dy, x = 700, y = 450) => { await page.mouse.move(x, y); for (let i = 0; i < count; i += 1) { await page.mouse.wheel(0, dy); await rafs(page, 1) } }
const shot = (page) => page.screenshot({ clip: { x: 230, y: 100, width: 1000, height: 640 } })
const compare = (page, a, b) => page.evaluate(async ([one, two]) => {
  const read = async (data) => { const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob()); const c = new OffscreenCanvas(image.width, image.height); const x = c.getContext('2d'); x.drawImage(image, 0, 0); return x.getImageData(0, 0, image.width, image.height) }
  const [first, second] = [await read(one), await read(two)]
  let total = 0
  let strong = 0
  let any = 0
  let box = null
  for (let i = 0; i < first.data.length; i += 4) {
    const level = Math.max(Math.abs(first.data[i] - second.data[i]), Math.abs(first.data[i + 1] - second.data[i + 1]), Math.abs(first.data[i + 2] - second.data[i + 2]))
    total += level
    if (level > 0) any += 1
    if (level > 64) { strong += 1; const px = (i / 4) % first.width; const py = Math.floor(i / 4 / first.width); box = box ? [Math.min(box[0], px), Math.min(box[1], py), Math.max(box[2], px), Math.max(box[3], py)] : [px, py, px, py] }
  }
  const pixels = first.data.length / 4
  return { mean: total / pixels, strong: strong / pixels, any: any / pixels, box }
}, [a.toString('base64'), b.toString('base64')])
const MB = (bytes) => (bytes / 1048576).toFixed(1)
const PLAIN = { hybrid: false, dragCrowd: 0, gestureTransform: false, pageBitmaps: 'off' }

try {
  // ---------------------------------------------------------------- the default is the hybrid mode; navigation uses bitmaps at every zoom
  {
    const { context, page, errors } = await open(null)
    const state0 = await lod(page)
    check('the default render mode is hybrid: page bitmaps at every zoom', state0.hybrid && state0.mode === 'always', JSON.stringify(state0))
    for (const zoom of [1, 0.5]) {
      await zoomTo(page, zoom)
      await page.waitForTimeout(400)
      await idle(page)
      const rest = await lod(page)
      check(`at ${zoom * 100}% the pages on screen have bitmaps made for this zoom, at rest, with the vectors on the stage`, rest.visibleReady && !rest.active && await vectorsOn(page), JSON.stringify(rest))
      const enters = rest.enters
      await wheel(page, 1, 40)
      const first = await lod(page)
      check(`at ${zoom * 100}% the FIRST step of a pan shows the bitmaps (no vector frame first)`, first.active && first.enters === enters + 1 && !(await vectorsOn(page)), JSON.stringify(first))
      await wheel(page, 5, 40)
      await page.keyboard.down('Control')
      await wheel(page, 3, -30)
      await wheel(page, 3, 30)
      await page.keyboard.up('Control')
      await page.waitForTimeout(700)
      const after = await lod(page)
      check(`at ${zoom * 100}% the vectors are back when the movement stops`, !after.active && await vectorsOn(page), JSON.stringify(after))
    }
    check('page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // ---------------------------------------------------------------- the settled view is a plain vector render; a bitmap at 100% is crisp
  {
    const run = async (perf) => {
      const { context, page, errors } = await open(perf)
      await zoomTo(page, 1)
      await page.waitForTimeout(500)
      if (!perf) await idle(page)
      await wheel(page, 8, 40, 250, 130)
      await wheel(page, 8, -40, 250, 130)
      await page.keyboard.down('Control')
      await wheel(page, 4, -30, 250, 130)
      await wheel(page, 4, 30, 250, 130)
      await page.keyboard.up('Control')
      await page.waitForTimeout(900)
      await page.mouse.move(5, 5) // (the pointer's hover outline is not part of the note: not under it for the picture)
      await page.waitForTimeout(200)
      const settled = await shot(page)
      info(`stroke after the gestures (${perf ? 'plain' : 'hybrid'}): ${JSON.stringify(await page.evaluate(() => ({ scale: window.__personalNote.leaferCanvas().view().scale, width: window.__personalNote.leaferCanvas().nodeInfo('uniform').strokeWidth, lod: window.__personalNote.leaferCanvas().lodState().active })))}`)
      return { context, page, errors, settled }
    }
    const hybrid = await run(null)
    const plain = await run(PLAIN)
    if (process.env.HYB_SHOTS) { (await import('node:fs')).writeFileSync(`${process.env.HYB_SHOTS}/hybrid.png`, hybrid.settled); (await import('node:fs')).writeFileSync(`${process.env.HYB_SHOTS}/plain.png`, plain.settled) }
    const same = await compare(hybrid.page, hybrid.settled, plain.settled)
    info(`settled hybrid view vs plain vector render (100%, after a pan and a zoom out and in): mean ${same.mean.toFixed(4)} of 255, ${(same.strong * 100).toFixed(3)}% far off, ${(same.any * 100).toFixed(3)}% differ at all`)
    check('after a pan and a zoom, the settled hybrid view equals a plain vector render (under 25 pixels of 2.5 million far off, mean under 0.05 of 255)', same.strong < 1e-5 && same.mean < 0.05, JSON.stringify(same))
    check('(and the vectors are what is on the stage)', await vectorsOn(hybrid.page))
    await plain.context.close()

    // a bitmap against the vector render of the same view, at 100%, on a whole-pixel offset (the best case) and a half-pixel one (the worst)
    const { page } = hybrid
    for (const [label, shift] of [['whole-pixel offset', 0], ['half-pixel offset', 0.25]]) {
      await zoomTo(page, 1, [150, 104])
      await page.waitForTimeout(500)
      await idle(page)
      if (shift) { // a view that is not on a device pixel: the bitmaps are resampled, the vectors are not
        await page.evaluate((by) => { const s = window.__personalNote.leaferCanvas(); const v = s.view(); s.setView({ ...v, x: v.x + by, y: v.y + by }) }, shift)
        await page.waitForTimeout(700)
      }
      const vector = await shot(page)
      // a view change that does not move the picture puts the bitmaps on the stage; the screenshot is taken before the quiet wait ends
      await page.evaluate(() => { const s = window.__personalNote.leaferCanvas(); s.setView({ ...s.view() }) })
      const showing = await page.evaluate(() => window.__personalNote.leaferCanvas().lodState().active)
      const bitmap = await shot(page)
      const d = await compare(page, vector, bitmap)
      info(`100% bitmap (showing: ${showing}) vs vector, ${label}: mean ${d.mean.toFixed(3)} of 255, ${(d.strong * 100).toFixed(3)}% of pixels far off, ${(d.any * 100).toFixed(1)}% differ at all`)
      check(`a bitmap at 100% is not blurry against the vector render (${label}: mean under ${label.startsWith('whole') ? 1 : 4} of 255, under ${label.startsWith('whole') ? 0.5 : 2.5}% of pixels far off)`, showing && d.mean < (label.startsWith('whole') ? 1 : 4) && d.strong < (label.startsWith('whole') ? 0.005 : 0.025), JSON.stringify(d))
    }
    check('page errors', hybrid.errors.length === 0 && plain.errors.length === 0, hybrid.errors.join(' | '))
    await hybrid.context.close()
  }

  // ---------------------------------------------------------------- editing is live; an edit makes only the pages it touched out of date
  {
    const { context, page, errors } = await open(null)
    await zoomTo(page, 0.3)
    await page.waitForTimeout(500)
    await page.evaluate(() => window.__personalNote.leaferCanvas().lodBuildAll())
    const full = await lod(page)
    check('(setup) every page of the 4 x 4 note has a current bitmap', full.tiles === 16 && full.current === 16, JSON.stringify(full))
    // an object that sits wholly inside one page, away from its edges
    const target = await page.evaluate(() => {
      const { leaferEdits } = window.__personalNote
      return leaferEdits.doc.objects.filter((o) => o.type === 'sticky').map((o) => ({ id: o.id, x: o.geometry.x, y: o.geometry.y, w: o.geometry.width, h: o.geometry.height })).find((o) => o.x % 860 > 120 && o.x % 860 < 600 && o.y % 1080 > 120 && o.y % 1080 < 800)
    })
    check('(setup) a sticky well inside one page', Boolean(target))
    await page.evaluate((id) => { const s = window.__personalNote.leaferCanvas(); s.select([id]); s.nudge(30, 20) }, target.id)
    const afterEdit = await lod(page)
    check('an edit makes only the bitmap of the page it touched out of date (15 of 16 stay current)', afterEdit.current === 15, JSON.stringify(afterEdit))
    await wheel(page, 3, 30)
    await page.waitForFunction(() => { const s = window.__personalNote.leaferCanvas().lodState(); const g = window.__personalNote.leaferEdits.doc.page; return s.current === s.tiles && s.tiles === g.columns * g.rows }, null, { timeout: 30000 }).catch(() => {})
    const rebuilt = await lod(page)
    const grid = await page.evaluate(() => window.__personalNote.leaferEdits.doc.page)
    check('the touched page is made again in idle time (every bitmap of the grid is current again)', rebuilt.current === rebuilt.tiles && rebuilt.tiles === grid.columns * grid.rows, JSON.stringify([rebuilt, grid]))
    check('page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }
  // ---------------------------------------------------------------- a crowd dragged: 1x on the drag layer while it moves, sharp on drop
  {
    const { context, page, errors } = await open(null)
    await zoomTo(page, 1)
    await page.waitForTimeout(500)
    await idle(page)
    const picked = await page.evaluate(() => {
      const { leaferCanvas, leaferEdits } = window.__personalNote
      const host = document.querySelector('#leafer-host').getBoundingClientRect()
      const v = leaferCanvas().view()
      const onScreen = leaferEdits.doc.objects.filter((o) => o.type === 'sticky').map((o) => ({ id: o.id, x: host.left + v.x + (o.geometry.x + o.geometry.width / 2) * v.scale, y: host.top + v.y + (o.geometry.y + o.geometry.height / 2) * v.scale, gx: o.geometry.x, gy: o.geometry.y })).filter((p) => p.x > host.left + 150 && p.x < host.left + host.width - 200 && p.y > host.top + 100 && p.y < host.top + host.height - 150)
      return onScreen.slice(0, 6)
    })
    check('(setup) six stickies on screen', picked.length === 6, String(picked.length))
    await page.evaluate((ids) => window.__personalNote.leaferCanvas().select(ids), picked.map((p) => p.id))
    const rest = await page.evaluate(() => window.__personalNote.leaferCanvas().gestureState())
    check('at rest the drag layer is drawn at the screen\'s own resolution (2x)', rest.skyPixelRatio === 2 && rest.treePixelRatio === 2, JSON.stringify([rest.skyPixelRatio, rest.treePixelRatio]))
    const from = picked[0]
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= 6; i += 1) { await page.mouse.move(from.x + i * 12, from.y + i * 8); await rafs(page, 1) }
    const during = await page.evaluate(() => window.__personalNote.leaferCanvas().gestureState())
    check('while six objects are dragged the drag layer is drawn at 1x (and the note at 2x)', during.skyPixelRatio === 1 && during.treePixelRatio === 2, JSON.stringify([during.skyPixelRatio, during.treePixelRatio]))
    await page.mouse.up()
    await page.waitForTimeout(500)
    const dropped = await page.evaluate(() => window.__personalNote.leaferCanvas().gestureState())
    check('on drop the drag layer is back at 2x', dropped.skyPixelRatio === 2, String(dropped.skyPixelRatio))
    const moved = await page.evaluate((ids) => window.__personalNote.leaferEdits.doc.objects.filter((o) => ids.includes(o.id)).map((o) => [o.geometry.x, o.geometry.y]), picked.map((p) => p.id))
    check('and the six moved together by the drag (one step)', moved.every(([x, y], i) => Math.abs(x - picked[i].gx - 72) < 3 && Math.abs(y - picked[i].gy - 48) < 3), JSON.stringify([moved, picked.map((p) => [p.gx, p.gy])]))
    // one object: no change of resolution
    await page.evaluate((id) => window.__personalNote.leaferCanvas().select([id]), picked[0].id)
    const one = await page.evaluate(() => { const v = window.__personalNote.leaferCanvas().view(); const o = window.__personalNote.leaferEdits.doc.objects.find((x) => x.type === 'sticky'); return { x: o.geometry.x, y: o.geometry.y, v } })
    check('page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // ---------------------------------------------------------------- zoomed far in, the bitmaps cannot be crisp: the vectors carry the view; memory
  {
    const { context, page, errors } = await open(null)
    await zoomTo(page, 4)
    await page.waitForTimeout(500)
    const s0 = await lod(page)
    check('zoomed in to 400% the bitmaps cannot be made crisp inside the budget, so a pan does not use them', s0.crisp === false, JSON.stringify(s0))
    await wheel(page, 4, 40)
    const s1 = await lod(page)
    check('and the pan is drawn as vectors (no bitmap on the stage)', !s1.active && await vectorsOn(page), JSON.stringify(s1))
    check('page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }
  {
    // the Mac screen of the comparison: 3420 x 2214 device pixels at dpr 2 = 1710 x 1107 CSS pixels; the budget is 128 MB for the note
    const { context, page, errors } = await open(null, { width: 1710, height: 1107 })
    for (const zoom of [0.25, 0.5, 1, 1.5]) {
      await zoomTo(page, zoom)
      await page.waitForTimeout(500)
      await page.waitForFunction(() => { const s = window.__personalNote.leaferCanvas().lodState(); return !s.crisp || (!s.active && s.visibleReady) }, null, { timeout: 90000 }).catch(() => {})
      await page.waitForTimeout(2500) // the rest of the pages, in idle time
      const s = await lod(page)
      info(`3420x2214 at dpr 2, ${zoom * 100}% zoom: ${s.tiles} bitmaps, ${MB(s.bytes)} MB (budget 128 MB), scales on screen / near / far ${s.scales?.map((x) => x.toFixed(2)).join(' / ')}, crisp ${s.crisp}`)
      check(`bitmap memory at ${zoom * 100}% is inside the 128 MB budget`, s.bytes <= 128 * 1048576 * 1.1, MB(s.bytes))
    }
    check('page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // ---------------------------------------------------------------- a bitmap is never stale: after each kind of edit, the next pan shows the edited note
  {
    // The bitmaps are held on screen (a long quiet wait) so the picture of the pan can be set against the vector picture of the same view.
    const { context, page, errors } = await open({ lodQuiet: 60000 })
    await zoomTo(page, 0.5)
    await page.waitForTimeout(500)
    const scene = (fn, arg) => page.evaluate(([code, a]) => new Function('scene', 'edits', 'arg', `return (${code})(scene, edits, arg)`)(window.__personalNote.leaferCanvas(), window.__personalNote.leaferEdits, a), [fn.toString(), arg])
    const stickies = await page.evaluate(() => window.__personalNote.leaferEdits.doc.objects.filter((o) => o.type === 'sticky').map((o) => ({ id: o.id, x: o.geometry.x, y: o.geometry.y })))
    const near = stickies.find((o) => o.x % 860 > 560 && o.x % 860 < 620 && o.y % 1080 > 200 && o.y % 1080 < 800) ?? stickies[5]
    const rebuildAll = () => scene((s) => s.lodBuildAll())
    // the picture of a pan right after an edit (bitmaps if they may show, else vectors) against the vector picture of the same view
    const panVersusVectors = async (label) => {
      await wheel(page, 3, 30)
      const panned = await shot(page)
      const state = await lod(page)
      await scene((s) => s.lodExit())
      await rafs(page, 3)
      const vector = await shot(page)
      const d = await compare(page, panned, vector)
      return { d, state }
    }
    await rebuildAll()
    const control = await panVersusVectors('control')
    info(`control (no edit): the pan shows bitmaps ${control.state.active}, mean ${control.d.mean.toFixed(3)}, ${(control.d.strong * 100).toFixed(3)}% far off`)
    const tolerance = (d) => d.mean <= control.d.mean + 0.5 && d.strong <= control.d.strong + 0.0015
    const scenario = async (name, action) => {
      await rebuildAll()
      await action()
      const { d, state } = await panVersusVectors(name)
      info(`${name}: pan right after it ${state.active ? 'shows bitmaps' : 'shows vectors'}, mean ${d.mean.toFixed(3)}, ${(d.strong * 100).toFixed(3)}% far off`)
      check(`${name}: the next pan matches the vector render (a stale bitmap would show the old note)`, tolerance(d), JSON.stringify([d, control.d]))
      return state
    }
    await scenario('a move across a page boundary', () => scene((s, e, a) => { s.select([a.id]); s.nudge(300, 160) }, near))
    await scenario('undo of it', () => scene((s, e) => e.undo()))
    await scenario('redo of it', () => scene((s, e) => e.redo()))
    await scenario('an agent merge', () => scene((s, e) => {
      const document = e.doc
      const target = document.objects.filter((o) => o.type === 'sticky')[3]
      s.applyMerged({ ...document, objects: document.objects.map((o) => (o.id === target.id ? { ...o, geometry: { ...o.geometry, x: o.geometry.x + 500, y: o.geometry.y + 260 } } : o)) })
    }))
    await scenario('a page added on the top and left (every object shifts)', () => scene((s, e, a) => { s.select([a.id]); s.nudge(-a.x - 500, -a.y - 400) }, near))
    // typing past the bottom edge of the last page row grows the grid
    await scenario('typing that grows the page grid across an edge', async () => {
      const grid = await page.evaluate(() => window.__personalNote.leaferEdits.doc.page)
      const lowest = await page.evaluate(() => { const texts = window.__personalNote.leaferEdits.doc.objects.filter((o) => o.type === 'text' && o.mode === 'box'); return texts.sort((a, b) => b.geometry.y - a.geometry.y)[0]?.id })
      await scene((s, e, id) => s.editText(id), lowest)
      await page.waitForSelector('.leafer-text-editor', { timeout: 10000 })
      await page.keyboard.press('Control+End')
      for (let i = 0; i < 40; i += 1) await page.keyboard.type('line of words\n')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      const after = await page.evaluate(() => window.__personalNote.leaferEdits.doc.page)
      info(`typing: the grid went from ${grid.columns} x ${grid.rows} to ${after.columns} x ${after.rows}`)
    })
    check('page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // ---------------------------------------------------------------- the failure path and the uniform stroke, under the hybrid default
  {
    const { context, page, errors } = await open(null)
    await zoomTo(page, 0.5)
    await page.waitForTimeout(500)
    await idle(page)
    await wheel(page, 4, 30)
    await page.keyboard.down('Control')
    await wheel(page, 6, -30)
    await wheel(page, 6, 30)
    await page.keyboard.up('Control')
    await page.waitForTimeout(900)
    const stroke = await page.evaluate(() => ({ scale: window.__personalNote.leaferCanvas().view().scale, width: window.__personalNote.leaferCanvas().nodeInfo('uniform').strokeWidth, active: window.__personalNote.leaferCanvas().lodState().active }))
    check('hybrid: after navigating through the bitmaps a stroke that keeps its screen width has the width of the zoom it ends at', !stroke.active && Math.abs(stroke.width - 6 * stroke.scale) < 1e-6, JSON.stringify(stroke))
    await page.evaluate(() => { const s = window.__personalNote.leaferCanvas(); const v = s.view(); s.setView({ ...v, scale: v.scale * 1.3 }) })
    await page.waitForTimeout(700)
    const stroke2 = await page.evaluate(() => ({ scale: window.__personalNote.leaferCanvas().view().scale, width: window.__personalNote.leaferCanvas().nodeInfo('uniform').strokeWidth }))
    check('and after a zoom step too', Math.abs(stroke2.width - 6 * stroke2.scale) < 1e-6, JSON.stringify(stroke2))
    // a failure inside the engine turns the bitmaps off for good and leaves the vectors
    await page.evaluate(() => { const world = window.__personalNote.leaferCanvas().leafer.children[1]; const real = world.__render.bind(world); world.__render = (canvas, options) => { if (options?.bounds) throw new Error('engine said no'); return real(canvas, options) } })
    await page.evaluate(() => window.__personalNote.leaferCanvas().lodBuildAll())
    const failed = await lod(page)
    check('hybrid: a bitmap that cannot be made turns the bitmaps off, with no error shown, and the vectors carry on', failed.mode === 'off' && !failed.active && failed.tiles === 0 && errors.length === 0 && await vectorsOn(page), JSON.stringify([failed, errors]))
    await wheel(page, 3, 30)
    check('and a pan afterwards is vectors, not a blank', !(await lod(page)).active && await vectorsOn(page))
    await context.close()
  }

  // ---------------------------------------------------------------- the longest synchronous stretch of making a page, on the 1,500-object note (the speed test report gives the 5,400-object numbers)
  {
    const { context, page } = await open(null)
    await page.evaluate(() => window.__personalNote.leaferCanvas().lodExit())
    await zoomTo(page, 1)
    await page.waitForTimeout(500)
    await idle(page)
    const s = await lod(page)
    info(`page bitmaps: ${s.builds} made, worst whole page ${s.maxBuildMs.toFixed(0)} ms, worst single synchronous band ${s.maxBandMs.toFixed(0)} ms, ${MB(s.bytes)} MB`)
    check('no single synchronous stretch of making a page is longer than a quarter-page band (under 120 ms here on 1,500 objects)', s.maxBandMs < 120, JSON.stringify(s))
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
