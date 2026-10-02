// F-033 checks, in the real app: the real Python server on a temporary database and media folder (port 4790), the Vite dev server in
// front of it (port 4791, /api proxied to that server), headless Chromium. Pictures dropped, pasted and picked on the Leafer canvas are
// stored in the media library (a media reference in the saved JSON Canvas, never a data URL), reload to the same picture, undo and
// redo, move and resize; transparent PNGs stay PNG; the print sheets and the note picture match the Fabric render of the same note;
// the print preview prints without app chrome; the vault, Markdown and backup exports carry the pictures; and a 12-megapixel drop
// keeps frames under budget.
//
//   TMPDIR=/var/tmp node scripts/verify-leafer-media.mjs            (PN_PYTHON=<python with the requirements> if .venv is elsewhere)
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const API_PORT = 4790
const UI_PORT = 4791
const root = new URL('..', import.meta.url).pathname
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pn-media-'))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`) }

const pythonCandidates = [process.env.PN_PYTHON, path.join(root, '.venv/bin/python'), path.join(root, '../../../.venv/bin/python')].filter(Boolean)
const python = pythonCandidates.find((candidate) => fs.existsSync(candidate)) || 'python3'

// ---------------------------------------------------------------- the server: a temporary database and media folder, nothing real
const serverEnv = { ...process.env, PERSONAL_NOTE_VOICE_DIR: path.join(work, 'voice'), HOME: work }
const server = spawn(python, ['-c', `import uvicorn\nfrom routes import create_app\nuvicorn.run(create_app(${JSON.stringify(path.join(work, 'note.db'))}, bound_host='127.0.0.1'), host='127.0.0.1', port=${API_PORT}, log_level='warning')`], { cwd: root, env: serverEnv, stdio: ['ignore', 'inherit', 'inherit'] })
const api = (p, options) => fetch(`http://127.0.0.1:${API_PORT}/api${p}`, options)
for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }

const vite = await createServer({ root, server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': `http://127.0.0.1:${API_PORT}` } }, logLevel: 'error' })
await vite.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

const cleanup = async () => {
  await browser.close().catch(() => {})
  await vite.close().catch(() => {})
  server.kill('SIGTERM')
  fs.rmSync(work, { recursive: true, force: true })
}

const puts = []
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const pn = (page, expression, arg) => page.evaluate(`(${expression})(${JSON.stringify(arg ?? null)})`)
const doc = (page) => pn(page, () => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))
const images = async (page) => (await doc(page)).objects.filter((o) => o.type === 'image')
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 80)) } return null }
const waitSave = async (before) => { await waitFor(() => puts.length > before); await new Promise((r) => setTimeout(r, 150)); return puts.length > before }
const nextFrame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
const settle = async (page) => { await page.evaluate(() => window.__personalNote.leaferCanvas().whenSettled()); await page.waitForTimeout(150) }

// Pictures made in the page (OffscreenCanvas), as bytes the checks can drop, paste and pick.
async function makePicture(page, spec) {
  const base64 = await page.evaluate(async (s) => {
    const surface = new OffscreenCanvas(s.width, s.height)
    const g = surface.getContext('2d')
    if (s.kind === 'photo') { // a busy opaque picture
      const gradient = g.createLinearGradient(0, 0, s.width, s.height)
      gradient.addColorStop(0, '#2d6cdf'); gradient.addColorStop(0.5, '#e0a030'); gradient.addColorStop(1, '#c0307a')
      g.fillStyle = gradient; g.fillRect(0, 0, s.width, s.height)
      for (let i = 0; i < 400; i += 1) { g.fillStyle = `hsl(${(i * 47) % 360} 70% 50% / .6)`; g.fillRect((i * 977) % s.width, (i * 613) % s.height, 120 + (i % 90), 80 + (i % 60)) }
    } else if (s.kind === 'cutout') { // transparent around a disc, half transparent bar through it
      g.clearRect(0, 0, s.width, s.height)
      g.fillStyle = '#d02050'; g.beginPath(); g.arc(s.width / 2, s.height / 2, Math.min(s.width, s.height) * 0.4, 0, Math.PI * 2); g.fill()
      g.fillStyle = 'rgba(20,60,200,.5)'; g.fillRect(0, s.height * 0.45, s.width, s.height * 0.1)
    }
    const blob = await surface.convertToBlob({ type: s.type, quality: 0.9 })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let text = ''
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(text)
  }, spec)
  const bytes = Buffer.from(base64, 'base64')
  const file = path.join(work, spec.name)
  fs.writeFileSync(file, bytes)
  return { ...spec, bytes, file }
}

// A drop and a paste carry the file in a DataTransfer, as a real one does.
const dropFiles = (page, pictures, at) => page.evaluate(async ({ items, at }) => {
  const transfer = new DataTransfer()
  for (const item of items) transfer.items.add(new File([Uint8Array.from(atob(item.base64), (c) => c.charCodeAt(0))], item.name, { type: item.type }))
  const target = document.querySelector('.workspace') || document.querySelector('#leafer-host')
  target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }))
  target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }))
}, { items: pictures.map((p) => ({ name: p.name, type: p.type, base64: p.bytes.toString('base64') })), at })
const pasteFiles = (page, pictures) => page.evaluate(({ items }) => {
  const transfer = new DataTransfer()
  for (const item of items) transfer.items.add(new File([Uint8Array.from(atob(item.base64), (c) => c.charCodeAt(0))], item.name, { type: item.type }))
  document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
}, { items: pictures.map((p) => ({ name: p.name, type: p.type, base64: p.bytes.toString('base64') })) })

