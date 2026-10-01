import assert from 'node:assert/strict'
import test from 'node:test'

import { createVoiceClient, describeVoice, prepareLocalVoice } from './voice-setup.js'

const ready = { state: 'ready', running: true, endpoint: 'ws://127.0.0.1:8123/v1/realtime' }

test('each state says what it is and offers only the actions that make sense', () => {
  const idle = describeVoice({ state: 'not-installed', downloadLabel: 'about 750 MB' })
  assert.equal(idle.headline, 'Not installed')
  assert.match(idle.download, /Download voice \(≈750 MB\)/)
  assert.equal(idle.remove, null)

  const partial = describeVoice({ state: 'not-installed', partialBytes: 5000 })
  assert.equal(partial.download, 'Resume download')
  assert.equal(partial.remove, 'Discard partial download')

  const busy = describeVoice({ state: 'downloading', percent: 42, phase: 'model' })
  assert.equal(busy.headline, 'Downloading 42%')
  assert.equal(busy.percent, 42)
  assert.equal(busy.download, null)
  assert.equal(busy.cancel, 'Cancel')
  assert.equal(busy.remove, null)

  const unsupportedCpu = describeVoice({ ...ready, running: false, engineError: "This computer's processor isn't supported by the voice engine.", note: 'Engine build differs.' })
  assert.match(unsupportedCpu.detail, /processor isn't supported/)
  assert.match(unsupportedCpu.detail, /Engine build differs/)
  assert.equal(describeVoice(ready).headline, 'Ready')
  assert.equal(describeVoice(ready).remove, 'Remove voice')

  const failed = describeVoice({ state: 'error', error: 'Could not reach the download server.' })
  assert.equal(failed.headline, 'Error')
  assert.match(failed.detail, /Could not reach/)
  assert.equal(failed.download, 'Try again')

  const unsupported = describeVoice({ state: 'unsupported' })
  assert.equal(unsupported.download, null)
  assert.match(unsupported.detail, /Apple Silicon/)
})

test('a ready engine that is already running gives its own endpoint, not a fixed port', async () => {
  const calls = []
  const client = { status: async () => ready, startEngine: async () => calls.push('start') }
  assert.deepEqual(await prepareLocalVoice(client), { endpoint: ready.endpoint })
  assert.deepEqual(calls, [])
})

test('an installed but stopped engine is started on demand', async () => {
  let started = 0
  const client = {
    status: async () => ({ state: 'ready', running: false, endpoint: null }),
    startEngine: async () => { started += 1; return ready },
  }
  let announced = false
  assert.deepEqual(await prepareLocalVoice(client, { onStarting: () => { announced = true } }), { endpoint: ready.endpoint })
  assert.equal(started, 1)
  assert.equal(announced, true)
})

test('an engine that cannot start says why and points at Settings', async () => {
  const client = {
    status: async () => ({ state: 'ready', running: false }),
    startEngine: async () => { throw new Error('The voice engine stopped while starting.') },
  }
  const result = await prepareLocalVoice(client)
  assert.match(result.blocked, /stopped while starting/)
  assert.match(result.blocked, /Settings/)
})

test('an unsupported processor is stated plainly, with no advice to reinstall', async () => {
  const message = "This computer's processor isn't supported by the voice engine."
  const client = { status: async () => ({ state: 'ready', running: false }), startEngine: async () => { throw new Error(message) } }
  assert.equal((await prepareLocalVoice(client)).blocked, message)
})

test('Settings says Starting while the engine starts', () => {
  assert.equal(describeVoice({ ...ready, running: false, starting: true }).headline, 'Starting…')
})

test('voice that is not installed, downloading or broken is blocked with a short reason', async () => {
  const blocked = async (status) => (await prepareLocalVoice({ status: async () => status })).blocked
  assert.match(await blocked({ state: 'not-installed' }), /not installed.*Settings › Voice/)
  assert.match(await blocked({ state: 'downloading', percent: 61 }), /still downloading \(61%\)/)
  assert.match(await blocked({ state: 'error', error: 'Disk full.' }), /Disk full.*Settings › Voice/)
})

test('systems without a voice download, or a server that cannot answer, keep the older local-service behaviour', async () => {
  assert.deepEqual(await prepareLocalVoice({ status: async () => ({ state: 'unsupported' }) }), { legacy: true })
  assert.deepEqual(await prepareLocalVoice({ status: async () => { throw new Error('offline') } }), { legacy: true })
})

test('changing requests carry the app header and use the right verbs', async () => {
  const seen = []
  const client = createVoiceClient(async (path, options = {}) => { seen.push([path, options.method || 'GET', options.headers]) })
  await client.status()
  await client.install()
  await client.startEngine()
  await client.cancel()
  await client.remove()
  assert.deepEqual(seen.map(([path, method]) => `${method} ${path}`), [
    'GET /voice/status', 'POST /voice/install', 'POST /voice/engine/start', 'POST /voice/cancel', 'DELETE /voice',
  ])
  assert.equal(seen[0][2], undefined)
  for (const [, , headers] of seen.slice(1)) assert.equal(headers['X-Personal-Note'], '1')
})
