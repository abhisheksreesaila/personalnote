import assert from 'node:assert/strict'
import test from 'node:test'
import { bindPageLifecycle, canKeepAlive } from './save-flush.js'

function targets() {
  const listeners = new Map()
  const make = () => ({
    visibilityState: 'visible',
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  })
  return { windowTarget: make(), documentTarget: make(), fire: (name) => listeners.get(name)?.(), listeners }
}

test('pagehide flushes pending edits', () => {
  const t = targets()
  let flushed = 0
  bindPageLifecycle({ ...t, flush: () => { flushed += 1 } })
  t.fire('pagehide')
  assert.equal(flushed, 1)
})

test('becoming hidden flushes, becoming visible does not', () => {
  const t = targets()
  let flushed = 0
  bindPageLifecycle({ ...t, flush: () => { flushed += 1 } })
  t.fire('visibilitychange')
  assert.equal(flushed, 0)
  t.documentTarget.visibilityState = 'hidden'
  t.fire('visibilitychange')
  assert.equal(flushed, 1)
})

test('unbinding removes the listeners', () => {
  const t = targets()
  const unbind = bindPageLifecycle({ ...t, flush: () => {} })
  unbind()
  assert.equal(t.listeners.size, 0)
})

test('small bodies use keepalive, oversized ones do not', () => {
  assert.equal(canKeepAlive('{"a":1}'), true)
  assert.equal(canKeepAlive('x'.repeat(70 * 1024)), false)
})
