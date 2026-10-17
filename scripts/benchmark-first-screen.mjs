// F-098: time to first screen and time until the canvas is drawn / ready for typing, two builds side by side, runs interleaved (A, B, A, B ...) so the
// machine's drift hits both alike. Each build is a built checkout (dist/) served by its own API on its own port, headless Chromium, scratch databases.
//   PN_BEFORE=/path/to/built/checkout PN_AFTER=/path/to/built/checkout [PN_RUNS=11] [PN_THROTTLE=4] node scripts/benchmark-first-screen.mjs
// first screen  = the open note's title and the notes list are drawn (two frames after both are there), as scripts/verify-first-screen.mjs defines it
// canvas drawn  = the canvas has drawn the note (document.documentElement.dataset.leaferSettled is set)
// writing ready = the caret is in the note's text editor (a note opens ready for typing)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const RUNS = Number(process.env.PN_RUNS || 11)
const THROTTLE = Number(process.env.PN_THROTTLE || 1)
const roots = { before: path.resolve(process.env.PN_BEFORE || '.'), after: path.resolve(process.env.PN_AFTER || '.') }
const PORTS = { before: basePort(4940), after: basePort(4940) + 1 }
await assertPortsFree(Object.values(PORTS))
const python = path.resolve(fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : '../../../.venv/bin/python')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-bench-first-'))
const servers = []
const stop = () => { for (const server of servers) { try { server.kill() } catch {} } }
process.on('exit', stop)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stop(); process.exit(1) })
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const WATCH = `(() => { const t = () => { const title = document.querySelector('#note-title'); const rows = document.querySelector('#notebook-navigator')?.children.length
  if (title && title.value === 'Plain note' && rows) requestAnimationFrame(() => requestAnimationFrame(() => { window.__firstScreen = performance.now() })); else requestAnimationFrame(t) }; requestAnimationFrame(t)
  new MutationObserver(() => { if (document.documentElement.dataset.leaferSettled && !window.__drawn) window.__drawn = performance.now() }).observe(document, { attributes: true, subtree: true })
  const w = () => { if (document.activeElement?.closest?.('.leafer-text-editor') || document.activeElement?.classList?.contains('leafer-text-editor')) window.__writing = performance.now(); else requestAnimationFrame(w) }; requestAnimationFrame(w) })()`
let browser
try {
  for (const name of ['before', 'after']) {
    const dir = path.join(scratch, name)
    fs.mkdirSync(dir)
    const env = { ...process.env, PERSONAL_NOTE_DB: path.join(dir, 'bench.db'), PERSONAL_NOTE_PLUGINS_DIR: path.join(dir, 'plugins') }
    servers.push(spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(PORTS[name])], { cwd: roots[name], env, stdio: 'ignore' }))
  }
  for (const name of ['before', 'after']) {
    const base = `http://127.0.0.1:${PORTS[name]}`
    for (let i = 0; ; i++) { try { if ((await fetch(`${base}/api/notebooks`)).ok) break } catch {} if (i > 100) throw new Error(`${name} API did not start`); await new Promise((r) => setTimeout(r, 150)) }
    await fetch(`${base}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: JSON.stringify({ title: 'Plain note' }) })
  }
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const result = { before: { first: [], drawn: [], writing: [] }, after: { first: [], drawn: [], writing: [] } }
  for (let i = 0; i < RUNS; i++) {
    for (const name of i % 2 ? ['after', 'before'] : ['before', 'after']) {
      const context = await browser.newContext({ viewport: { width: 1360, height: 900 } })
      const page = await context.newPage()
      if (THROTTLE > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
      await page.addInitScript(WATCH)
      await page.goto(`http://127.0.0.1:${PORTS[name]}/notes`)
      await page.waitForFunction(() => window.__firstScreen && window.__drawn && window.__writing, null, { timeout: 60000 })
      const [first, drawn, writing] = await page.evaluate(() => [window.__firstScreen, window.__drawn, window.__writing])
      result[name].first.push(first); result[name].drawn.push(drawn); result[name].writing.push(writing)
      await context.close()
    }
  }
  console.log(`first screen / canvas drawn / writing ready, ms, median of ${RUNS} interleaved runs${THROTTLE > 1 ? ` at ${THROTTLE}x CPU slowdown` : ''}`)
  for (const name of ['before', 'after']) {
    const r = result[name]
    console.log(`${name.padEnd(6)} first screen ${Math.round(median(r.first))}  canvas drawn ${Math.round(median(r.drawn))}  writing ready ${Math.round(median(r.writing))}   (first screen runs: ${r.first.map(Math.round).join(' ')})`)
  }
} finally {
  await browser?.close()
  stop()
  fs.rmSync(scratch, { recursive: true, force: true })
}
