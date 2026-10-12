import assert from 'node:assert/strict'
import test from 'node:test'
import { KEEPALIVE_LIMIT, bindPageLifecycle, bodyBytes, joinSaveBody, canKeepAlive, confirmedRevision, createSaveTiming, settleSaves } from './save-flush.js'

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

test('a revision only ever moves forward, and a failed save leaves it where the server last confirmed it', () => {
  assert.equal(confirmedRevision(4, 5), 5)
  assert.equal(confirmedRevision(5, 4), 5)
  // the in-flight save hit a conflict (no result): the close-time save must reuse the confirmed revision, never guess ahead
  assert.equal(confirmedRevision(4, undefined), 4)
})

test('settleSaves waits for an in-flight save, then saves what is still unsaved', async () => {
  const log = []
  let saving = true
  let unsaved = true
  let ticks = 0
  const result = await settleSaves({
    flushPending: () => log.push('flush'),
    isSaving: () => saving,
    hasUnsaved: () => unsaved,
    save: async () => { log.push('save'); unsaved = false },
    wait: async () => { ticks += 1; if (ticks === 2) saving = false },
  })
  assert.equal(result, true)
  assert.deepEqual(log, ['flush', 'save'])
  assert.equal(ticks, 2)
})

test('settleSaves reports false when the save did not land', async () => {
  const result = await settleSaves({ flushPending: () => {}, isSaving: () => false, hasUnsaved: () => true, save: async () => {} })
  assert.equal(result, false)
})

test('save timing is normal outside the Chromium window', () => {
  const timing = createSaveTiming({ fast: false })
  assert.equal(timing.saveDelay(), 650)
})

test('save timing is fast in the Chromium window for a small note', () => {
  const timing = createSaveTiming({ fast: true })
  assert.equal(timing.saveDelay(), 150)
})

test('a body over the keepalive limit keeps the normal delays, measured in UTF-8 bytes', () => {
  const timing = createSaveTiming({ fast: true })
  timing.saved('x'.repeat(KEEPALIVE_LIMIT))
  assert.equal(timing.saveDelay(), 150)
  // 25,000 three-byte characters are 25,000 characters but 75,000 bytes.
  timing.saved('€'.repeat(25000))
  assert.equal(timing.saveDelay(), 650)
})

test('bodyBytes counts a small body exactly and never calls a big one small', () => {
  assert.equal(bodyBytes('é'), 2)
  assert.ok(bodyBytes('é'.repeat(KEEPALIVE_LIMIT)) > KEEPALIVE_LIMIT)
  assert.equal(canKeepAlive('é'.repeat(KEEPALIVE_LIMIT)), false)
})

test('joinSaveBody puts the kept note text in whatever the other fields say, even a title that looks like a placeholder', () => {
  const content = '{"nodes":[],"edges":[],"pn":{}}'
  for (const title of ['__content__', '"__content__"', 'a "quoted" $& title']) {
    const body = joinSaveBody(content, { title, pageState: { columns: 1, rows: 1 }, notebookId: undefined, revision: 3 })
    assert.deepEqual(JSON.parse(body), { content: JSON.parse(content), title, pageState: { columns: 1, rows: 1 }, revision: 3 })
  }
})
