import assert from 'node:assert/strict'
import test from 'node:test'
import { keyboardPan } from './keyboard-pan.js'

const view = { viewH: 800 }
const press = (key, extra = {}) => ({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...extra })

test('arrow keys pan by a step, moving the content opposite to the key', () => {
  assert.deepEqual(keyboardPan(press('ArrowDown'), view), { dx: 0, dy: -64 })
  assert.deepEqual(keyboardPan(press('ArrowUp'), view), { dx: 0, dy: 64 })
  assert.deepEqual(keyboardPan(press('ArrowRight'), view), { dx: -64, dy: 0 })
  assert.deepEqual(keyboardPan(press('ArrowLeft'), view), { dx: 64, dy: 0 })
})

test('shift makes arrow steps larger', () => {
  assert.deepEqual(keyboardPan(press('ArrowDown', { shiftKey: true }), view), { dx: 0, dy: -256 })
})

test('PageDown, PageUp and Space move by most of a screen', () => {
  assert.deepEqual(keyboardPan(press('PageDown'), view), { dx: 0, dy: -680 })
  assert.deepEqual(keyboardPan(press('PageUp'), view), { dx: 0, dy: 680 })
  assert.deepEqual(keyboardPan(press(' '), view), { dx: 0, dy: -680 })
  assert.deepEqual(keyboardPan(press(' ', { shiftKey: true }), view), { dx: 0, dy: 680 })
})

test('Home and End jump to the top and bottom', () => {
  assert.deepEqual(keyboardPan(press('Home'), view), { dx: 0, dy: Infinity })
  assert.deepEqual(keyboardPan(press('End'), view), { dx: 0, dy: -Infinity })
})

test('other keys and modified shortcuts are left alone', () => {
  assert.equal(keyboardPan(press('a'), view), null)
  assert.equal(keyboardPan(press('ArrowDown', { metaKey: true }), view), null)
  assert.equal(keyboardPan(press('ArrowDown', { ctrlKey: true }), view), null)
  assert.equal(keyboardPan(press('ArrowDown', { altKey: true }), view), null)
})
