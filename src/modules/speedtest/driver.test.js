import assert from 'node:assert/strict'
import test from 'node:test'
import { createSpeedTest } from './driver.js'

const host = (extra = {}) => ({ setView: async () => {}, scene: { clearSelection() {} }, ...extra })

test('the test stops before its first step when the open note is not the stress note, and touches nothing', async () => {
  const touched = []
  const run = createSpeedTest({
    host: host({ guard() { throw Object.assign(new Error('the open note is not the stress note'), { aborted: true }) }, workspace: { getBoundingClientRect() { touched.push('workspace'); return {} } } }),
  })
  await assert.rejects(run.run(), /not the stress note/)
  assert.deepEqual(touched, [])
})

test('the guard is asked before every step, so a switch of notes mid-test aborts the next step', async () => {
  let asked = 0
  const run = createSpeedTest({ host: host({ guard() { asked += 1; if (asked > 1) throw new Error('switched') }, workspace: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), dispatchEvent() {} } }) })
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 1)
  globalThis.WheelEvent = class {}
  await assert.rejects(run.run(), /switched/)
  assert.ok(asked >= 2)
})
