import assert from 'node:assert/strict'
import test from 'node:test'
import { createPressToTalk } from './press-to-talk.js'

function setup({ holdMs = 450 } = {}) {
  const log = []
  let listening = false
  let clock = 0
  const talk = createPressToTalk({
    toggle: async () => { listening = !listening; log.push(listening ? 'start' : 'stop') },
    isListening: () => listening,
    holdMs,
    now: () => clock,
  })
  return { talk, log, advance: (ms) => { clock += ms } }
}

test('holding the button talks while it is down and stops on release', async () => {
  const { talk, log, advance } = setup()
  await talk.press()
  advance(900)
  await talk.release()
  assert.deepEqual(log, ['start', 'stop'])
})

test('a quick tap keeps listening until the next tap', async () => {
  const { talk, log, advance } = setup()
  await talk.press()
  advance(120)
  await talk.release()
  assert.deepEqual(log, ['start'])
  await talk.press()
  await talk.release()
  assert.deepEqual(log, ['start', 'stop'])
})

test('release without a press does nothing', async () => {
  const { talk, log } = setup()
  await talk.release()
  assert.deepEqual(log, [])
})
