import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CROSSFADE_MS, DEFAULT_SKIN, SKINS, SKIN_STORAGE_KEY,
  createSkinController, fontUrl, injectFonts, mountSkinSwitcher, readStoredSkin, resolveSkin, writeStoredSkin,
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

test('offers Crayon, Paper and Night with Paper as the default', () => {
  assert.deepEqual(SKINS.map((s) => s.id), ['crayon', 'paper', 'night'])
  assert.equal(DEFAULT_SKIN, 'paper')
  assert.equal(resolveSkin('nope'), 'paper')
  assert.equal(resolveSkin(undefined), 'paper')
})

test('starts on Paper with nothing stored, and restores a stored choice', () => {
  const fresh = createSkinController({ root: fakeRoot(), storage: memoryStorage() })
  assert.equal(fresh.current, 'paper')
  const root = fakeRoot()
  const restored = createSkinController({ root, storage: memoryStorage({ [SKIN_STORAGE_KEY]: 'night' }) })
  assert.equal(restored.current, 'night')
  assert.equal(root.dataset.skin, 'night')
})

test('ignores a corrupt stored value', () => {
  assert.equal(readStoredSkin(memoryStorage({ [SKIN_STORAGE_KEY]: '<script>' })), 'paper')
})

test('selecting a skin applies, persists and notifies', () => {
  const storage = memoryStorage()
  const root = fakeRoot()
  const seen = []
  const skins = createSkinController({ root, storage, onChange: (id) => seen.push(id) })
  skins.select('crayon')
  assert.equal(root.dataset.skin, 'crayon')
  assert.equal(storage.data[SKIN_STORAGE_KEY], 'crayon')
  assert.deepEqual(seen, ['crayon'])
  skins.select('crayon')
  assert.deepEqual(seen, ['crayon'])
  skins.select('bogus')
  assert.equal(skins.current, 'paper')
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
  assert.equal(skins.current, 'paper')
  skins.select('crayon')
  assert.equal(root.dataset.skin, 'crayon')
  assert.equal(writeStoredSkin(brokenStorage, 'paper'), false)
})

test('loads the fonts of the active skin only', () => {
  const loaded = []
  const skins = createSkinController({ root: fakeRoot(), storage: memoryStorage(), loadFonts: (id) => loaded.push(id) })
  skins.select('night')
  assert.deepEqual(loaded, ['paper', 'night'])
  assert.match(fontUrl('night'), /Instrument\+Serif/)
  assert.doesNotMatch(fontUrl('night'), /Fraunces|Bricolage/)
  assert.match(fontUrl('crayon'), /Bricolage/)
  assert.match(fontUrl('paper'), /Fraunces/)
})

function fakeElement() {
  const attrs = {}, listeners = {}
  return {
    attrs, dataset: {}, children: [], tabIndex: 0, style: { setProperty() {} }, focused: false,
    setAttribute(k, v) { attrs[k] = String(v) }, getAttribute: (k) => attrs[k],
    addEventListener(type, fn) { listeners[type] = fn }, fire(type, event = {}) { listeners[type]({ preventDefault() {}, ...event }) },
    append(...items) { this.children.push(...items) }, focus() { this.focused = true },
  }
}
const fakeDoc = () => ({ createElement: fakeElement })

test('switcher renders a radiogroup of three radios that follow the active skin', () => {
  const container = fakeElement()
  const skins = createSkinController({ root: fakeRoot(), storage: memoryStorage({ [SKIN_STORAGE_KEY]: 'crayon' }) })
  const { buttons } = mountSkinSwitcher(container, skins, fakeDoc())
  assert.equal(container.attrs.role, 'radiogroup')
  assert.deepEqual(buttons.map((b) => b.attrs.role), ['radio', 'radio', 'radio'])
  assert.deepEqual(buttons.map((b) => b.attrs['aria-checked']), ['true', 'false', 'false'])
  buttons[2].fire('click')
  assert.equal(skins.current, 'night')
  assert.deepEqual(buttons.map((b) => b.attrs['aria-checked']), ['false', 'false', 'true'])
})

test('switcher has one tab stop and arrow keys move and select', () => {
  const skins = createSkinController({ root: fakeRoot(), storage: memoryStorage({ [SKIN_STORAGE_KEY]: 'crayon' }) })
  const { buttons } = mountSkinSwitcher(fakeElement(), skins, fakeDoc())
  assert.deepEqual(buttons.map((b) => b.tabIndex), [0, -1, -1])
  buttons[0].fire('keydown', { key: 'ArrowRight' })
  assert.equal(skins.current, 'paper')
  assert.equal(buttons[1].focused, true)
  assert.deepEqual(buttons.map((b) => b.tabIndex), [-1, 0, -1])
  buttons[1].fire('keydown', { key: 'ArrowLeft' })
  buttons[0].fire('keydown', { key: 'ArrowLeft' })
  assert.equal(skins.current, 'night')
  buttons[2].fire('keydown', { key: 'a' })
  assert.equal(skins.current, 'night')
})

test('injectFonts adds each font stylesheet once', () => {
  const links = []
  const doc = {
    head: { append: (l) => links.push(l) },
    createElement: () => ({ dataset: {} }),
    querySelectorAll: () => links,
  }
  injectFonts('night', doc); injectFonts('night', doc)
  assert.equal(links.length, 1)
  assert.equal(links[0].href, fontUrl('night'))
  injectFonts('paper', doc)
  assert.equal(links.length, 2)
})
