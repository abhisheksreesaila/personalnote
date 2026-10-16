import test from 'node:test'
import assert from 'node:assert/strict'
import { describeX } from './x-settings.js'

const connected = { clientId: 'abc', connected: true, connecting: false, syncing: false, lastSync: null, imported: 12, error: '', errorKind: '' }

test('not connected asks for the client id and offers Connect X only', () => {
  const view = describeX({ ...connected, connected: false, imported: 0 })
  assert.equal(view.headline, 'Not connected')
  assert.deepEqual([view.field, view.connect, view.sync, view.disconnect], [true, true, false, false])
})

test('waiting for the browser sign-in offers nothing to press', () => {
  const view = describeX({ ...connected, connected: false, connecting: true })
  assert.deepEqual([view.headline, view.connect, view.sync, view.disconnect, view.busy], ['Waiting for X…', false, false, false, true])
})

test('connected shows the count, Sync now and Disconnect', () => {
  const view = describeX(connected)
  assert.deepEqual([view.headline, view.field, view.sync, view.disconnect], ['12 bookmarks', false, true, true])
  assert.equal(describeX({ ...connected, imported: 1 }).headline, '1 bookmark')
  assert.match(view.detail, /Not synced since the app opened/)
})

test('an error is shown plainly and a signed-out one offers Connect X again', () => {
  const view = describeX({ ...connected, error: 'X has no API credit left on this account.', errorKind: 'no_credits' })
  assert.equal(view.detail, 'X has no API credit left on this account.')
  assert.deepEqual([view.error, view.sync, view.connect], [true, true, false])
  const out = describeX({ ...connected, error: 'X no longer accepts this sign-in. Connect X again.', errorKind: 'signed_out' })
  assert.deepEqual([out.connect, out.field, out.sync, out.disconnect], [true, true, false, true])
})

test('syncing disables the buttons', () => {
  const view = describeX({ ...connected, syncing: true })
  assert.deepEqual([view.headline, view.busy], ['Syncing…', true])
})