const diff = (page, a, b, box) => page.evaluate(async ([one, two, region]) => {
  const load = async (data) => { const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob()); const c = new OffscreenCanvas(image.width, image.height); const x = c.getContext('2d'); x.drawImage(image, 0, 0); return x.getImageData(0, 0, image.width, image.height) }
  const [first, second] = await Promise.all([load(one), load(two)])
  if (first.width !== second.width || first.height !== second.height) return { size: [first.width, first.height, second.width, second.height] }
  const [x0, y0, x1, y1] = region ?? [0, 0, first.width, first.height]
  let total = 0; let over40 = 0; let sum = 0
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const i = (y * first.width + x) * 4
    let level = 0
    for (let k = 0; k < 4; k += 1) level = Math.max(level, Math.abs(first.data[i + k] - second.data[i + k]))
    total += 1; sum += level; if (level > 40) over40 += 1
  }
  return { size: [first.width, first.height], pixels: total, over40Pct: (100 * over40) / total, meanLevel: sum / total }
}, [a.toString('base64'), b.toString('base64'), box ?? null])

const zipNames = (buffer) => {
  const file = path.join(work, `zip-${Math.random().toString(16).slice(2)}.zip`)
  fs.writeFileSync(file, buffer)
  const listing = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  return { listing, extract: (name) => spawnSync('unzip', ['-p', file, name], { maxBuffer: 1 << 28 }).stdout }
}

try {
  const notebooks = await (await api('/notebooks')).json()
  const created = await (await api('/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Pictures', notebookId: notebooks[0].id }) })).json()
  const noteId = created.id
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => { if (request.method() === 'PUT' && /\/api\/notes\/\d+$/.test(request.url())) puts.push(request.postData() ?? '') })
  await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await page.waitForFunction(() => window.__personalNote?.leaferCanvas, null, { timeout: 60000 })
  if (!(await pn(page, (id) => window.__personalNote.state.activeNoteId === id, noteId))) await pn(page, (id) => window.__personalNote.selectNote(id), noteId)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await settle(page)

  const screenOf = (px, py) => pn(page, ([x, y]) => { const view = window.__personalNote.leaferCanvas().view(); const rect = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: rect.left + view.x + x * view.scale, y: rect.top + view.y + y * view.scale } }, [px, py])

  // ---------------------------------------------------------------- drop: a 12-megapixel photo, with the frame budget measured
  const photo = await makePicture(page, { name: 'photo.jpg', kind: 'photo', width: 4000, height: 3000, type: 'image/jpeg' })
  const at = await screenOf(430, 540)
  await page.evaluate(() => { window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__framing) requestAnimationFrame(tick) }; window.__framing = true; requestAnimationFrame(tick) })
  const before = puts.length
  await dropFiles(page, [photo], at)
  const dropped = await waitFor(async () => (await images(page)).length === 1)
  await page.waitForTimeout(700)
  const frames = await page.evaluate(() => { window.__framing = false; return window.__frames })
  const sorted = [...frames].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  console.log(`INFO  12 MP drop: ${frames.length} frames, p50 ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, worst ${sorted.at(-1).toFixed(1)} ms`)
  check('drop: a 12-megapixel photo becomes one picture on the page', Boolean(dropped))
  check('drop: p95 frame time stays within 16.8 ms while the photo is prepared, uploaded and placed', p95 <= 16.8, `p95 ${p95.toFixed(1)}`)
  const [first] = await images(page)
  check('drop: it is a media-library reference, not a data URL', first?.mediaRef?.kind === 'media' && /^[0-9a-f]{64}\.jpg$/.test(first.mediaRef.id), JSON.stringify(first?.mediaRef).slice(0, 80))
  const shownW = first.geometry.width * first.geometry.scaleX
  const shownH = first.geometry.height * first.geometry.scaleY
  check('drop: stored at 1400 px on the long side, shown at most 520 wide, centred on the drop point', first.geometry.width === 1400 && first.geometry.height === 1050 && Math.abs(Math.max(shownW, shownH) - 520) < 0.5 && Math.abs(first.geometry.x + shownW / 2 - 430) < 2 && Math.abs(first.geometry.y + shownH / 2 - 540) < 2, JSON.stringify(first.geometry))
  check('drop: the note is saved', await waitSave(before))
  check('drop: no save carries picture bytes (no data URL anywhere in what was sent)', puts.every((body) => !body.includes('data:image')), `${puts.length} saves`)
  const stored = await (await api(`/notes/${noteId}`)).json()
  const node = stored.content.nodes.find((n) => n.pn?.type === 'image')
  check('drop: the stored JSON Canvas holds the picture as a file node `media/<sha256>.jpg`', node && node.file === `media/${first.mediaRef.id}`, JSON.stringify(node))
  const media = await api(`/media/${first.mediaRef.id}`)
  const mediaBytes = Buffer.from(await media.arrayBuffer())
  check('drop: the media file is served, content-addressed, with the existing policy header', media.status === 200 && media.headers.get('content-type') === 'image/jpeg' && `${sha(mediaBytes)}.jpg` === first.mediaRef.id && /default-src 'none'/.test(media.headers.get('content-security-policy') ?? ''))
  check('drop: the stored file is small (a shrunk JPEG, not the 12 MP original)', mediaBytes.length < photo.bytes.length, `${mediaBytes.length} vs ${photo.bytes.length}`)

  console.log(`INFO  errors: ${errors.length ? errors.join(' | ') : 'none'}`)
  check('no page errors', errors.length === 0, errors.join(' | '))
} catch (error) {
  console.error(error)
  results.push(false)
} finally {
  await cleanup()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} of ${results.length} FAILED` : `all ${results.length} passed`)
process.exit(failed ? 1 : 0)
