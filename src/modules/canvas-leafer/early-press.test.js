import assert from 'node:assert/strict'
import test from 'node:test'
import { createEarlyPress } from './early-press.js'

test('a press made before any note was picked is placed in the first note picked', () => {
  const held = createEarlyPress()
  held.hold({ x: 640, y: 420, tool: 'text' }, 0)
  held.pick(1)
  assert.deepEqual(held.take(1), { x: 640, y: 420, tool: 'text', sequence: 1 })
})

test('a press made while note A loads lands nowhere when note B is picked', () => {
  const held = createEarlyPress()
  held.hold({ x: 10, y: 20, tool: 'text' }, 1)
  held.pick(2)
  assert.equal(held.take(2), null)
  assert.equal(held.take(1), null)
})

test('a press held for a first note that never draws a canvas is gone when the next note is picked', () => {
  const held = createEarlyPress()
  held.hold({ x: 10, y: 20, tool: 'text' }, 0)
  held.pick(1) // a page note: nothing takes it
  held.pick(2)
  assert.equal(held.take(2), null)
})

test('a held sticky and a held shape keep their tool and are given out once', () => {
  const held = createEarlyPress()
  held.hold({ x: 1, y: 2, tool: 'sticky', now: true }, 1)
  assert.equal(held.take(1).tool, 'sticky')
  assert.equal(held.take(1), null)
  held.hold({ x: 3, y: 4, tool: 'shape' }, 1)
  assert.equal(held.take(1).tool, 'shape')
})
