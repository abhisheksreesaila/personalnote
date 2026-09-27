import assert from 'node:assert/strict'
import test from 'node:test'

import { createMobileHoldController } from './mobile-hold-controller.js'

test('starts voice capture on a primary press and finalizes it on release', async () => {
  const events = []
  const controller = createMobileHoldController({
    start: async () => events.push('start'),
    finish: async () => events.push('finish'),
  })

  await controller.press({ button: 0 })
  await controller.release()

  assert.deepEqual(events, ['start', 'finish'])
})

test('waits for capture startup before finalizing a released hold', async () => {
  const events = []
  let resolveStart
  const controller = createMobileHoldController({
    start: () => new Promise((resolve) => { resolveStart = () => { events.push('start'); resolve() } }),
    finish: async () => events.push('finish'),
  })

  const press = controller.press({ button: 0 })
  const release = controller.release()
  resolveStart()
  await Promise.all([press, release])

  assert.deepEqual(events, ['start', 'finish'])
})

test('does not start capture for a non-primary press', async () => {
  const events = []
  const controller = createMobileHoldController({
    start: async () => events.push('start'),
    finish: async () => events.push('finish'),
  })

  await controller.press({ button: 2 })
  await controller.release()

  assert.deepEqual(events, [])
})

test('cancels an active hold without finalizing it', async () => {
  const events = []
  const controller = createMobileHoldController({
    start: async () => events.push('start'),
    finish: async () => events.push('finish'),
    cancel: async () => events.push('cancel'),
  })

  await controller.press({ button: 0 })
  await controller.cancel()

  assert.deepEqual(events, ['start', 'cancel'])
})
