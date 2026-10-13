import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createQuietTimer, formatCountdown, formatRecoveryInput, noteRowIcon, passphraseProblem, recoveryGroups, searchResultView, unlockFailureMessage,
} from './secure.js'

test('the countdown reads minutes and seconds and never goes below zero', () => {
  assert.equal(formatCountdown(299_000), '4:59')
  assert.equal(formatCountdown(300_000), '5:00')
  assert.equal(formatCountdown(61_001), '1:02') // a part second counts as the second still left
  assert.equal(formatCountdown(9_000), '0:09')
  assert.equal(formatCountdown(0), '0:00')
  assert.equal(formatCountdown(-5), '0:00')
})

test('the quiet timer runs out after the quiet time and any activity starts it over', () => {
  let now = 1_000
  const timer = createQuietTimer({ seconds: 300, now: () => now })
  assert.equal(timer.remaining(), 300_000)
  now += 299_000
  assert.equal(timer.expired(), false)
  assert.equal(timer.remaining(), 1_000)
  timer.touch()
  now += 200_000
  assert.equal(timer.expired(), false)
  now += 100_000
  assert.equal(timer.expired(), true)
  assert.equal(timer.remaining(), 0)
})

test('a short test quiet time from the server is honoured; nonsense falls back to five minutes', () => {
  assert.equal(createQuietTimer({ seconds: 3, now: () => 0 }).remaining(), 3_000)
  for (const bad of [undefined, null, 0, -4, NaN, 'soon']) assert.equal(createQuietTimer({ seconds: bad, now: () => 0 }).remaining(), 300_000)
})

test('a recovery key is shown as eight groups of four', () => {
  assert.deepEqual(recoveryGroups('ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567'), ['ABCD', 'EFGH', 'IJKL', 'MNOP', 'QRST', 'UVWX', 'YZ23', '4567'])
  assert.deepEqual(recoveryGroups('abcdefghijklmnopqrstuvwxyz234567'), ['ABCD', 'EFGH', 'IJKL', 'MNOP', 'QRST', 'UVWX', 'YZ23', '4567'])
})

test('typing a recovery key groups it as you go, in capitals, ignoring spaces and dashes', () => {
  assert.equal(formatRecoveryInput('abcd'), 'ABCD')
  assert.equal(formatRecoveryInput('abcde'), 'ABCD-E')
  assert.equal(formatRecoveryInput('abcd efgh-ij'), 'ABCD-EFGH-IJ')
  assert.equal(formatRecoveryInput('a'.repeat(50)).replaceAll('-', '').length, 32)
})

test('a failed unlock says what to do, in the design words', () => {
  assert.equal(unlockFailureMessage(Object.assign(new Error('Touch ID was not accepted'), { status: 403 }), 'touch'), 'Not opened. Try again.')
  assert.equal(unlockFailureMessage(Object.assign(new Error('That did not open the secure notes'), { status: 403 }), 'passphrase'), 'Not opened. Try again.')
  assert.equal(unlockFailureMessage(Object.assign(new Error('That recovery key does not open these notes'), { status: 403 }), 'recovery'), "That key doesn't match. Check the groups and try again.")
  assert.equal(unlockFailureMessage(Object.assign(new Error('That is not a recovery key'), { status: 403 }), 'recovery'), "That key doesn't match. Check the groups and try again.")
  assert.equal(unlockFailureMessage(new Error('Failed to fetch'), 'touch'), "Couldn't reach Personal Note. Try again.")
})

test('a passphrase must be long enough and typed twice the same when it is chosen', () => {
  assert.equal(passphraseProblem('', ''), 'Type a passphrase')
  assert.equal(passphraseProblem('short', 'short'), 'Use at least 8 characters')
  assert.equal(passphraseProblem('long enough one', 'long enough two'), "The two don't match")
  assert.equal(passphraseProblem('long enough one', 'long enough one'), null)
})

test('a secure note row gets the lock and the secure class; the others keep their own icon', () => {
  assert.deepEqual(noteRowIcon({ secure: true, noteType: 'page' }), { icon: 'lock', className: 'is-secure' })
  assert.deepEqual(noteRowIcon({ secure: true, noteType: 'canvas' }), { icon: 'lock', className: 'is-secure' })
  assert.deepEqual(noteRowIcon({ noteType: 'mindmap' }), { icon: 'git-fork', className: '' })
  assert.deepEqual(noteRowIcon({ noteType: 'page' }), { icon: 'file-pen', className: '' })
  assert.deepEqual(noteRowIcon({ noteType: 'canvas' }), { icon: 'file-text', className: '' })
})

test('a search result for a secure note shows the title only', () => {
  assert.deepEqual(searchResultView({ secure: true, noteType: 'page', excerpt: 'card 4111' }), { icon: 'lock', excerpt: '', className: 'is-secure' })
  assert.deepEqual(searchResultView({ noteType: 'mindmap', excerpt: 'branch' }), { icon: 'git-fork', excerpt: 'branch', className: '' })
})
