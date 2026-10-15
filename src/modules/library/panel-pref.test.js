import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPanelOpen, savePanelOpen } from './panel-pref.js'

const memory = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) } }

test('the notes panel is closed until someone opens it', () => {
  assert.equal(loadPanelOpen(memory()), false)
})

test('open and closed are remembered', () => {
  const storage = memory()
  savePanelOpen(storage, true)
  assert.equal(loadPanelOpen(storage), true)
  savePanelOpen(storage, false)
  assert.equal(loadPanelOpen(storage), false)
})

test('storage that is missing or throws never breaks the panel', () => {
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(loadPanelOpen(null), false)
  assert.equal(loadPanelOpen(broken), false)
  assert.doesNotThrow(() => savePanelOpen(broken, true))
  assert.doesNotThrow(() => savePanelOpen(null, true))
})
