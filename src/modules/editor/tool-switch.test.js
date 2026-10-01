import assert from 'node:assert/strict'
import test from 'node:test'
import { createTemporaryHand, toolShortcut } from './tool-switch.js'

const press = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...extra })

test('V selects the arrow and H the hand, in either case', () => {
  assert.equal(toolShortcut(press('v')), 'select')
  assert.equal(toolShortcut(press('V', { shiftKey: true })), 'select')
  assert.equal(toolShortcut(press('h')), 'hand')
})

test('M picks the highlighter now that H is the hand', () => {
  assert.equal(toolShortcut(press('m')), 'highlight')
})

test('modified keys and other keys are not tool shortcuts', () => {
  assert.equal(toolShortcut(press('v', { ctrlKey: true })), null)
  assert.equal(toolShortcut(press('h', { metaKey: true })), null)
  assert.equal(toolShortcut(press('h', { altKey: true })), null)
  assert.equal(toolShortcut(press('x')), null)
})

test('holding Space switches to the hand and release returns to the previous tool', () => {
  const hand = createTemporaryHand()
  assert.equal(hand.begin('pen'), 'hand')
  assert.equal(hand.active, true)
  assert.equal(hand.end(), 'pen')
  assert.equal(hand.active, false)
})

test('key repeat does not restart the temporary hand or lose the previous tool', () => {
  const hand = createTemporaryHand()
  hand.begin('connect')
  assert.equal(hand.begin('hand'), null)
  assert.equal(hand.end(), 'connect')
})

test('Space while the hand is already the tool changes nothing', () => {
  const hand = createTemporaryHand()
  assert.equal(hand.begin('hand'), null)
  assert.equal(hand.active, false)
  assert.equal(hand.end(), null)
})

test('choosing a tool while Space is held keeps that choice on release', () => {
  const hand = createTemporaryHand()
  hand.begin('select')
  hand.cancel()
  assert.equal(hand.end(), null)
})

test('releasing without a press does nothing', () => {
  assert.equal(createTemporaryHand().end(), null)
})
