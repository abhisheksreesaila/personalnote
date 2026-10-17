import assert from 'node:assert/strict'
import test from 'node:test'
import { latestRequest } from './latest-request.js'

test('a new request cancels the one before it, and only the newest is current', () => {
  const latest = latestRequest()
  const first = latest.start()
  const second = latest.start()
  assert.equal(first.signal.aborted, true)
  assert.equal(first.current(), false)
  assert.equal(second.signal.aborted, false)
  assert.equal(second.current(), true)
  latest.cancel()
  assert.equal(second.signal.aborted, true)
  assert.equal(second.current(), false)
})
