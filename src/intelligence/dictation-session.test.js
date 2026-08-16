import assert from 'node:assert/strict'
import test from 'node:test'

import { DictationSession } from './dictation-session.js'

function speechResult(transcript, isFinal = false) {
  return Object.assign([{ transcript }], { isFinal })
}

test('separates unstable partial text from stable segments', () => {
  const session = new DictationSession()
  session.start('canvas-target')

  const update = session.accept([
    speechResult('  Schedule   lunch ', true),
    speechResult(' with Maya ', false),
  ])

  assert.deepEqual(update, {
    partial: 'with Maya',
    stable: ['Schedule lunch'],
  })
  assert.equal(session.target, 'canvas-target')
})

test('honors a provider result index', () => {
  const session = new DictationSession()
  session.start()

  const update = session.accept([
    speechResult('already handled', true),
    speechResult('new stable segment', true),
  ], 1)

  assert.deepEqual(update.stable, ['new stable segment'])
})

test('ignores provider events after cancellation', () => {
  const session = new DictationSession()
  session.start('canvas-target')
  session.cancel()

  const update = session.accept([speechResult('stale words', true)])

  assert.deepEqual(update, { partial: '', stable: [] })
  assert.equal(session.target, null)
})

test('renders live partials separately from committed text', () => {
  const session = new DictationSession()
  session.start({ text: 'Existing note' })

  assert.equal(session.preview('hello'), 'Existing note hello')
  assert.equal(session.preview('world', { append: true }), 'Existing note hello world')
  assert.equal(session.commit('Hello world.'), 'Existing note Hello world.')
  assert.equal(session.partial, '')
})

test('replaces a cumulative browser partial without duplicating it', () => {
  const session = new DictationSession()
  session.start({ text: '' })

  session.preview('Meet')
  assert.equal(session.preview('Meet Maya'), 'Meet Maya')
  assert.equal(session.commit('Meet Maya tomorrow.'), 'Meet Maya tomorrow.')
})