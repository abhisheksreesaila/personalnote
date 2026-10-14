import assert from 'node:assert/strict'
import test from 'node:test'
import { createMiddleClick } from './middle-click.js'

test('a quick press and release in place is a click', () => {
  const gesture = createMiddleClick()
  gesture.down({ x: 100, y: 100, time: 0 })
  assert.equal(gesture.up({ time: 120 }), true)
})

test('a drag past a few pixels is a pan, even if it returns to the start', () => {
  const gesture = createMiddleClick()
  gesture.down({ x: 100, y: 100, time: 0 })
  gesture.move({ x: 110, y: 100 })
  gesture.move({ x: 100, y: 100 })
  assert.equal(gesture.up({ time: 120 }), false)
})

test('a jitter under the limit still counts as a click', () => {
  const gesture = createMiddleClick()
  gesture.down({ x: 100, y: 100, time: 0 })
  gesture.move({ x: 102, y: 101 })
  assert.equal(gesture.up({ time: 100 }), true)
})

test('a long press is not a click', () => {
  const gesture = createMiddleClick()
  gesture.down({ x: 0, y: 0, time: 0 })
  assert.equal(gesture.up({ time: 401 }), false)
})

test('a release with no press, or after cancel, is not a click', () => {
  const gesture = createMiddleClick()
  assert.equal(gesture.up({ time: 10 }), false)
  gesture.down({ x: 0, y: 0, time: 0 })
  gesture.cancel()
  assert.equal(gesture.up({ time: 10 }), false)
})

test('each press starts fresh', () => {
  const gesture = createMiddleClick()
  gesture.down({ x: 0, y: 0, time: 0 })
  gesture.move({ x: 50, y: 0 })
  gesture.up({ time: 100 })
  gesture.down({ x: 0, y: 0, time: 1000 })
  assert.equal(gesture.up({ time: 1100 }), true)
})
