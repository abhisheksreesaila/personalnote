// F-027 one-time visual reference: draws the same notes with today's Fabric render (the app as it was before Leafer, from a
// separate checkout) and with this checkout's Leafer render, in headless Chromium in the three skins, and compares screenshots of
// the canvas area. Not a regression gate: Fabric goes away in F-036.
//
//   mkdir <dir>; (cd <repo> && git archive <commit-before-F-027>) | tar -x -C <dir>; ln -s <repo>/node_modules <dir>/node_modules
//   node scripts/verify-leafer-parity.mjs --reference=<dir> [--out=<dir>] [--dpr=1] [--fixtures=app-text,edge-transforms]
//
// Both apps run from Vite dev servers on ports 4521 and 4522 (this Vite ignores port 0 and falls back to 5173, the captain's) with the /api mocked in memory (nothing touches a database, no real port).
// Each pair is measured two ways, because text anti-aliasing differs between the engines and a plain pixel diff would hide a
// misplaced object under the noise:
//   differing%   share of pixels whose largest channel differs by more than 40/255 (glyph edges, shadow banding)
//   within1px%   the same share when the Leafer picture may sit up to a pixel off in x and y (best of nine offsets)
//   blockMax     the worst 24x24-pixel block's mean absolute difference (0-255): catches a moved, missing or recoloured object
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { COLUMNS, ROWS, generateNote } from './benchmark-note.mjs'
import { fromFabric } from '../src/core/document/index.js'
import { placedPoints } from '../src/core/document/placement.js'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, value = 'true'] = arg.replace(/^--/, '').split('='); return [key, value] }))
const outDir = args.out || path.join(os.tmpdir(), 'leafer-parity')
const dprs = (args.dpr || '1,2').split(',').map(Number)
let dpr = 1 // set by the loop below
if (!args.reference) { console.error('--reference=<checkout of the Fabric-only app> is required'); process.exit(2) }
fs.mkdirSync(outDir, { recursive: true })

const fixtureDir = new URL('../tests/fixtures/documents/', import.meta.url)
const load = (name) => JSON.parse(fs.readFileSync(new URL(`${name}.json`, fixtureDir), 'utf8'))
const fixtures = {
  'app-all-tools': load('app-all-tools'),
  'app-objects': load('app-objects'),
  'app-text': load('app-text'),
  'edge-transforms': load('edge-transforms'),
  'benchmark-600': { name: 'benchmark-600', content: generateNote(), pageState: { columns: COLUMNS, rows: ROWS } },
}
const names = args.fixtures ? args.fixtures.split(',') : Object.keys(fixtures)
const skins = ['crayon', 'paper', 'night']
const views = ['open', 'actual']

const now = new Date().toISOString()
const notebooks = [{ id: 1, resourceId: 'res_nb', revision: 1, name: 'Parity', color: '#76669a', noteCount: 1 }]

async function mockApi(page, fixture) {
  const summary = { id: 1, resourceId: 'res_parity', revision: 1, noteType: 'canvas', title: fixture.name, notebookId: 1, createdAt: now, updatedAt: now }
  await page.route('**/api/**', async (route) => {
    const apiPath = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (apiPath === '/notebooks') return json(notebooks)
    if (apiPath === '/notes') return json([summary])
    if (apiPath === '/notes/1' && route.request().method() === 'GET') return json({ ...summary, content: fixture.content, pageState: fixture.pageState })
    return json({})
  })
}

const HIDE_CHROME = '.tool-dock, .page-minimap, .zoom-control, .topbar, .sidebar, .properties-panel, .engine-pill, .speed-meter, #scroll-x, #scroll-y, #toast, .save-state, .agent-chip { visibility: hidden !important; }'

// engine: 'fabric' is the reference checkout, 'leafer' is this one. A fresh browser per render, retried: headless Chromium
// now and then loses a page while two full-window canvases are alive.
async function render(_unused, baseUrl, fixture, skin, engine) {
  for (let attempt = 1; ; attempt += 1) {
    const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
    try {
      return await renderOnce(browser, baseUrl, fixture, skin, engine)
    } catch (error) {
      if (attempt >= 3) throw error
      console.error(`${fixture.name}/${skin}/${engine}: attempt ${attempt} failed (${error.message.split('\n')[0]}), retrying`)
    } finally {
      await browser.close().catch(() => {})
    }
  }
}

