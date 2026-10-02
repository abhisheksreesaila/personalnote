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

test('imports and exports of a whole workspace or vault carry no timeout, unless one is asked for', async () => {
  const real = globalThis.fetch
  const signals = {}
  globalThis.fetch = async (url, init) => { signals[url] = init.signal; return { ok: true, status: 200, json: async () => ({}) } }
  try {
    await api('/import/workspace', { method: 'POST', body: '{}' })
    await api('/import/vault', { method: 'POST', body: '{}' })
    await api('/export/workspace')
    await api('/notes/1')
    await api('/import/workspace?again', { method: 'POST', timeout: 5000 })
    assert.equal(signals['/api/import/workspace'], undefined)
    assert.equal(signals['/api/import/vault'], undefined)
    assert.equal(signals['/api/export/workspace'], undefined)
    assert.ok(signals['/api/notes/1'])
    assert.ok(signals['/api/import/workspace?again'])
  } finally { globalThis.fetch = real }
})
