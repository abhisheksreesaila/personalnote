import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { busyPorts } from './ports.mjs'

const listen = (port = 0) => new Promise((resolve) => { const s = net.createServer(); s.listen(port, '127.0.0.1', () => resolve(s)) })
const free = async () => { const s = await listen(); const { port } = s.address(); await new Promise((r) => s.close(r)); return port }
const url = new URL('./ports.mjs', import.meta.url).href
const script = (port) => spawnSync('node', ['--input-type=module', '-e', `import { assertPortsFree } from '${url}'; await assertPortsFree([${port}]); console.log('started')`], { encoding: 'utf8' })

test('a port someone is listening on is reported busy, a free one is not', async () => {
  const held = await listen()
  const taken = held.address().port
  const open = await free()
  try {
    assert.deepEqual(await busyPorts([open, taken]), [taken])
    assert.deepEqual(await busyPorts([open]), [])
  } finally { await new Promise((r) => held.close(r)) }
})

test('a script exits 1 naming the busy port and the variable to set, and leaves the listener alone', async () => {
  const held = await listen()
  const taken = held.address().port
  try {
    const run = script(taken)
    assert.equal(run.status, 1)
    assert.equal(run.stdout, '')
    assert.equal(run.stderr, `port ${taken} is busy (another session?): set PN_VERIFY_PORT to a free one. Nothing was started, killed or reused.\n`)
    assert.equal(held.listening, true)
  } finally { await new Promise((r) => held.close(r)) }
})

test('the real app port 3137 is refused even when it is free, as a derived port too', () => {
  const run = script(3137)
  assert.equal(run.status, 1)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr, 'port 3137 is the real app: never use it for a check script. Set PN_VERIFY_PORT to a free port.\n')
})

test('a free port passes through', async () => {
  const run = script(await free())
  assert.equal(run.status, 0)
  assert.equal(run.stdout, 'started\n')
})
