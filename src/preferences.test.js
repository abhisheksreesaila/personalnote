import assert from 'node:assert/strict'
import test from 'node:test'
import { readPreferences, writePreferences, PREFERENCES_KEY } from './preferences.js'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = String(value) },
    removeItem: (key) => { delete data[key] },
  }
}

test('reads saved preferences and ignores unknown fonts', () => {
  const storage = memoryStorage({ [PREFERENCES_KEY]: JSON.stringify({ fontFamily: 'IBM Plex Sans', fontSize: 500 }) })
  assert.deepEqual(readPreferences(storage), { fontFamily: 'IBM Plex Sans', fontSize: 72 })
  assert.deepEqual(readPreferences(memoryStorage({ [PREFERENCES_KEY]: JSON.stringify({ fontFamily: 'Comic' }) })), {})
})

test('corrupt preferences are dropped without throwing', () => {
  const storage = memoryStorage({ [PREFERENCES_KEY]: '{nope' })
  assert.deepEqual(readPreferences(storage), {})
  assert.equal(storage.getItem(PREFERENCES_KEY), null)
})

test('missing storage (a web view without localStorage) never throws', () => {
  assert.deepEqual(readPreferences(null), {})
  assert.doesNotThrow(() => writePreferences(null, { fontSize: 20 }))
})

test('storage that throws on every call never throws out of the module', () => {
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
  assert.deepEqual(readPreferences(broken), {})
  assert.doesNotThrow(() => writePreferences(broken, { fontSize: 20 }))
})

test('writes and reads back', () => {
  const storage = memoryStorage()
  writePreferences(storage, { fontFamily: 'monospace', fontSize: 30 })
  assert.deepEqual(readPreferences(storage), { fontFamily: 'monospace', fontSize: 30 })
})
