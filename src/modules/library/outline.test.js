import assert from 'node:assert/strict'
import test from 'node:test'
import { CATEGORIES, FOLD_KEY, NOTEBOOK_FOLD_KEY, categoryLabel, inboxNotes, isQuickNoteShortcut, isSectionOpen, modifierLabel, moveNotebookToCategory, outline, quickNoteKeycap, readFolded, writeFolded } from './outline.js'

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

test('the inbox is the unfiled notes, newest first, and empties as they are filed', () => {
  const mixed = [
    { id: 1, notebookId: 4, updatedAt: '2026-09-30' },
    { id: 2, notebookId: null, updatedAt: '2026-09-10' },
    { id: 3, notebookId: null, updatedAt: '2026-09-20' },
    { id: 4, notebookId: undefined, updatedAt: '2026-09-15' },
  ]
  assert.deepEqual(inboxNotes(mixed).map((note) => note.id), [3, 4, 2])
  assert.deepEqual(inboxNotes(mixed.filter((note) => note.notebookId != null)), [])
})

test('unfiled notes are not counted in any notebook', () => {
  const sections = outline(notebooks, [{ id: 20, notebookId: null }, { id: 21, notebookId: 2 }])
  assert.deepEqual(sections[1].notebooks.map((item) => item.count), [1])
  assert.equal(sections[0].notebooks.every((item) => item.count === 0), true)
})

test('moving a notebook to a section changes only its category', () => {
  const moved = moveNotebookToCategory(notebooks, 1, 'archive')
  assert.equal(moved.find((item) => item.id === 1).category, 'archive')
  assert.equal(notebooks.find((item) => item.id === 1).category, 'projects')
  assert.equal(moveNotebookToCategory(notebooks, 1, 'banana'), notebooks)
})

test('folded state reads and writes through a storage that may be missing or throw', () => {
  const store = new Map()
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  assert.deepEqual(readFolded(storage), {})
  writeFolded(storage, { inbox: false, archive: true })
  assert.deepEqual(readFolded(storage), { inbox: false, archive: true })
  assert.deepEqual(readFolded({ getItem: () => '[1,2]' }), {})
  assert.deepEqual(readFolded(null), {})
  assert.deepEqual(readFolded({ getItem: () => { throw new Error('blocked') } }), {})
  assert.doesNotThrow(() => writeFolded({ setItem: () => { throw new Error('blocked') } }, {}))
  store.set(FOLD_KEY, '{not json')
  assert.deepEqual(readFolded(storage), {})
  assert.equal(isSectionOpen({}, 'projects'), true) // sections start open, except the Archive
  assert.equal(isSectionOpen({}, 'inbox'), true)
  assert.equal(isSectionOpen({}, 'archive'), false)
  assert.equal(isSectionOpen({ projects: false, archive: true }, 'projects'), false)
  assert.equal(isSectionOpen({ projects: false, archive: true }, 'archive'), true)
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

test('the chord is ignored while typing, in dialogs or search, and for a dead key while typing', () => {
  assert.equal(isQuickNoteShortcut(chord(), { blocked: true }), false)
  assert.equal(isQuickNoteShortcut(chord({ key: 'Dead' }), { blocked: true }), false)
  assert.equal(isQuickNoteShortcut(chord(), { blocked: false }), true)
})

test('open notebooks are remembered under their own key, apart from the sections', () => {
  const store = new Map()
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  writeFolded(storage, { 3: true, 5: false }, NOTEBOOK_FOLD_KEY)
  assert.deepEqual(readFolded(storage, NOTEBOOK_FOLD_KEY), { 3: true, 5: false })
  assert.deepEqual(readFolded(storage), {})
})
