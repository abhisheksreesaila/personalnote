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

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, value = 'true'] = arg.replace(/^--/, '').split('='); return [key, value] }))
const outDir = args.out || path.join(os.tmpdir(), 'leafer-parity')
const dpr = Number(args.dpr || 1)
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

// engine: 'fabric' is the reference checkout, 'leafer' is this one.
async function render(browser, baseUrl, fixture, skin, engine) {
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
  await context.close()
  return { shots, problems, opening }
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
    const BLOCK = 24
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

const server = await createServer({ server: { port: 4521, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const leaferUrl = server.resolvedUrls.local[0]
const referenceServer = await createServer({ root: path.resolve(args.reference), cacheDir: path.join(os.tmpdir(), 'leafer-parity-vite-cache'), server: { port: 4522, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
await referenceServer.listen()
const referenceUrl = referenceServer.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
const rows = []
try {
  const comparePage = await (await browser.newContext()).newPage()
  for (const name of names) {
    for (const skin of skins) {
      const fabric = await render(browser, referenceUrl, fixtures[name], skin, 'fabric')
      const leafer = await render(browser, leaferUrl, fixtures[name], skin, 'leafer')
      for (const problem of [...fabric.problems, ...leafer.problems]) console.error(`${name}/${skin}: ${problem}`)
      for (const view of views) {
        const base = `${name}-${skin}-${view}`
        fs.writeFileSync(path.join(outDir, `${base}-fabric.png`), fabric.shots[view])
        fs.writeFileSync(path.join(outDir, `${base}-leafer.png`), leafer.shots[view])
        const result = await compare(comparePage, fabric.shots[view], leafer.shots[view])
        if (result.error) { rows.push({ fixture: name, skin, view, error: result.error }); continue }
        fs.writeFileSync(path.join(outDir, `${base}-diff.png`), Buffer.from(result.diffPng, 'base64'))
        rows.push({
          fixture: name, skin, view, 'differing%': +result.differingPct.toFixed(3), 'within1px%': +result.within1pxPct.toFixed(3), blockMax: +result.blockMax.toFixed(2),
          openZoom: view === 'open' ? `${fabric.opening.zoom.toFixed(3)} / ${leafer.opening.zoom.toFixed(3)}` : '',
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
console.log(`screenshots and diffs: ${outDir}`)
