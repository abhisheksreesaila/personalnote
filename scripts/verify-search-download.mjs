// F-078: the "Search by meaning" download in Settings, in the real app: Vite dev server on PN_VERIFY_PORT (never 3137) with the real API on
// the next port and a loopback file server on the one after, headless Chromium, a scratch database and search folder. No network: the engine
// is a small Python stand-in for llama-server and the model is random bytes, both served from this script and pinned by a manifest.
// It checks the row at phone width and on the desktop: not installed -> download -> progress -> a corrupt model fails with a retry ->
// retry -> ready (kept after a reload) -> the engine embeds a sentence -> stops with the app. Run one at a time; it stops what it starts.
//   PN_VERIFY_PORT=4890 node scripts/verify-search-download.mjs        (PN_SHOT=/path/shot.png also saves pictures)
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const UI_PORT = Number(process.env.PN_VERIFY_PORT || 4890)
if (UI_PORT === 3137 || UI_PORT + 1 === 3137 || UI_PORT + 2 === 3137) throw new Error('Never use the real app port (3137)')
const API_PORT = UI_PORT + 1
const FILE_PORT = UI_PORT + 2
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-search-'))
const python = path.resolve(fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3')

// ---- fixtures: a stand-in llama-server in a tarball shaped like the release, and a "model"
const FAKE_SERVER = `#!${python}
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
args = sys.argv[1:]
port = int(args[args.index("--port") + 1])
class H(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        self.send({"status": "ok"})
    def do_POST(self):
        asked = json.loads(self.rfile.read(int(self.headers["Content-Length"])))["input"]
        self.send({"data": [{"index": i, "embedding": [3.0, 4.0] + [0.0] * 766, "prompt": text} for i, text in enumerate(asked)]})
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
`
const stage = path.join(scratch, 'stage')
fs.mkdirSync(path.join(stage, 'llama-b11681'), { recursive: true })
fs.writeFileSync(path.join(stage, 'llama-b11681', 'llama-server'), FAKE_SERVER, { mode: 0o755 })
fs.writeFileSync(path.join(stage, 'llama-b11681', 'libggml.so.0.27.0'), 'library')
fs.writeFileSync(path.join(stage, 'llama-b11681', 'llama-cli'), 'a tool the app never runs', { mode: 0o755 })
fs.symlinkSync('libggml.so.0.27.0', path.join(stage, 'llama-b11681', 'libggml.so'))
spawnSync('tar', ['czf', path.join(scratch, 'engine.tar.gz'), '-C', stage, 'llama-b11681'])
const engine = fs.readFileSync(path.join(scratch, 'engine.tar.gz'))
const model = crypto.randomBytes(3_000_000)
const corrupt = Buffer.from(model); corrupt[1000] ^= 0xff
let serveCorrupt = true
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const fileServer = http.createServer((request, response) => {
  const body = request.url === '/engine.tar.gz' ? engine : request.url === '/model.gguf' ? (serveCorrupt ? corrupt : model) : null
  if (!body) { response.writeHead(404).end(); return }
  response.writeHead(200, { 'Content-Length': body.length })
  let offset = 0 // the model trickles out so the progress bar is visible
  const next = () => {
    if (offset >= body.length) { response.end(); return }
    response.write(body.subarray(offset, offset + 250_000)); offset += 250_000
    setTimeout(next, request.url === '/model.gguf' ? 150 : 0)
  }
  next()
})
fileServer.listen(FILE_PORT, '127.0.0.1')
const manifest = path.join(scratch, 'manifest.json')
fs.writeFileSync(manifest, JSON.stringify({
  engine: { url: `http://127.0.0.1:${FILE_PORT}/engine.tar.gz`, bytes: engine.length, sha256: sha(engine) },
  model: { url: `http://127.0.0.1:${FILE_PORT}/model.gguf`, bytes: model.length, sha256: sha(model) },
}))
const searchDir = path.join(scratch, 'search')
const env = { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db'), PERSONAL_NOTE_SEARCH_MANIFEST: manifest, PERSONAL_NOTE_SEARCH_DIR: searchDir }

const API = `http://127.0.0.1:${API_PORT}`
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], { env, stdio: 'ignore' })
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
const status = async () => (await fetch(`${API}/api/search-meaning/status`)).json()
let browser
try {
  await apiUp()
  await server.listen()
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const errors = []
  const shot = async (page, name) => { if (process.env.PN_SHOT) await page.locator('#meaning-setup-detail').scrollIntoViewIfNeeded(), await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${name}.png`) }) }
  const row = (page) => ({
    headline: page.locator('#meaning-setup-headline'),
    detail: page.locator('#meaning-setup-detail'),
    progress: page.locator('#meaning-setup-progress'),
    download: page.locator('#meaning-download'),
    cancel: page.locator('#meaning-cancel'),
  })

  for (const [label, viewport] of [['phone', { width: 390, height: 780 }], ['desktop', { width: 1360, height: 900 }]]) {
    const page = await (await browser.newContext({ viewport })).newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
    await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
    await page.click('#share-button')
    await page.click('#top-properties')
    const r = row(page)
    await page.waitForFunction(() => document.querySelector('#meaning-setup-headline').textContent !== 'Checking…', null, { timeout: 10000 })
    await page.waitForTimeout(500) // the panel slides in
    if (label === 'desktop') {
      check('[desktop] the finished install is remembered after a reload: Ready, no download button', (await r.headline.textContent()) === 'Ready' && await r.download.isHidden())
      await shot(page, 'desktop-ready')
      check('[desktop] the row sits inside the panel', await r.headline.isVisible() && (await r.headline.boundingBox()).x + (await r.headline.boundingBox()).width <= viewport.width)
      await page.context().close()
      continue
    }
    check(`[${label}] before the download the row says "Not installed" and offers Download (≈315 MB)`, (await r.download.textContent()).trim() === 'Download (≈315 MB)' && await r.cancel.isHidden() && await r.progress.isHidden())
    check(`[${label}] the row is reachable inside the panel`, await r.download.isVisible() && (await r.download.boundingBox()).x + (await r.download.boundingBox()).width <= viewport.width)
    if (label === 'phone') {
      const heights = await page.evaluate(() => ['#voice-download', '#meaning-download'].map((id) => document.querySelector(id).getBoundingClientRect().height))
      check('[phone] the Download buttons (voice and search) are at least 44px tall to touch', heights.every((h) => h >= 44), JSON.stringify(heights))
    }
    await shot(page, `${label}-idle`)

    if (label === 'phone') {
      // first try: the model arrives damaged
      await r.download.click()
      await r.cancel.waitFor({ timeout: 10000 })
      await page.waitForFunction(() => /Downloading [1-9]/.test(document.querySelector('#meaning-setup-headline').textContent), null, { timeout: 15000 })
      check('[phone] progress and Cancel show while it downloads', await r.progress.isVisible() && await r.cancel.isVisible() && await r.download.isHidden(), await r.headline.textContent())
      await shot(page, 'phone-downloading')
      await r.headline.filter({ hasText: 'Error' }).waitFor({ timeout: 30000 })
      check('[phone] a model that fails its checksum is reported in place with a retry, and nothing is installed', /checksum/.test(await r.detail.textContent()) && (await r.download.textContent()).trim() === 'Try again' && !fs.existsSync(path.join(searchDir, 'installed.json')), await r.detail.textContent())
      await shot(page, 'phone-error')

      // second try: the model is right now; cancel halfway first to see the partial kept
      serveCorrupt = false
      await r.download.click()
      await page.waitForFunction(() => /Downloading [1-9]/.test(document.querySelector('#meaning-setup-headline').textContent), null, { timeout: 15000 })
      await r.cancel.click()
      await r.headline.filter({ hasText: 'Not installed' }).waitFor({ timeout: 10000 })
      check('[phone] Cancel keeps the partial download and offers Resume', (await r.download.textContent()).trim() === 'Resume download', await r.download.textContent())
      await r.download.click()
      await r.headline.filter({ hasText: 'Ready' }).waitFor({ timeout: 60000 })
      const done = await status()
      check('[phone] it finishes: Ready, files verified, installed.json written, engine not running', done.state === 'ready' && done.running === false && fs.existsSync(path.join(searchDir, 'installed.json')), JSON.stringify(done))
      check('[phone] only the server and its libraries are kept', JSON.stringify(fs.readdirSync(path.join(searchDir, 'engine')).filter((n) => !n.startsWith('.')).sort()) === JSON.stringify(['libggml.so', 'libggml.so.0.27.0', 'llama-server']))
      await shot(page, 'phone-ready')
    }
    await page.context().close()
  }

  // the engine, through the app's own runtime: embeds a sentence on loopback, then stops with the runtime
  const embed = spawnSync(python, ['-I', '-c', `
import json, sys, time
sys.path.insert(0, ${JSON.stringify(process.cwd())})
import search_runtime
runtime = search_runtime.SearchRuntime(root=${JSON.stringify(searchDir)})
assert runtime.status()["state"] == "ready" and not runtime.status()["running"]
started = time.monotonic()
vectors = runtime.embed(["why am I tired in the morning"], "query")
pid = json.load(open(${JSON.stringify(path.join(searchDir, 'engine.pid'))}))["pid"]
print(json.dumps({"n": len(vectors), "dim": len(vectors[0]), "head": vectors[0][:2], "running": runtime.status()["running"], "pid": pid, "ms": round((time.monotonic() - started) * 1000)}))
runtime.shutdown()
print(json.dumps({"running": runtime.status()["running"]}))
`], { env, encoding: 'utf8' })
  const [embedded, stopped] = embed.stdout.trim().split('\n').map((line) => JSON.parse(line || '{}'))
  check('the engine starts on first use and embeds a sentence into one 256-number unit vector', embedded?.n === 1 && embedded.dim === 256 && Math.abs(embedded.head[0] - 0.6) < 1e-9 && embedded.running === true, embed.stdout + embed.stderr)
  let alive = true
  try { process.kill(embedded.pid, 0) } catch { alive = false }
  check('the engine stops with the runtime', stopped?.running === false && !alive)
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  fileServer.close()
  fs.rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `\n${failed} FAILED` : `\nAll ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
