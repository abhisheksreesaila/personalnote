import assert from 'node:assert/strict'
import test from 'node:test'
import { SECTIONS, filterSections, matches, sectionValues } from './settings-model.js'

const rows = {
  appearance: ['Crayon', 'Paper', 'Night'],
  advanced: ['Show speed meter', 'Render mode', 'Download backup', 'Import backup'],
  plugins: ['Mind maps Draw ideas as a branching map', 'Voice Dictate into a note'],
}

test('the window has the nine sections of the design, in order, in three groups', () => {
  assert.deepEqual(SECTIONS.map((s) => s.title), ['Appearance', 'Writing', 'AI', 'Plugins', 'Voice', 'Search by meaning', 'X bookmarks', 'Locked notes', 'Advanced'])
  assert.deepEqual(SECTIONS.map((s) => s.group), [0, 0, 1, 1, 1, 1, 1, 2, 2])
})

test('an empty search keeps every row of every section', () => {
  const kept = filterSections('  ', rows)
  assert.deepEqual(kept.map((s) => s.id), SECTIONS.map((s) => s.id))
  assert.deepEqual(kept.find((s) => s.id === 'advanced').rows, [0, 1, 2, 3])
})

test('a search that names a section keeps all its rows', () => {
  assert.deepEqual(filterSections('advanced', rows), [{ id: 'advanced', rows: [0, 1, 2, 3] }])
})

test('a search keeps only the rows that match, and drops sections with none', () => {
  assert.deepEqual(filterSections('backup', rows), [{ id: 'advanced', rows: [2, 3] }])
})

test('every word must match, in any order, ignoring case', () => {
  assert.deepEqual(filterSections('IMPORT backup', rows), [{ id: 'advanced', rows: [3] }])
  assert.equal(matches('map draw', 'Mind maps. Draw ideas as a branching map'), true)
  assert.equal(matches('map zebra', 'Mind maps'), false)
})

test('a keyword finds a section whose rows do not say it', () => {
  assert.deepEqual(filterSections('dark', rows).map((s) => s.id), ['appearance'])
  assert.deepEqual(filterSections('zzz', rows), [])
})

test('the phone list shows a short value per section', () => {
  const values = sectionValues({
    skin: 'paper', fontFamily: 'Source Serif 4', fontSize: 24, provider: 'Claude Code',
    plugins: [{ enabled: true }, { enabled: true }, { enabled: false }, { enabled: true }], voice: 'Ready', meaning: 'Not downloaded', x: 'Off',
  })
  assert.deepEqual(values, { appearance: 'Paper', writing: 'Serif · 24', ai: 'Claude Code', plugins: '3 on', voice: 'Ready', meaning: 'Not downloaded', x: 'Off', locked: '', advanced: '' })
})

test('missing facts read as empty values', () => {
  const values = sectionValues({})
  assert.equal(values.writing, '')
  assert.equal(values.plugins, '')
  assert.equal(values.appearance, '')
})
