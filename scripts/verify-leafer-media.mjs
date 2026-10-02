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

  // where the drop point is on the page, as drawn: the middle of the picture's on-screen box
  const centreOnScreen = async (id, want = { x: 430, y: 540 }) => { const c = await pn(page, (key) => window.__personalNote.leaferCanvas().pageCorners(key), id); const x = (c[0].x + c[2].x) / 2; const y = (c[0].y + c[2].y) / 2; return { x, y, near: Math.abs(x - want.x) < 2 && Math.abs(y - want.y) < 2 } }
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
  check('drop: p95 frame time stays within 16.8 ms while the photo is prepared, uploaded and placed', Number(p95.toFixed(1)) <= 16.8, `p95 ${p95.toFixed(1)}`)
  const [first] = await images(page)
  check('drop: it is a media-library reference, not a data URL', first?.mediaRef?.kind === 'media' && /^[0-9a-f]{64}\.jpg$/.test(first.mediaRef.id), JSON.stringify(first?.mediaRef).slice(0, 80))
  const shownW = first.geometry.width * first.geometry.scaleX
  const shownH = first.geometry.height * first.geometry.scaleY
  check('drop: stored at 1400 px on the long side, shown at most 520 wide, centred on the drop point', first.geometry.width === 1400 && first.geometry.height === 1050 && Math.abs(Math.max(shownW, shownH) - 520) < 0.5 && Math.abs(first.geometry.x + first.geometry.width / 2 - 430) < 2 && Math.abs(first.geometry.y + first.geometry.height / 2 - 540) < 2 && (await centreOnScreen(first.id)).near, JSON.stringify(first.geometry))
  check('drop: the note is saved', await waitSave(before))
  check('drop: no save carries picture bytes (no data URL anywhere in what was sent)', puts.every((body) => !body.includes('data:image')), `${puts.length} saves`)
  const stored = await (await api(`/notes/${noteId}`)).json()
  const node = stored.content.nodes.find((n) => n.pn?.type === 'image')
  check('drop: the stored JSON Canvas holds the picture as a file node `media/<sha256>.jpg`', node && node.file === `media/${first.mediaRef.id}`, JSON.stringify(node))
  const media = await api(`/media/${first.mediaRef.id}`)
  const mediaBytes = Buffer.from(await media.arrayBuffer())
  check('drop: the media file is served, content-addressed, with the existing policy header', media.status === 200 && media.headers.get('content-type') === 'image/jpeg' && `${sha(mediaBytes)}.jpg` === first.mediaRef.id && /default-src 'none'/.test(media.headers.get('content-security-policy') ?? ''))
  check('drop: the stored file is small (a shrunk JPEG, not the 12 MP original)', mediaBytes.length < photo.bytes.length, `${mediaBytes.length} vs ${photo.bytes.length}`)


  // ---------------------------------------------------------------- reload shows the identical picture
  const hostRect = () => pn(page, () => { const r = document.querySelector('#leafer-host').getBoundingClientRect(); return { x: r.left, y: r.top } })
  const pictureShot = async (id) => {
    await pn(page, () => window.__personalNote.leaferCanvas().clearSelection())
    await settle(page)
    const rect = await hostRect()
    const box = await pn(page, (key) => window.__personalNote.leaferCanvas().screenBox(key), id)
    return page.screenshot({ clip: { x: rect.x + box.x, y: rect.y + box.y, width: Math.round(box.width), height: Math.round(box.height) } })
  }
  const shotBefore = await pictureShot(first.id)
  await page.reload()
  await page.waitForFunction(() => window.__personalNote?.leaferCanvas && document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  if (!(await pn(page, (id) => window.__personalNote.state.activeNoteId === id, noteId))) { await pn(page, (id) => window.__personalNote.selectNote(id), noteId); await page.waitForTimeout(800) }
  await settle(page)
  const reloaded = (await images(page))[0]
  const shotAfter = await pictureShot(first.id)
  const same = await diff(page, shotBefore, shotAfter)
  check('reload: the picture is the same media reference and looks identical (pixels)', reloaded?.mediaRef?.id === first.mediaRef.id && same.over40Pct === 0 && same.meanLevel < 0.5, JSON.stringify(same))

  // ---------------------------------------------------------------- paste a small transparent PNG, pick a large one
  const cutoutSmall = await makePicture(page, { name: 'cut-small.png', kind: 'cutout', width: 600, height: 400, type: 'image/png' })
  const cutoutBig = await makePicture(page, { name: 'cut-big.png', kind: 'cutout', width: 2000, height: 1500, type: 'image/png' })
  let mark = puts.length
  await page.mouse.click(5, 5)
  await pasteFiles(page, [cutoutSmall])
  await waitFor(async () => (await images(page)).length === 2)
  const pasted = (await images(page)).find((o) => o.id !== first.id)
  check('paste: a pasted picture is stored as a media reference', /^[0-9a-f]{64}\.png$/.test(pasted?.mediaRef?.id ?? ''), JSON.stringify(pasted?.mediaRef))
  check('paste: a small transparent PNG stays PNG, byte for byte', pasted?.mediaRef?.id === `${sha(cutoutSmall.bytes)}.png`)
  check('paste: saved', await waitSave(mark))
  // undo and redo of an image add (the history starts when the note is opened, so it is the pasted picture that is undone)
  await page.mouse.click(5, 5) // off the canvas, so the keys go to the page
  await page.keyboard.press('Control+z')
  check('undo: the pasted picture is taken out, the first stays', await waitFor(async () => { const list = await images(page); return list.length === 1 && list[0].id === first.id }))
  check('undo: and the saved note follows (one picture node)', await waitFor(async () => (await (await api(`/notes/${noteId}`)).json()).content.nodes.filter((n) => n.pn?.type === 'image').length === 1))
  await page.keyboard.press('Control+Shift+z')
  check('redo: it is back with the same media reference', await waitFor(async () => { const list = await images(page); return list.length === 2 && list.some((o) => o.mediaRef.id === pasted.mediaRef.id && o.id === pasted.id) }))
  await settle(page)
  const shotRedo = await pictureShot(pasted.id)
  check('redo: the picture is on screen again (not blank)', await page.evaluate(async (b64) => { const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); const d = g.getImageData(0, 0, bmp.width, bmp.height).data; let ink = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) ink += 1; return ink > 200 }, shotRedo.toString('base64')))
  mark = puts.length
  await page.setInputFiles('#image-file', cutoutBig.file)
  await waitFor(async () => (await images(page)).length === 3)
  const picked = (await images(page)).find((o) => o.id !== first.id && o.id !== pasted.id)
  check('pick: a picked picture is stored as a media reference, shrunk to 1400 wide, centred in the view', /^[0-9a-f]{64}\.png$/.test(picked?.mediaRef?.id ?? '') && picked.geometry.width === 1400 && picked.geometry.height === 1050, JSON.stringify(picked?.geometry))
  const pickedBytes = Buffer.from(await (await api(`/media/${picked.mediaRef.id}`)).arrayBuffer())
  const alpha = await page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }))
    const c = new OffscreenCanvas(bitmap.width, bitmap.height); const g = c.getContext('2d'); g.drawImage(bitmap, 0, 0)
    return { corner: g.getImageData(3, 3, 1, 1).data[3], center: g.getImageData(bitmap.width / 2, bitmap.height / 2 + 60, 1, 1).data[3], bar: g.getImageData(bitmap.width / 2, bitmap.height * 0.5, 1, 1).data[3], width: bitmap.width }
  }, pickedBytes.toString('base64'))
  check('pick: a large transparent PNG stays PNG with its see-through parts', pickedBytes.subarray(1, 4).toString() === 'PNG' && alpha.corner === 0 && alpha.center === 255 && alpha.width === 1400, JSON.stringify(alpha))
  check('pick: saved, still no picture bytes in any save', await waitSave(mark) && puts.every((body) => !body.includes('data:image')))


  // ---------------------------------------------------------------- move and resize (F-028's editing), undoable
  await pn(page, () => window.__personalNote.setTool('select'))
  const corners = await pn(page, (id) => window.__personalNote.leaferCanvas().pageCorners(id), picked.id)
  const centre = await screenOf((corners[0].x + corners[2].x) / 2, (corners[0].y + corners[2].y) / 2)
  const geometryOf = async (id) => (await images(page)).find((o) => o.id === id).geometry
  const g0 = await geometryOf(picked.id)
  await page.mouse.move(centre.x, centre.y)
  await page.mouse.down()
  await page.mouse.move(centre.x + 30, centre.y + 20, { steps: 4 })
  await page.mouse.move(centre.x + 60, centre.y + 40, { steps: 4 })
  await page.mouse.up()
  await settle(page)
  const g1 = await geometryOf(picked.id)
  const scale = (await pn(page, () => window.__personalNote.leaferCanvas().view())).scale
  check('move: dragging the picture moves it by the drag', Math.abs(g1.x - g0.x - 60 / scale) < 1.5 && Math.abs(g1.y - g0.y - 40 / scale) < 1.5, `${JSON.stringify(g0)} -> ${JSON.stringify(g1)}`)
  const moveCorners = await pn(page, (id) => window.__personalNote.leaferCanvas().pageCorners(id), picked.id)
  const handle = await screenOf(moveCorners[2].x, moveCorners[2].y) // bottom right: the zoom control stands aside when it is over a handle
  await page.waitForTimeout(150)
  check('resize: a floating control sitting over the bottom-right handle stands aside (faint, no pointer)', await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return !el?.closest('.zoom-control, .page-minimap, .tool-dock') }, [handle.x, handle.y]), JSON.stringify(handle))
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.x + 20, handle.y + 15, { steps: 4 })
  await page.mouse.move(handle.x + 60, handle.y + 45, { steps: 4 })
  await page.mouse.up()
  await settle(page)
  const g2 = await geometryOf(picked.id)
  check('resize: dragging a corner handle makes it bigger and it keeps its media reference', g2.width * g2.scaleX > g1.width * g1.scaleX + 20 && (await images(page)).find((o) => o.id === picked.id).mediaRef.id === picked.mediaRef.id, `${JSON.stringify(g1)} -> ${JSON.stringify(g2)}`)
  await page.mouse.click(5, 5)
  await page.keyboard.press('Control+z')
  await waitFor(async () => { const g = await geometryOf(picked.id); return Math.abs(g.width * g.scaleX - g1.width * g1.scaleX) < 0.5 })
  await page.keyboard.press('Control+z')
  await waitFor(async () => Math.abs((await geometryOf(picked.id)).x - g0.x) < 0.5)
  const gBack = await geometryOf(picked.id)
  check('move and resize undo one step each, back to where the picture was placed', Math.abs(gBack.x - g0.x) < 0.5 && Math.abs(gBack.width * gBack.scaleX - g0.width * g0.scaleX) < 0.5, JSON.stringify(gBack))


  // ---------------------------------------------------------------- export and print against the Fabric render of the same note
  const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/documents/app-all-tools.json', import.meta.url), 'utf8'))
  const note2 = await (await api('/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Export', notebookId: notebooks[0].id }) })).json()
  const put2 = await api(`/notes/${note2.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Export', notebookId: notebooks[0].id, revision: note2.revision, content: fixture.content, pageState: { columns: 2, rows: 1 } }) })
  check('export note: the all-tools fixture is stored on a 2 x 1 grid', put2.ok)
  await pn(page, (id) => window.__personalNote.refreshWorkspaceLists().then(() => window.__personalNote.selectNote(id)), note2.id)
  await page.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, note2.id, { timeout: 30000 })
  await settle(page)
  const small = await makePicture(page, { name: 'second.png', kind: 'cutout', width: 500, height: 300, type: 'image/png' })
  const mid = await makePicture(page, { name: 'mid.jpg', kind: 'photo', width: 1200, height: 900, type: 'image/jpeg' })
  await dropFiles(page, [small], await screenOf(1300, 540))
  await waitFor(async () => (await images(page)).length === 2)
  await dropFiles(page, [mid], await screenOf(560, 760))
  await waitFor(async () => (await images(page)).length === 3)
  await settle(page)
  const objects2 = await images(page)
  const imageBoxes = objects2.map((o) => { const w = o.geometry.width * o.geometry.scaleX; const h = o.geometry.height * o.geometry.scaleY; return { x: o.geometry.x + o.geometry.width / 2 - w / 2, y: o.geometry.y + o.geometry.height / 2 - h / 2, w, h } })
  console.log('INFO  boxes', JSON.stringify(imageBoxes.map((b) => [b.x, b.y, b.w, b.h].map(Math.round))))
  check('export note: it holds three pictures (one from the fixture, two just dropped), all media references', objects2.length === 3 && objects2.every((o) => o.mediaRef.kind === 'media'))

  const leaferSheet = (column) => page.evaluate(async (c) => {
    const blob = await window.__personalNote.leaferCanvas().renderRegion({ x: c * 860, y: 0, width: 860, height: 1080 }, { pixelRatio: 2 })
    const bytes = new Uint8Array(await blob.arrayBuffer()); let text = ''
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(text)
  }, column).then((b64) => Buffer.from(b64, 'base64'))
  const fabricSheet = (column) => page.evaluate(async (c) => {
    const { toFabricUnchecked } = await import('/src/core/document/fabric.js')
    const document_ = window.__personalNote.leaferEdits.doc
    const urls = new Map()
    const collect = async (list) => { for (const o of list) { if (o.type === 'image' && o.mediaRef.kind === 'media') { const blob = await (await fetch(`/api/media/${o.mediaRef.id}`)).blob(); urls.set(o.mediaRef.id, await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob) })) } } }
    await collect(document_.objects)
    const json = toFabricUnchecked(document_, { resolveMedia: (ref) => urls.get(ref.id) })
    return (await window.__personalNote.renderFabricPrintSheet(c, 0, json)).split(',')[1]
  }, column).then((b64) => Buffer.from(b64, 'base64'))

  const sheets = []
  for (const column of [0, 1]) {
    const leafer = await leaferSheet(column)
    const fabric = await fabricSheet(column)
    sheets.push({ leafer, fabric })
    if (process.env.SAVE_DIR) { fs.mkdirSync(process.env.SAVE_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.SAVE_DIR, `leafer-${column}.png`), leafer); fs.writeFileSync(path.join(process.env.SAVE_DIR, `fabric-${column}.png`), fabric) }
    const whole = await diff(page, fabric, leafer)
    const regions = []
    for (const box of imageBoxes) {
      const x0 = Math.round((box.x - column * 860) * 2) + 6; const y0 = Math.round(box.y * 2) + 6
      const x1 = Math.round((box.x + box.w - column * 860) * 2) - 6; const y1 = Math.round((box.y + box.h) * 2) - 6
      if (x1 > x0 + 10 && y1 > y0 + 10 && x0 >= 0 && x1 <= 1720 && y1 <= 2160) regions.push({ box, ...(await diff(page, fabric, leafer, [x0, y0, x1, y1])) })
    }
    console.log(`INFO  sheet ${column + 1} vs Fabric: ${whole.size?.join('x')} ${whole.over40Pct?.toFixed(3)}% of pixels differ by > 40/255, mean level ${whole.meanLevel?.toFixed(3)}; picture interiors: ${regions.map((r) => `${r.over40Pct.toFixed(2)}%/${r.meanLevel.toFixed(2)}`).join(', ') || 'none inside the sheet'}`)
    check(`export: print sheet ${column + 1} is ${1720}x${2160} like the Fabric sheet and matches it (<= 3% of pixels differ by more than 40/255: glyph edges)`, whole.size?.[0] === 1720 && whole.size?.[1] === 2160 && whole.over40Pct <= 3, JSON.stringify(whole))
    check(`export: sheet ${column + 1} pictures match the Fabric pictures (interior mean level <= 4/255)`, regions.every((r) => r.meanLevel <= 4 && r.over40Pct <= 1), JSON.stringify(regions))
    // no screen-only chrome: the strips along the sheet's edges (where page furniture such as fold lines, shadows and edges would be) are white
    const edge = await page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0)
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data; let off = 0; let total = 0
      for (let y = 0; y < bmp.height; y += 1) for (let x = 0; x < bmp.width; x += 1) { if (x > 3 && x < bmp.width - 4 && y > 3 && y < bmp.height - 4) continue; const i = (y * bmp.width + x) * 4; total += 1; if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) off += 1 }
      return { off, total }
    }, leafer.toString('base64'))
    check(`export: sheet ${column + 1} has no page furniture along its edges (paper colour, shadow, fold line, labels)`, edge.off / edge.total < 0.002, JSON.stringify(edge))
  }

  // the note as one picture, from the Share menu: the same pixels as the two sheets side by side
  await page.click('#share-button')
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#share-png')])
  const pictureFile = path.join(work, 'note.png')
  await download.saveAs(pictureFile)
  const notePng = fs.readFileSync(pictureFile)
  const stitched = await page.evaluate(async ([noteB64, a, b]) => {
    const load = async (data) => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
    const [whole, one, two] = await Promise.all([load(noteB64), load(a), load(b)])
    const c = new OffscreenCanvas(whole.width, whole.height); const g = c.getContext('2d'); g.drawImage(one, 0, 0); g.drawImage(two, one.width, 0)
    const ref = g.getImageData(0, 0, whole.width, whole.height).data
    const d = new OffscreenCanvas(whole.width, whole.height); const x = d.getContext('2d'); x.drawImage(whole, 0, 0)
    const got = x.getImageData(0, 0, whole.width, whole.height).data
    let different = 0; for (let i = 0; i < ref.length; i += 4) if (Math.abs(ref[i] - got[i]) + Math.abs(ref[i + 1] - got[i + 1]) + Math.abs(ref[i + 2] - got[i + 2]) > 6) different += 1
    return { width: whole.width, height: whole.height, different, pixels: ref.length / 4 }
  }, [notePng.toString('base64'), sheets[0].leafer.toString('base64'), sheets[1].leafer.toString('base64')])
  check('export: "Note as picture" downloads one PNG, 2 x 1 pages at twice size, pixel-equal to the two print sheets side by side', stitched.width === 3440 && stitched.height === 2160 && stitched.different / stitched.pixels < 0.0005 && download.suggestedFilename() === 'Export.png', JSON.stringify(stitched))


  // ---------------------------------------------------------------- too large, and pictures that arrive mid-gesture
  const be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const huge = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be(12000), ...be(10000), 8, 6, 0, 0, 0, ...new Array(64).fill(0)])
  const countBefore = (await images(page)).length
  await dropFiles(page, [{ name: 'huge.png', type: 'image/png', bytes: huge }], await screenOf(400, 400))
  const message = await waitFor(() => page.evaluate(() => document.querySelector('#save-state')?.textContent.includes('too large') ? document.querySelector('#save-state').textContent : ''))
  check('a picture over 100 megapixels is refused before decoding, with a visible message, and nothing is added', Boolean(message) && (await images(page)).length === countBefore, message ?? 'no message')
  await pn(page, () => window.__personalNote.setTool('pen'))
  const penAt = await screenOf(300, 300)
  const queued = await makePicture(page, { name: 'late.png', kind: 'cutout', width: 300, height: 200, type: 'image/png' })
  await page.mouse.move(penAt.x, penAt.y)
  await page.mouse.down()
  await page.mouse.move(penAt.x + 40, penAt.y + 20, { steps: 3 })
  await dropFiles(page, [queued], await screenOf(500, 500))
  await page.waitForTimeout(1200) // long enough for the upload to have finished
  const during = (await images(page)).length
  await page.mouse.up()
  const after = await waitFor(async () => (await images(page)).length === countBefore + 1)
  check('a picture whose upload finishes in the middle of a pen stroke waits for the stroke to end', during === countBefore && Boolean(after), `${during} during, ${(await images(page)).length} after, was ${countBefore}`)
  check('the stroke itself was kept', (await doc(page)).objects.some((o) => o.type === 'ink'))
  await pn(page, () => window.__personalNote.setTool('select'))
  const strokeEnd = (await doc(page)).objects.length
  // and one still waiting when the note is left is dropped, not added to the other note
  await pn(page, () => window.__personalNote.setTool('pen'))
  await page.mouse.move(penAt.x, penAt.y + 60)
  await page.mouse.down()
  await page.mouse.move(penAt.x + 30, penAt.y + 80, { steps: 3 })
  await dropFiles(page, [queued], await screenOf(500, 500))
  await page.waitForTimeout(1000)
  await pn(page, (id) => window.__personalNote.selectNote(id), noteId)
  await page.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, noteId, { timeout: 30000 })
  await page.mouse.up()
  await page.waitForTimeout(1200)
  check('a picture still waiting when the note is switched is dropped, not added to the other note', (await images(page)).length === 3, `${(await images(page)).length}`) // the first note holds its three
  void strokeEnd
  await pn(page, (id) => window.__personalNote.selectNote(id), note2.id)
  await page.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, note2.id, { timeout: 30000 })
  await settle(page)
  await pn(page, () => window.__personalNote.setTool('select'))

  // ---------------------------------------------------------------- print preview and the PDF
  await page.click('#share-button')
  await page.click('#share-print')
  await page.waitForFunction(() => document.querySelectorAll('.print-sheet-card img').length === 2, null, { timeout: 30000 })
  await page.waitForTimeout(300)
  const preview = await page.evaluate(() => [...document.querySelectorAll('.print-sheet-card img')].map((img) => ({ w: img.naturalWidth, h: img.naturalHeight, blob: img.src.startsWith('blob:') })))
  check('print preview: two sheets, 1720 x 2160, drawn from the Leafer render', preview.length === 2 && preview.every((p) => p.w === 1720 && p.h === 2160 && p.blob), JSON.stringify(preview))
  const previewSame = await page.evaluate(async () => { const out = []; for (const img of document.querySelectorAll('.print-sheet-card img')) { const blob = await (await fetch(img.src)).blob(); out.push(blob.size) } return out })
  const fresh = [await leaferSheet(0), await leaferSheet(1)] // the note has since gained a stroke and a picture
  check('print preview: the sheets are the same pictures as a fresh export of the note (same bytes)', previewSame[0] === fresh[0].length && previewSame[1] === fresh[1].length, `${previewSame} vs ${fresh.map((x) => x.length)}`)
  await page.emulateMedia({ media: 'print' })
  const chrome = await page.evaluate(() => ['.topbar', '.tool-dock', '.sidebar', '#leafer-host', '.zoom-control', '.engine-pill', '.speed-meter'].map((q) => { const el = document.querySelector(q); return el ? getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0 && !el.closest('[hidden]') : false }))
  check('print: no app chrome is on the printed page (toolbar, dock, sidebar, canvas, zoom)', chrome.every((visible) => visible === false), JSON.stringify(chrome))
  const pdfFile = path.join(work, 'note.pdf')
  fs.writeFileSync(pdfFile, await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }))
  const pdfText = fs.readFileSync(pdfFile).toString('latin1')
  const pageCount = (pdfText.match(/\/Type\s*\/Page[^s]/g) || []).length
  check('print: the PDF has exactly one page per sheet (2), no extra page', pageCount === 2, `${pageCount}`)
  spawnSync('pdftoppm', ['-r', '96', '-png', pdfFile, path.join(work, 'pdf')])
  const pdfPages = fs.readdirSync(work).filter((f) => /^pdf-\d+\.png$/.test(f)).sort()
  if (process.env.SAVE_DIR) for (const f of pdfPages) fs.copyFileSync(path.join(work, f), path.join(process.env.SAVE_DIR, f))
  const fits = []
  for (const [pageIndex, sheet] of [[0, fresh[0]], [1, fresh[1]]]) {
  const pdfPng = fs.readFileSync(path.join(work, pdfPages[pageIndex]))
  fits.push(await page.evaluate(async ([pdfB64, sheetB64]) => {
    const load = async (d) => createImageBitmap(await (await fetch(`data:image/png;base64,${d}`)).blob())
    const [pdf, sheet] = await Promise.all([load(pdfB64), load(sheetB64)])
    const scale = Math.min(pdf.width / sheet.width, pdf.height / sheet.height)
    const w = Math.round(sheet.width * scale); const h = Math.round(sheet.height * scale); const ox = Math.round((pdf.width - w) / 2); const oy = Math.round((pdf.height - h) / 2)
    const c = new OffscreenCanvas(pdf.width, pdf.height); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, pdf.width, pdf.height); g.drawImage(sheet, ox, oy, w, h)
    const expected = g.getImageData(0, 0, pdf.width, pdf.height).data
    const r = new OffscreenCanvas(pdf.width, pdf.height).getContext('2d'); r.drawImage(pdf, 0, 0)
    const got = r.getImageData(0, 0, pdf.width, pdf.height).data
    let outside = 0; let outsideTotal = 0; let sum = 0; let count = 0
    for (let y = 0; y < pdf.height; y += 1) for (let x = 0; x < pdf.width; x += 1) {
      const i = (y * pdf.width + x) * 4
      const inside = x >= ox + 2 && x < ox + w - 2 && y >= oy + 2 && y < oy + h - 2
      if (inside) { sum += Math.abs(expected[i] - got[i]) + Math.abs(expected[i + 1] - got[i + 1]) + Math.abs(expected[i + 2] - got[i + 2]); count += 1 }
      else if (x < ox - 2 || x >= ox + w + 2 || y < oy - 2 || y >= oy + h + 2) { outsideTotal += 1; if (got[i] < 250 || got[i + 1] < 250 || got[i + 2] < 250) outside += 1 }
    }
    return { outside, outsideTotal, meanLevel: sum / count / 3, size: [pdf.width, pdf.height] }
  }, [pdfPng.toString('base64'), sheet.toString('base64')]))
  }
  check('print: each PDF page is its sheet on white paper (nothing outside it, inside matches within 6/255 mean after rescaling)', fits.every((fit) => fit.outside === 0 && fit.meanLevel < 6), JSON.stringify(fits))
  console.log('INFO  pdf pages rendered', pdfPages.join(','), 'sizes', pdfPages.map((f) => fs.statSync(path.join(work, f)).size).join(','))
  await page.emulateMedia({ media: 'screen' })
  await page.click('#close-print')

  // ---------------------------------------------------------------- the other exports carry the pictures
  const names = (await images(page)).map((o) => o.mediaRef.id)
  await page.waitForTimeout(800)
  const vault = zipNames(Buffer.from(await (await api('/export/vault')).arrayBuffer()))
  check('vault export: every picture of the note is a file in the vault, and the .canvas points at it', names.every((n) => vault.listing.some((entry) => entry.endsWith(n))) && vault.listing.filter((e) => e.endsWith('.canvas')).some((e) => names.every((n) => vault.extract(e).toString('utf8').includes(n))), vault.listing.join(','))
  const vaultFile = vault.listing.find((e) => e.endsWith(names[0]))
  check('vault export: the picture file is byte-identical to the media library file', sha(vault.extract(vaultFile)) === names[0].split('.')[0])
  const markdown = zipNames(Buffer.from(await (await api('/export/markdown')).arrayBuffer()))
  const mdFile = markdown.listing.find((e) => e.endsWith('export.md'))
  const mdText = mdFile ? markdown.extract(mdFile).toString('utf8') : ''
  check('markdown export: pictures come as local asset files, text is a lossy reading projection, nothing remote is fetched', markdown.listing.some((e) => e.startsWith('assets/')) && /\]\((\.\.\/)*assets\//.test(mdText) && !/https?:\/\//.test(mdText), `${markdown.listing.join(',')}\n${mdText.slice(0, 300)}`)
  const backup = await (await api('/export/workspace')).text()
  check('backup: the pictures are inside the backup as data (lossless), so a restore needs no media folder', (backup.match(/data:image\/(png|jpeg)/g) || []).length >= 3)

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
