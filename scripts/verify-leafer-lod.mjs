// F-034: the page bitmaps (src/modules/canvas-leafer/tiles.js), in the real app (Vite dev server on port 4805, mocked in-memory /api, headless Chromium,
// the software rasteriser, devicePixelRatio 1):
//   - below 60% a pan or zoom shows the page bitmaps and puts the vector objects down; the picture is close to the vector picture (a measured tolerance)
//   - the vectors come back by themselves when the movement stops, and at once when the note is touched (and the touch picks what is under it)
//   - an edit makes every bitmap out of date, and a bitmap is never shown out of date
//   - at 60% and above (and with the bitmaps off) nothing changes: the picture is pixel-identical
//   - only the pages on screen are on the stage while the bitmaps show
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-lod.mjs
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { generateStressNote } from '../src/modules/speedtest/stress-note.js'

const now = new Date().toISOString()
const stress = generateStressNote(1500, { columns: 4, rows: 4 })
const summary = { id: 1, resourceId: 'r1', revision: 1, noteType: 'canvas', title: 'Stress', notebookId: 1, createdAt: now, updatedAt: now }
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

const server = await createServer({ server: { port: 4805, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4809' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

async function open(perf) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript((value) => { window.__pnPerf = value }, perf)
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    if (p === '/notes') return json([summary])
    if (p === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, content: stress.content, pageState: stress.pageState })
    return json({ revision: 2, resourceId: 'r1' })
  })
  await page.goto('http://127.0.0.1:4805/notes')
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 120000 })
  await page.waitForTimeout(1500)
  return { context, page, errors }
}
const zoomTo = (page, zoom) => page.evaluate((z) => {
  const { state, getCanvasScale, setCanvasViewportOffset, canvas } = window.__personalNote
  state.canvasZoom = z === 1 ? 1 : z / state.displayScale
  setCanvasViewportOffset(z === 1 ? canvas.getWidth() / 2 - 430 * getCanvasScale() : 24, z === 1 ? 104 : 24)
  return getCanvasScale()
}, zoom)
const lod = (page) => page.evaluate(() => window.__personalNote.leaferCanvas().lodState())
const stage = (page) => page.evaluate(() => window.__personalNote.leaferCanvas().leafer.children.map((node) => node.tag + (node.children ? `(${node.children.length})` : '')))
const hostShot = (page) => page.screenshot({ clip: await_clip })
let await_clip = null
const shot = async (page) => {
  const rect = await page.evaluate(() => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } })
  return page.screenshot({ clip: { x: rect.x + 230, y: rect.y + 100, width: Math.min(rect.width - 330, 1000), height: Math.min(rect.height - 220, 560) } })
}
const compare = (page, a, b) => page.evaluate(async ([one, two]) => {
  const read = async (data) => { const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob()); const c = new OffscreenCanvas(image.width, image.height); const x = c.getContext('2d'); x.drawImage(image, 0, 0); return x.getImageData(0, 0, image.width, image.height) }
  const [first, second] = [await read(one), await read(two)]
  let total = 0
  let strong = 0
  let any = 0
  for (let i = 0; i < first.data.length; i += 4) {
    const level = Math.max(Math.abs(first.data[i] - second.data[i]), Math.abs(first.data[i + 1] - second.data[i + 1]), Math.abs(first.data[i + 2] - second.data[i + 2]))
    total += level
    if (level > 0) any += 1
    if (level > 64) strong += 1
  }
  const pixels = first.data.length / 4
  return { mean: total / pixels, strong: strong / pixels, any: any / pixels }
}, [a.toString('base64'), b.toString('base64')])
const wheel = async (page, count, dy) => { await page.mouse.move(800, 450); for (let i = 0; i < count; i += 1) { await page.mouse.wheel(0, dy); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) } }

