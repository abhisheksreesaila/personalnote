import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CROSSFADE_MS, DEFAULT_SKIN, SKINS, SKIN_STORAGE_KEY,
  createSkinController, fontUrl, readStoredSkin, resolveSkin, writeStoredSkin,
} from './skins.js'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v) }, data }
}
const brokenStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
function fakeRoot() {
  const classes = new Set()
  return { dataset: {}, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } }
}

test('offers Crayon, Paper and Night with Crayon as the default', () => {
  assert.deepEqual(SKINS.map((s) => s.id), ['crayon', 'paper', 'night'])
  assert.equal(DEFAULT_SKIN, 'crayon')
  assert.equal(resolveSkin('nope'), 'crayon')
  assert.equal(resolveSkin(undefined), 'crayon')
})

test('starts on Crayon with nothing stored, and restores a stored choice', () => {
  const fresh = createSkinController({ root: fakeRoot(), storage: memoryStorage() })
  assert.equal(fresh.current, 'crayon')
  const root = fakeRoot()
  const restored = createSkinController({ root, storage: memoryStorage({ [SKIN_STORAGE_KEY]: 'night' }) })
  assert.equal(restored.current, 'night')
  assert.equal(root.dataset.skin, 'night')
})

test('ignores a corrupt stored value', () => {
  assert.equal(readStoredSkin(memoryStorage({ [SKIN_STORAGE_KEY]: '<script>' })), 'crayon')
})

test('selecting a skin applies, persists and notifies', () => {
  const storage = memoryStorage()
  const root = fakeRoot()
  const seen = []
  const skins = createSkinController({ root, storage, onChange: (id) => seen.push(id) })
  skins.select('paper')
  assert.equal(root.dataset.skin, 'paper')
  assert.equal(storage.data[SKIN_STORAGE_KEY], 'paper')
  assert.deepEqual(seen, ['paper'])
  skins.select('paper')
  assert.deepEqual(seen, ['paper'])
  skins.select('bogus')
  assert.equal(skins.current, 'crayon')
})

test('crossfade class is set for 400ms then removed', () => {
  const root = fakeRoot()
  const timers = []
  const skins = createSkinController({ root, storage: memoryStorage(), schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length } })
  skins.select('night')
  assert.equal(root.classList.contains('skin-fading'), true)
  assert.equal(timers[0].ms, CROSSFADE_MS)
  assert.equal(CROSSFADE_MS, 400)
  timers[0].fn()
  assert.equal(root.classList.contains('skin-fading'), false)
})

test('reduced motion skips the crossfade', () => {
  const root = fakeRoot()
  const skins = createSkinController({ root, storage: memoryStorage(), prefersReducedMotion: () => true })
  skins.select('night')
  assert.equal(root.classList.contains('skin-fading'), false)
  assert.equal(root.dataset.skin, 'night')
})

test('blocked storage never breaks switching', () => {
  const root = fakeRoot()
  const skins = createSkinController({ root, storage: brokenStorage })
  assert.equal(skins.current, 'crayon')
  skins.select('paper')
  assert.equal(root.dataset.skin, 'paper')
  assert.equal(writeStoredSkin(brokenStorage, 'paper'), false)
})

test('loads the fonts of the active skin only', () => {
  const loaded = []
  const skins = createSkinController({ root: fakeRoot(), storage: memoryStorage(), loadFonts: (id) => loaded.push(id) })
  skins.select('night')
  assert.deepEqual(loaded, ['crayon', 'night'])
  assert.match(fontUrl('night'), /Instrument\+Serif/)
  assert.doesNotMatch(fontUrl('night'), /Fraunces|Bricolage/)
  assert.match(fontUrl('crayon'), /Bricolage/)
  assert.match(fontUrl('paper'), /Fraunces/)
})
