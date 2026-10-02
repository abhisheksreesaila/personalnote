import assert from 'node:assert/strict'
import test from 'node:test'
import { api } from './api.js'

const neverAnswers = (url, init) => new Promise((resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(init.signal.reason))
})

test('a request that gets no answer is given up after its timeout', async () => {
  const real = globalThis.fetch
  globalThis.fetch = neverAnswers
  try {
    const started = Date.now()
    await assert.rejects(api('/notes/1', { method: 'PUT', body: '{}', timeout: 30 }))
    assert.ok(Date.now() - started < 1000)
  } finally { globalThis.fetch = real }
})

test('an answer inside the timeout is returned, and the other options reach fetch', async () => {
  const real = globalThis.fetch
  let seen
  globalThis.fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ revision: 3 }) } }
  try {
    assert.deepEqual(await api('/notes/1', { method: 'PUT', body: '{}', keepalive: true }), { revision: 3 })
    assert.equal(seen.url, '/api/notes/1')
    assert.equal(seen.init.keepalive, true)
    assert.equal(seen.init.method, 'PUT')
    assert.ok(seen.init.signal)
  } finally { globalThis.fetch = real }
})
