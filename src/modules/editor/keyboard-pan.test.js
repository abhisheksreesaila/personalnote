import assert from 'node:assert/strict'
import test from 'node:test'
import { canPanFromKeyboard, keyboardPan } from './keyboard-pan.js'

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

const body = { matches: () => false }
const canvasElement = { matches: () => false }
const control = (selectorMatches = true) => ({ matches: () => selectorMatches, isContentEditable: false })

test('the canvas pans from the keyboard only when focus is on the page or the canvas', () => {
  assert.equal(canPanFromKeyboard({ activeElement: null, body, canvasElement }), true)
  assert.equal(canPanFromKeyboard({ activeElement: body, body, canvasElement }), true)
  assert.equal(canPanFromKeyboard({ activeElement: canvasElement, body, canvasElement }), true)
})

test('it never pans while text is being edited or a dialog is open', () => {
  assert.equal(canPanFromKeyboard({ activeElement: body, body, canvasElement, editingText: true }), false)
  assert.equal(canPanFromKeyboard({ activeElement: body, body, canvasElement, dialogOpen: true }), false)
})

test('it never pans while a control has focus (inputs, buttons, radios, menu items, editable content)', () => {
  assert.equal(canPanFromKeyboard({ activeElement: control(), body, canvasElement }), false)
  assert.equal(canPanFromKeyboard({ activeElement: { matches: () => false, isContentEditable: true }, body, canvasElement }), false)
  assert.equal(canPanFromKeyboard({ activeElement: control(false), body, canvasElement }), true)
})