async function renderOnce(browser, baseUrl, fixture, skin, engine) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr })
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`))
  page.on('console', (message) => { if (message.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(message.text())) problems.push(`console error: ${message.text()}`) })
  await page.addInitScript((s) => localStorage.setItem('personal-note:skin', s), skin)
  await mockApi(page, fixture)
  await page.goto(new URL('notes', baseUrl).href)
  if (engine === 'leafer') await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 30000 })
  else await page.waitForFunction(() => window.__personalNote?.canvas.getObjects().length > 0, null, { timeout: 30000 })
  await page.addStyleTag({ content: HIDE_CHROME })
  await page.waitForTimeout(900)
  const shots = {}
  const opening = await page.evaluate(() => {
    const { state, getCanvasScale } = window.__personalNote
    return { zoom: getCanvasScale(), pages: `${state.pages.columns}x${state.pages.rows}` }
  })
  for (const view of views) {
    if (view === 'actual') {
      await page.evaluate(() => {
        const { canvas, state, setCanvasViewportOffset } = window.__personalNote
        state.canvasZoom = 1
        setCanvasViewportOffset((canvas.getWidth() - 860) / 2, 104)
      })
      if (engine === 'leafer') await page.evaluate(() => window.__personalNote.leaferCanvas().whenSettled())
      await page.waitForTimeout(500)
    }
    shots[view] = await page.locator('#workspace').screenshot()
  }
  // What the Fabric app holds once it has opened the note (it grows and shifts the page grid on open, as it always has): the Leafer
  // side is given this, so both draw the same note.
  const leaferInfo = engine === 'leafer' ? await page.evaluate(() => ({ stats: window.__personalNote.leaferCanvas().stats(), boxes: window.__personalNote.leaferCanvas().boxes().map((b) => ({ ...b })) })) : null
  const normalized = engine === 'fabric' ? await page.evaluate(() => ({ content: window.__personalNote.canvas.toJSON(), pageState: { ...window.__personalNote.state.pages } })) : null
  await context.close()
  return { shots, problems, opening, normalized, leaferInfo }
}

// Compares two PNGs in the browser (no image library needed).
async function compare(comparePage, a, b) {
  return comparePage.evaluate(async ([aBase64, bBase64]) => {
    const decode = async (base64) => {
      const image = new Image()
      image.src = `data:image/png;base64,${base64}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(image, 0, 0)
      return ctx.getImageData(0, 0, image.width, image.height)
    }
    const [one, two] = await Promise.all([decode(aBase64), decode(bBase64)])
    if (one.width !== two.width || one.height !== two.height) return { error: `size ${one.width}x${one.height} vs ${two.width}x${two.height}` }
    const { width, height } = one
    const out = new ImageData(width, height)
    let differing = 0
    const BLOCK = 12
    const blocksX = Math.ceil(width / BLOCK)
    const blocks = new Float64Array(blocksX * Math.ceil(height / BLOCK))
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4
        const dr = Math.abs(one.data[i] - two.data[i])
        const dg = Math.abs(one.data[i + 1] - two.data[i + 1])
        const db = Math.abs(one.data[i + 2] - two.data[i + 2])
        blocks[Math.floor(y / BLOCK) * blocksX + Math.floor(x / BLOCK)] += (dr + dg + db) / 3 / (BLOCK * BLOCK)
        if (Math.max(dr, dg, db) > 40) {
          differing += 1
          out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 60; out.data[i + 3] = 255
        } else {
          out.data[i] = one.data[i]; out.data[i + 1] = one.data[i + 1]; out.data[i + 2] = one.data[i + 2]; out.data[i + 3] = 90
        }
      }
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d').putImageData(out, 0, 0)
    // The same share, but allowing the Leafer picture to sit up to one pixel off in x and y (text can land a pixel apart when the
    // two engines round a glyph position differently): the lowest of the nine.
    let best = Infinity
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        let count = 0
        for (let y = 1; y < height - 1; y += 1) {
          for (let x = 1; x < width - 1; x += 1) {
            const i = (y * width + x) * 4
            const j = ((y + oy) * width + (x + ox)) * 4
            if (Math.max(Math.abs(one.data[i] - two.data[j]), Math.abs(one.data[i + 1] - two.data[j + 1]), Math.abs(one.data[i + 2] - two.data[j + 2])) > 40) count += 1
          }
        }
        best = Math.min(best, count)
      }
    }
    return { differingPct: (differing / (width * height)) * 100, within1pxPct: (best / (width * height)) * 100, blockMax: Math.max(...blocks), diffPng: canvas.toDataURL('image/png').split(',')[1] }
  }, [a.toString('base64'), b.toString('base64')])
}