try {
  // ---------------------------------------------------------------- bitmaps on: always, held up for the pictures
  {
    const { context, page, errors } = await open({ pageBitmaps: 'always', lodQuiet: 60000 })
    const scale = await zoomTo(page, 0.3)
    await page.waitForTimeout(800)
    check('the note is zoomed out to 30%', Math.abs(scale - 0.3) < 0.01, String(scale))
    await page.evaluate(() => window.__personalNote.leaferCanvas().lodBuildAll())
    const state0 = await lod(page)
    check('every page has a bitmap and none is on the stage yet', state0.tiles === 16 && state0.current === 16 && !state0.active, JSON.stringify(state0))
    const vector = await shot(page)
    const stageVector = await stage(page)
    check('at rest the stage holds the vector objects', stageVector.some((entry) => /Group\(\d{3,}\)/.test(entry)), JSON.stringify(stageVector))

    // a pan down and back: net zero, so the same view as the vector picture, with the bitmaps showing
    await wheel(page, 6, 40)
    const moving = await lod(page)
    check('a pan below 60% puts the bitmaps on the stage', moving.active && moving.enters === 1, JSON.stringify(moving))
    const stageBitmap = await stage(page)
    check('and takes the vector objects off it', !stageBitmap.some((entry) => /Group\(\d{3,}\)/.test(entry)), JSON.stringify(stageBitmap))
    await wheel(page, 6, -40)
    const bitmap = await shot(page)
    const same = await compare(page, vector, bitmap)
    console.log(`INFO  bitmap picture vs vector picture at 30%: mean difference ${same.mean.toFixed(2)} of 255, ${(same.strong * 100).toFixed(2)}% of pixels differ by more than 64 levels, ${(same.any * 100).toFixed(1)}% differ at all`)
    check('the bitmap picture is close to the vector picture (measured tolerance: mean under 9 of 255, under 3% of pixels far off: this note is a dense stress note)', same.mean < 9 && same.strong < 0.03, JSON.stringify(same))

    // cull: only the pages on screen are on the stage
    const staged = await page.evaluate(() => { const layer = window.__personalNote.leaferCanvas().leafer.children[1]; return layer.children.length })
    check('only the pages that are on screen are on the stage (of 16)', staged > 0 && staged < 16, String(staged))

    // a touch of the note brings the vectors back and picks what is under it
    const target = await page.evaluate(() => {
      const { leaferCanvas, leaferEdits } = window.__personalNote
      const host = document.querySelector('#leafer-host').getBoundingClientRect()
      const v = leaferCanvas().view()
      const sticky = leaferEdits.doc.objects.filter((o) => o.type === 'sticky').map((o) => ({ id: o.id, x: host.left + v.x + (o.geometry.x + o.geometry.width / 2) * v.scale, y: host.top + v.y + (o.geometry.y + o.geometry.height / 2) * v.scale })).find((p) => p.x > 500 && p.x < 1100 && p.y > 200 && p.y < 650)
      return sticky
    })
    check('(setup) a sticky is on screen', Boolean(target))
    await page.mouse.click(target.x, target.y)
    await page.waitForTimeout(300)
    const touched = await lod(page)
    const picked = await page.evaluate(() => window.__personalNote.leaferCanvas().selection())
    check('a touch puts the vectors back at once', !touched.active && (await stage(page)).some((entry) => /Group\(\d{3,}\)/.test(entry)), JSON.stringify([touched, await stage(page)]))
    check('and the touch picks what is under it', picked.length === 1, JSON.stringify(picked))

    // an edit makes every bitmap out of date, and an out-of-date bitmap is never shown
    await page.evaluate(() => window.__personalNote.leaferCanvas().nudge(60, 40))
    const afterEdit = await lod(page)
    check('an edit makes the bitmaps out of date', afterEdit.current === 0, JSON.stringify(afterEdit))
    await page.evaluate(() => window.__personalNote.leaferCanvas().clearSelection())
    await wheel(page, 4, 40)
    const notShown = await lod(page)
    check('a pan right after the edit does not show them', !notShown.active, JSON.stringify(notShown))
    await wheel(page, 4, -40)
    await page.evaluate(() => window.__personalNote.leaferCanvas().lodBuildAll())
    const fresh = await shot(page)
    await wheel(page, 4, 40)
    await wheel(page, 4, -40)
    const showing = await lod(page)
    check('once they are made again they show again', showing.active, JSON.stringify(showing))
    const freshBitmap = await shot(page)
    if (process.env.LOD_SHOTS) { fs.writeFileSync(`${process.env.LOD_SHOTS}/vector.png`, vector); fs.writeFileSync(`${process.env.LOD_SHOTS}/bitmap.png`, bitmap); fs.writeFileSync(`${process.env.LOD_SHOTS}/fresh.png`, fresh); fs.writeFileSync(`${process.env.LOD_SHOTS}/fresh-bitmap.png`, freshBitmap) }
    const sameAgain = await compare(page, fresh, freshBitmap)
    check('and show the note as it is now (the moved sticky is where it is)', sameAgain.mean < 9 && sameAgain.strong < 0.03, JSON.stringify(sameAgain))
    check('page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // ---------------------------------------------------------------- by itself: the vectors come back when the movement stops
  {
    const { context, page, errors } = await open({ pageBitmaps: 'always', lodQuiet: 250 })
    await zoomTo(page, 0.3)
    await page.waitForTimeout(500)
    await page.evaluate(() => window.__personalNote.leaferCanvas().lodBuildAll())
    await wheel(page, 6, 40)
    const during = await lod(page)
    await page.waitForTimeout(700)
    const after = await lod(page)
    check('the bitmaps go by themselves when the movement stops', during.active && !after.active && (await stage(page)).some((entry) => /Group\(\d{3,}\)/.test(entry)), JSON.stringify([during, after]))
    check('page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // ---------------------------------------------------------------- at 60% and above: the same pixels, with the bitmaps on or off
  {
    const shots = []
    for (const perf of [{ pageBitmaps: 'off' }, { pageBitmaps: 'always' }]) {
      const { context, page, errors } = await open(perf)
      await zoomTo(page, 1)
      await page.waitForTimeout(600)
      await wheel(page, 5, 30)
      await wheel(page, 5, -30)
      await page.waitForTimeout(500)
      shots.push({ image: await shot(page), used: (await lod(page)).enters, errors })
      await context.close()
    }
    const same = await compare(await browser.newContext().then((c) => c.newPage()), shots[0].image, shots[1].image)
    check('at 100% a pan never uses the bitmaps', shots[1].used === 0, String(shots[1].used))
    check('and the picture is pixel-identical with the bitmaps on or off', same.any === 0, JSON.stringify(same))
    check('page errors', shots.every((entry) => entry.errors.length === 0))
  }
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
