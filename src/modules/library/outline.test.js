import assert from 'node:assert/strict'
import test from 'node:test'
import { CATEGORIES, categoryLabel, inboxNotes, isQuickNoteShortcut, modifierLabel, outline, quickNoteKeycap } from './outline.js'

const notebooks = [
  { id: 1, name: 'Personal Note', category: 'projects' },
  { id: 2, name: 'Health', category: 'areas' },
  { id: 3, name: 'Reading', category: 'resources' },
  { id: 4, name: 'Old taxes', category: 'archive' },
  { id: 5, name: 'Legacy', category: undefined },
]
const notes = [
  { id: 10, notebookId: 1 },
  { id: 11, notebookId: 1 },
  { id: 12, notebookId: 2 },
]

test('notebooks are grouped Projects, Areas, Resources, Archive with note counts', () => {
  const sections = outline(notebooks, notes)
  assert.deepEqual(sections.map((section) => section.id), CATEGORIES)
  assert.deepEqual(sections[0].notebooks.map((item) => [item.name, item.count]), [['Personal Note', 2], ['Legacy', 0]])
  assert.deepEqual(sections[1].notebooks.map((item) => [item.name, item.count]), [['Health', 1]])
  assert.deepEqual(sections[3].notebooks.map((item) => item.name), ['Old taxes'])
})

test('a notebook without a category, or with an unknown one, falls under Projects', () => {
  const sections = outline([{ id: 9, name: 'Odd', category: 'banana' }], [])
  assert.equal(sections[0].notebooks[0].name, 'Odd')
})

test('category labels are title case', () => {
  assert.equal(categoryLabel('resources'), 'Resources')
})

test('the inbox lists the newest notes first, capped', () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ id: index, notebookId: 1, updatedAt: `2026-09-${String(index + 10).padStart(2, '0')}` }))
  const recent = inboxNotes(many, 5)
  assert.equal(recent.length, 5)
  assert.equal(recent[0].id, 11)
})

test('the quick-note shortcut is shown for the platform', () => {
  assert.equal(modifierLabel('MacIntel'), '⌘')
  assert.equal(modifierLabel('Linux x86_64'), 'Ctrl')
})

const chord = (extra) => ({ code: 'KeyN', key: 'n', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...extra })

test('Alt/Option+N is the quick-note chord, including where Option+N types a dead key', () => {
  assert.equal(isQuickNoteShortcut(chord()), true)
  assert.equal(isQuickNoteShortcut(chord({ key: 'Dead' })), true)
})

test('browser-reserved or modified chords are not quick note', () => {
  assert.equal(isQuickNoteShortcut(chord({ altKey: false, ctrlKey: true })), false)
  assert.equal(isQuickNoteShortcut(chord({ altKey: false, metaKey: true })), false)
  assert.equal(isQuickNoteShortcut(chord({ ctrlKey: true })), false)
  assert.equal(isQuickNoteShortcut(chord({ shiftKey: true })), false)
  assert.equal(isQuickNoteShortcut(chord({ code: 'KeyM' })), false)
})

test('the keycap shows the chord for the platform', () => {
  assert.equal(quickNoteKeycap('MacIntel'), '⌥N')
  assert.equal(quickNoteKeycap('Linux x86_64'), 'Alt N')
})
