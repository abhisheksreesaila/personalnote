import assert from 'node:assert/strict'
import test from 'node:test'
import { createSecureSession } from './session.js'

function setup({ bridge, fail = false } = {}) {
  const calls = []
  const api = async (path, options = {}) => { calls.push([options.method ?? 'GET', path]); if (fail) throw new Error('offline'); return { unlocked: false } }
  const bridgeCalls = []
  const session = createSecureSession({
    api,
    workspace: { append() {}, removeEventListener() {}, addEventListener() {} },
    topbarActions: { prepend() {} },
    shell: { classList: { add() {}, remove() {} } },
    titleInput: {},
    renderIcons() {},
    captureBridge: () => bridge && ((hidden) => { bridgeCalls.push(hidden); return Promise.resolve(bridge.answer ?? true) }),
    host: {},
    setInterval: () => 1,
    clearInterval() {},
  })
  return { session, calls, bridgeCalls }
}

test('leaving always locks the server, even when the page thinks nothing is open (keys can be held from an earlier page)', async () => {
  const { session, calls } = setup()
  await session.leave()
  assert.deepEqual(calls, [['POST', '/secure/lock']])
})

test('leaving survives a server that does not answer', async () => {
  const { session } = setup({ fail: true })
  await session.leave()
})

test('leaving lets the window be shared again when the Mac bridge exists', async () => {
  const { session, bridgeCalls } = setup({ bridge: {} })
  await session.leave()
  assert.deepEqual(bridgeCalls, [false])
})

test('a note is only drawn once the window is hidden from sharing (when the Mac bridge exists)', async () => {
  const hidden = setup({ bridge: { answer: true } })
  assert.equal(await hidden.session.guardOpen(), true)
  assert.deepEqual(hidden.bridgeCalls, [true])
  assert.equal(await hidden.session.guardOpen(), true) // already hidden: no second call
  assert.equal(hidden.bridgeCalls.length, 1)
  const refused = setup({ bridge: { answer: false } })
  assert.equal(await refused.session.guardOpen(), false)
  assert.deepEqual(refused.calls, [['POST', '/secure/lock']]) // and the keys go again
})

test('without a Mac bridge there is nothing to hide and the note may be drawn', async () => {
  const { session, calls } = setup()
  assert.equal(await session.guardOpen(), true)
  assert.deepEqual(calls, [])
})

test('a page start puts sharing back through the bridge', async () => {
  const { session, bridgeCalls } = setup({ bridge: {} })
  await session.resetCapture()
  assert.deepEqual(bridgeCalls, [false])
})