// ---- pass/fail thresholds (written down, not eyeballed)
// Calibrated on this machine (Chromium, no Geist Mono installed). Text is the noise floor: glyph anti-aliasing, and Fabric re-measuring
// a text block's width on load (which moves it by up to a pixel), give clean text notes about 0.5% differing pixels and a worst
// 12x12 block near 60/255 (up to ~95 where a thin rotated edge lands differently at 2x). A missing or wrongly coloured object lights
// blocks near 200, and placement is gated exactly by the object-box check (drawn boxes vs the oracle, 0.05 px), not by pixels.
const LIMITS = { differingPct: 3.0, blockMax: 100, objectBoxPx: 0.05 }
// Notes the Fabric app rewrites when it opens them (it grows and shifts the page grid) cannot be compared pixel for pixel using the
// stored note: those rows also show the stored-note numbers for information, and the gate is on the same note after Fabric's rewrite.

function expectedFor(stored) {
  const doc = fromFabric(stored.content, stored.pageState)
  const placeholder = (o) => o.type === 'text' && (!String(o.content ?? '').trim() || String(o.content).trim() === 'Start typing')
  const ordered = [...doc.objects].sort((a, b) => a.z - b.z)
  const boxes = []
  let skipped = 0
  let unknown = 0
  for (const object of ordered) {
    if (object.type === 'unknown') { unknown += 1; continue }
    if (placeholder(object)) { skipped += 1; continue }
    if (object.type === 'connector') continue
    const g = object.geometry
    if (g.width === undefined || g.height === undefined) { boxes.push(null); continue } // the engine measures these
    const pts = placedPoints([object]).slice(0, 8)
    const xs = [pts[0], pts[2], pts[4], pts[6]]
    const ys = [pts[1], pts[3], pts[5], pts[7]]
    boxes.push({ left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) })
  }
  return { total: doc.objects.length, skipped, unknown, boxes }
}

function objectChecks(stored, info) {
  const expected = expectedFor(stored)
  const problems = []
  const { drawn, skipped, unknown } = info.stats
  if (drawn + skipped + unknown !== expected.total) problems.push(`objects: ${drawn} drawn + ${skipped} skipped + ${unknown} unknown != ${expected.total} stored`)
  if (skipped !== expected.skipped) problems.push(`skipped ${skipped}, expected ${expected.skipped}`)
  if (unknown !== expected.unknown) problems.push(`unknown ${unknown}, expected ${expected.unknown}`)
  if (info.boxes.length !== expected.boxes.length) problems.push(`boxes ${info.boxes.length}, expected ${expected.boxes.length}`)
  let worst = 0
  expected.boxes.forEach((box, i) => {
    if (!box || !info.boxes[i]) return
    for (const key of ['left', 'top', 'width', 'height']) worst = Math.max(worst, Math.abs(box[key] - info.boxes[i][key]))
  })
  if (worst > LIMITS.objectBoxPx) problems.push(`a drawn box is ${worst.toFixed(3)} px from the oracle (limit ${LIMITS.objectBoxPx})`)
  return { problems, checked: expected.boxes.filter(Boolean).length, worst }
}

// What Fabric did to the note on open: pages grown and objects shifted.
function reconciliation(stored, fabric) {
  const pagesBefore = `${stored.pageState?.columns ?? 1}x${stored.pageState?.rows ?? 1}`
  const pagesAfter = `${fabric.normalized.pageState.columns}x${fabric.normalized.pageState.rows}`
  const before = fromFabric(stored.content, stored.pageState).objects
  const after = fromFabric(fabric.normalized.content, fabric.normalized.pageState).objects
  const moved = {}
  let worst = 0
  if (before.length === after.length) {
    before.forEach((object, i) => {
      const other = after[i]
      if (!object.geometry || !other.geometry || object.type !== other.type) return
      const d = Math.max(Math.abs(object.geometry.x - other.geometry.x), Math.abs(object.geometry.y - other.geometry.y))
      if (d > 0.5) { moved[object.type] = (moved[object.type] ?? 0) + 1; worst = Math.max(worst, d) }
    })
  }
  const movedText = Object.entries(moved).map(([type, n]) => `${n} ${type}`).join(', ')
  const changed = pagesBefore !== pagesAfter || before.length !== after.length || Boolean(movedText)
  return { changed, text: changed ? `pages ${pagesBefore} -> ${pagesAfter}, ${before.length} -> ${after.length} objects, moved on open: ${movedText || 'none'}${worst ? ` (up to ${Math.round(worst)} px)` : ''}` : '' }
}

