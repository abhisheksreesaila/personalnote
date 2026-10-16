import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { ICON_NAMES, NOTEBOOK_COLORS, displayName, guessIcon, iconOf, leadingEmoji, normalizeEmoji } from './notebook-icon.js'

test('a name is matched to an icon by its words', () => {
  const guesses = {
    Chores: 'lucide:house', 'Household chores': 'lucide:house', Links: 'lucide:globe', 'Web bookmarks': 'lucide:globe',
    'X bookmarks': 'brand:x', Tweets: 'brand:x', Twitter: 'brand:x', Recipes: 'lucide:cooking-pot', 'Travel plans': 'lucide:plane',
    Work: 'lucide:briefcase', Ideas: 'lucide:lightbulb', 'Budget 2026': 'lucide:wallet', Gym: 'lucide:dumbbell',
    'Books to read': 'lucide:book', Music: 'lucide:music', Photos: 'lucide:camera', 'Study notes': 'lucide:graduation-cap',
  }
  for (const [name, icon] of Object.entries(guesses)) assert.equal(guessIcon(name), icon, name)
})

test('a name with no known word has no guess', () => {
  assert.equal(guessIcon('My Notes'), '')
  assert.equal(guessIcon('Boxes'), '') // "x" inside a word is not the word x
  assert.equal(guessIcon(''), '')
})

test('an emoji at the start of the name wins over a keyword', () => {
  assert.equal(guessIcon('🏠 Chores'), 'emoji:🏠')
  assert.equal(guessIcon('🚀 Work'), 'emoji:🚀')
  assert.equal(guessIcon('👨‍👩‍👧 Family'), 'emoji:👨‍👩‍👧')
  assert.equal(leadingEmoji('Work 🚀'), '') // only at the start
  assert.equal(leadingEmoji('2026 plans'), '') // digits are not emoji
})

test('a chosen icon beats the guess; none chosen falls back to the guess, then to the first letter', () => {
  assert.deepEqual(iconOf({ name: 'Chores', icon: 'emoji:🐶' }), { kind: 'emoji', value: '🐶' })
  assert.deepEqual(iconOf({ name: 'Chores', icon: '' }), { kind: 'lucide', value: 'house' })
  assert.deepEqual(iconOf({ name: 'X bookmarks' }), { kind: 'brand', value: 'x' })
  assert.deepEqual(iconOf({ name: 'my notes', icon: '' }), { kind: 'letter', value: 'M' })
  assert.deepEqual(iconOf({ name: '  ', icon: '' }), { kind: 'letter', value: '?' })
})

test('only one emoji is accepted from the emoji field', () => {
  assert.equal(normalizeEmoji(' 🏠 '), 'emoji:🏠')
  assert.equal(normalizeEmoji('🇫🇷'), 'emoji:🇫🇷')
  assert.equal(normalizeEmoji('🏠🚀'), null)
  assert.equal(normalizeEmoji('ab'), null)
  assert.equal(normalizeEmoji('7'), null)
  assert.equal(normalizeEmoji(''), null)
})

test('there are eight colours and the icon list is the one the server allows', () => {
  assert.equal(NOTEBOOK_COLORS.length, 8)
  assert.ok(NOTEBOOK_COLORS.every((color) => /^#[0-9A-Fa-f]{6}$/.test(color)))
  const run = spawnSync('node', ['scripts/run-python.mjs', '-c', 'import json, notebook_icon; print(json.dumps(notebook_icon.ICON_NAMES))'], { encoding: 'utf8' })
  assert.deepEqual(ICON_NAMES, JSON.parse(run.stdout))
})

test('the row does not say the leading emoji twice when it is the icon', () => {
  assert.equal(displayName({ name: '🚀 Launch', icon: '' }), 'Launch')
  assert.equal(displayName({ name: '🚀 Launch', icon: 'emoji:🚀' }), 'Launch')
  assert.equal(displayName({ name: '🚀 Launch', icon: 'lucide:star' }), '🚀 Launch') // another icon was chosen: the name stays whole
  assert.equal(displayName({ name: '🚀', icon: '' }), '🚀') // nothing left to show
  assert.equal(displayName({ name: 'Chores', icon: '' }), 'Chores')
})
