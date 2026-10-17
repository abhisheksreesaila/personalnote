import assert from 'node:assert/strict'
import test from 'node:test'
import { COMMON, findEmoji } from './note-icon-picker.js'

test('the picker offers twenty-four common emoji', () => {
  assert.equal(COMMON.length, 24)
  assert.equal(new Set(COMMON).size, 24)
})

test('searching by a word finds the emoji people use for it, by the start of a word', () => {
  assert.deepEqual(findEmoji('rock'), ['🚀'])
  assert.deepEqual(findEmoji('  TRIP '), ['✈️', '🧳'])
  assert.deepEqual(findEmoji('coffee tea'), ['☕'])
})

test('an emoji typed or pasted is the one result, and an empty search shows the lists instead', () => {
  assert.deepEqual(findEmoji('🍋'), ['🍋'])
  assert.deepEqual(findEmoji('🍋🍋'), [])
  assert.equal(findEmoji('   '), null)
})

test('a search with no match finds nothing', () => {
  assert.deepEqual(findEmoji('zzzz'), [])
})