const server = await createServer({ server: { port: 4521, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const leaferUrl = server.resolvedUrls.local[0]
const referenceServer = await createServer({ root: path.resolve(args.reference), cacheDir: path.join(os.tmpdir(), 'leafer-parity-vite-cache'), server: { port: 4522, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
await referenceServer.listen()
const referenceUrl = referenceServer.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
const rows = []
const failures = []
const notes = []
try {
  const comparePage = await (await browser.newContext()).newPage()
  for (const dprValue of dprs) {
    dpr = dprValue
    for (const name of names) {
      const stored = { name, ...fixtures[name] }
      for (const skin of skins) {
        // Headless Chromium now and then paints a blank canvas after losing its GPU process; a pair whose worst block is wildly
        // off is drawn again (up to three times) before it is believed. `tries` shows when that happened.
        let attempt = 0
        let fabric
        let leafer
        let leaferNormalized = null
        let recon
        let results
        let normalizedResults
        do {
          attempt += 1
          fabric = await render(browser, referenceUrl, fixtures[name], skin, 'fabric')
          recon = reconciliation(stored, fabric)
          leafer = await render(browser, leaferUrl, stored, skin, 'leafer') // the STORED note
          results = []
          for (const view of views) results.push(await compare(comparePage, fabric.shots[view], leafer.shots[view]))
          normalizedResults = null
          leaferNormalized = null
          if (recon.changed) {
            leaferNormalized = await render(browser, leaferUrl, { name, ...fabric.normalized }, skin, 'leafer')
            normalizedResults = []
            for (const view of views) normalizedResults.push(await compare(comparePage, fabric.shots[view], leaferNormalized.shots[view]))
          }
        } while (attempt < 3 && (normalizedResults ?? results).some((result) => result.error || result.differingPct > 25))
        for (const problem of [...fabric.problems, ...leafer.problems]) console.error(`${name}/${skin}: ${problem}`)
        const objects = objectChecks(stored, leafer.leaferInfo)
        if (objects.problems.length) failures.push(`dpr ${dpr} ${name}/${skin}: ${objects.problems.join('; ')}`)
        if (recon.changed && skin === skins[0] && dpr === dprs[0]) notes.push(`${name}: Fabric rewrites this note on open (${recon.text}); Leafer draws it as stored, and the pixel gate uses the rewritten note`)
        views.forEach((view, index) => {
          const base = `dpr${dpr}-${name}-${skin}-${view}`
          const gated = normalizedResults ? normalizedResults[index] : results[index]
          const gatedShot = normalizedResults ? leaferNormalized.shots[view] : leafer.shots[view]
          fs.writeFileSync(path.join(outDir, `${base}-fabric.png`), fabric.shots[view])
          fs.writeFileSync(path.join(outDir, `${base}-leafer.png`), gatedShot)
          if (gated.error) { failures.push(`dpr ${dpr} ${name}/${skin}/${view}: ${gated.error}`); rows.push({ dpr, fixture: name, skin, view, error: gated.error }); return }
          fs.writeFileSync(path.join(outDir, `${base}-diff.png`), Buffer.from(gated.diffPng, 'base64'))
          const bad = gated.differingPct > LIMITS.differingPct || gated.blockMax > LIMITS.blockMax
          if (bad) failures.push(`dpr ${dpr} ${name}/${skin}/${view}: differing ${gated.differingPct.toFixed(2)}% (limit ${LIMITS.differingPct}), blockMax ${gated.blockMax.toFixed(1)} (limit ${LIMITS.blockMax})`)
          const asStored = normalizedResults ? results[index] : null
          rows.push({
            dpr, fixture: name, skin, view, 'differing%': +gated.differingPct.toFixed(3), blockMax: +gated.blockMax.toFixed(1),
            'stored note': asStored && !asStored.error ? `${asStored.differingPct.toFixed(1)}% / ${asStored.blockMax.toFixed(0)}` : 'same',
            objects: `${objects.checked} boxes <= ${objects.worst.toFixed(3)}px`, openZoom: view === 'open' ? `${fabric.opening.zoom.toFixed(3)} / ${leafer.opening.zoom.toFixed(3)}` : '',
            tries: attempt, result: bad ? 'FAIL' : 'ok',
          })
        })
      }
    }
  }
} finally {
  await browser.close()
  await server.close()
  await referenceServer.close()
}
console.table(rows)
for (const note of notes) console.log(`note: ${note}`)
console.log(`limits: differing% <= ${LIMITS.differingPct}, blockMax (12x12 blocks) <= ${LIMITS.blockMax}, drawn box vs oracle <= ${LIMITS.objectBoxPx}px, object counts exact`)
console.log(`screenshots and diffs: ${outDir}`)
if (failures.length) {
  console.error(`\nFAIL: ${failures.length} problem(s)\n  ${failures.join('\n  ')}`)
  process.exitCode = 1
} else console.log('\nPASS')
