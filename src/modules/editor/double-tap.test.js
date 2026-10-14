import assert from 'node:assert/strict'
import test from 'node:test'
import { createDoubleTap, tapKeyFor } from './double-tap.js'

const press = (tap, at, heldFor = 80, key = 'Meta') => {
  tap.keydown({ key, time: at })
  return tap.keyup({ key, time: at + heldFor })
}

test('two clean taps close together fire on the second', () => {
  const tap = createDoubleTap()
  assert.equal(press(tap, 0), false)
  assert.equal(press(tap, 200), true)
})

test('Cmd+Z during the second tap never fires', () => {
  const tap = createDoubleTap()
  press(tap, 0)
  tap.keydown({ key: 'Meta', time: 150 })
  tap.keydown({ key: 'z', time: 170 })
  tap.keyup({ key: 'z', time: 200 })
  assert.equal(tap.keyup({ key: 'Meta', time: 230 }), false)
  assert.equal(press(tap, 300), false) // the first tap was cancelled: this is a first tap again
})

test('Cmd+C during the first tap never fires', () => {
  const tap = createDoubleTap()
  tap.keydown({ key: 'Meta', time: 0 })
  tap.keydown({ key: 'c', time: 20 })
  tap.keyup({ key: 'c', time: 50 })
  tap.keyup({ key: 'Meta', time: 80 })
  assert.equal(press(tap, 150), false)
})

test('a shortcut between the taps cancels the first tap', () => {
  const tap = createDoubleTap()
  press(tap, 0)
  tap.keydown({ key: 'Meta', time: 100 })
  tap.keydown({ key: 'c', time: 120 })
  tap.keyup({ key: 'c', time: 150 })
  tap.keyup({ key: 'Meta', time: 170 })
  assert.equal(press(tap, 250), false)
})

test('any other key between the taps cancels', () => {
  const tap = createDoubleTap()
  press(tap, 0)
  tap.keydown({ key: 'a', time: 100 })
  tap.keyup({ key: 'a', time: 130 })
  assert.equal(press(tap, 200), false)
})

test('slow taps do not fire', () => {
  const tap = createDoubleTap()
  press(tap, 0)
  assert.equal(press(tap, 600), false)
})

test('a long hold is not a tap', () => {
  const tap = createDoubleTap()
  assert.equal(press(tap, 0, 700), false)
  assert.equal(press(tap, 800), false)
  const held = createDoubleTap()
  press(held, 0)
  assert.equal(press(held, 150, 700), false)
})

test('a held modifier that auto-repeats is not a tap', () => {
  const tap = createDoubleTap()
  press(tap, 0)
  tap.keydown({ key: 'Meta', time: 150 })
  tap.keydown({ key: 'Meta', repeat: true, time: 180 })
  assert.equal(tap.keyup({ key: 'Meta', time: 200 }), false)
})

test('a triple tap fires once', () => {
  const tap = createDoubleTap()
  assert.equal(press(tap, 0), false)
  assert.equal(press(tap, 150), true)
  assert.equal(press(tap, 300), false)
})

test('a click during a tap, or between taps, cancels', () => {
  const tap = createDoubleTap()
  press(tap, 0)
  tap.keydown({ key: 'Meta', time: 100 })
  tap.pointerdown()
  assert.equal(tap.keyup({ key: 'Meta', time: 150 }), false)
  const between = createDoubleTap()
  press(between, 0)
  between.pointerdown()
  assert.equal(press(between, 150), false)
})

test('losing focus forgets a half tap', () => {
  const tap = createDoubleTap()
  press(tap, 0)
  tap.reset()
  assert.equal(press(tap, 150), false)
})

test('the other modifier alone does nothing', () => {
  const tap = createDoubleTap({ key: 'Control' })
  press(tap, 0, 80, 'Meta')
  assert.equal(press(tap, 150, 80, 'Meta'), false)
  press(tap, 300, 80, 'Control')
  assert.equal(press(tap, 400, 80, 'Control'), true)
})

test('Meta on a Mac, Control elsewhere', () => {
  assert.equal(tapKeyFor('MacIntel'), 'Meta')
  assert.equal(tapKeyFor('Linux x86_64'), 'Control')
  assert.equal(tapKeyFor('Win32'), 'Control')
})
