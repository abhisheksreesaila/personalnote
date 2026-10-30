// F-110 reminders, on the real API: a mind map is saved with a node due within the next minute or so, and the real scheduler fires it
// through `system_notify` into a notify-send shim (a script first on PATH that logs its arguments and, like a click on "Open", prints the
// action key). Checks: the shim got the right title and text once; the click makes GET /api/reminders/jump return that note and node once;
// a node whose text is markup reaches the shim escaped. With PN_REAL_NOTIFY=1 it also pops ONE real notification through system_notify
// (the real notify-send, no shim) and prints the exit code.
// Headless, no browser. Port from PN_VERIFY_PORT (default 4990, never 3137); a temporary PERSONAL_NOTE_DB; stops what it starts and deletes
// only the scratch folder it made.
//   node scripts/verify-reminders.mjs                 PN_REAL_NOTIFY=1 node scripts/verify-reminders.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const PORT = basePort(4990)
await assertPortsFree([PORT])
const API = `http://127.0.0.1:${PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-reminders-'))
const DB = path.join(scratch, 'verify.db')
const LOG = path.join(scratch, 'notify.log')
fs.mkdirSync(path.join(scratch, 'bin'))
const shim = path.join(scratch, 'bin', 'notify-send')
// One line per call: the arguments joined by a unit separator. With --wait it prints the action key, as a click on "Open" does.
fs.writeFileSync(shim, `#!/bin/bash
args=("$@")
wait=0
for a in "$@"; do [ "$a" = "--wait" ] && wait=1; done
(IFS=$'\\x1f'; echo "\${args[*]}" >> "${LOG}")
[ "$wait" = 1 ] && echo default
exit 0
`, { mode: 0o755 })
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const env = { ...process.env, PERSONAL_NOTE_DB: DB, PATH: `${path.join(scratch, 'bin')}:${process.env.PATH}` }
let api
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\x1f')) : [])
const get = async (url) => (await fetch(`${API}/api${url}`, { headers: { 'x-personal-note': '1' } })).json()
const post = async (method, url, body) => (await fetch(`${API}/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: JSON.stringify(body) })).json()
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250) } return false }
const localMinute = (date) => { const p = (n) => String(n).padStart(2, '0'); return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}` }

try {
  api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(PORT)], { env, stdio: 'ignore' })
  check('the API starts', await waitFor(async () => { try { return (await fetch(`${API}/api/notebooks`)).ok } catch { return false } }, 20000))
  const note = await post('POST', '/notes', { title: 'Week <i>plan</i>', noteType: 'mindmap' })
  const due = localMinute(new Date(Date.now() + 60_000)) // the next minute: at most a minute away, and the poll is 15 s
  const document = { ...note.content, nodes: [...note.content.nodes, { id: 'r1', parentId: note.content.rootId, text: 'Call <b>the</b> bank & pay', x: 0, y: 0, due }] }
  const saved = await post('PUT', `/notes/${note.id}`, { title: 'Week <i>plan</i>', revision: note.revision, content: document })
  check('the map with a due time saves', saved.ok === true, JSON.stringify(saved).slice(0, 200))
  check('nothing is sent before the time', calls().length === 0)
  const sent = await waitFor(() => calls().length > 0, 120_000)
  check('the shim is called when the node comes due', sent)
  await sleep(1500)
  const lines = calls()
  check('it is called once', lines.length === 1, JSON.stringify(lines))
  const [args = []] = lines
  check('with the wait and Open action (click-aware)', args.includes('--wait') && args.includes('--action=default=Open'), args.join(' | '))
  check('title is Personal Note', args.at(-2) === 'Personal Note', args.join(' | '))
  check('the text names the node and the map, markup escaped', args.at(-1) === 'Call &lt;b&gt;the&lt;/b&gt; bank &amp; pay — in Week &lt;i&gt;plan&lt;/i&gt;', args.at(-1))
  const jump = await waitFor(async () => (await get('/reminders/jump')).jump, 10000)
  check('the click makes the jump point at the note and node', jump && jump.noteId === note.id && jump.nodeId === 'r1', JSON.stringify(jump))
  check('the jump is handed out once', (await get('/reminders/jump')).jump === null)
  await sleep(16_000) // one more poll: a fired reminder is not sent again
  check('a later poll does not send it again', calls().length === 1, JSON.stringify(calls()))
  if (process.env.PN_REAL_NOTIFY === '1') {
    // ONE real notification, through the real notify-send (PATH without the shim).
    const realPath = process.env.PATH
    const run = spawnSync(python, ['-c', 'import sys; from reminders import system_notify; sys.exit(0 if system_notify("Personal Note", "F-110 check: a real reminder notice (sent once)") else 3)'], { env: { ...process.env, PATH: realPath }, encoding: 'utf8' })
    check(`real notify-send notice sent (exit code ${run.status})`, run.status === 0, run.stderr)
  }
} catch (error) {
  check('script ran without throwing', false, String(error))
} finally {
  if (api && !api.killed) api.kill('SIGTERM')
  await sleep(500)
  fs.rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
