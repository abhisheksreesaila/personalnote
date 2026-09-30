// Skins: Crayon (default), Paper and Night. Tokens live in skins.css; this module
// only decides which skin is active, remembers it locally, and loads its fonts.

export const SKINS = [
  { id: 'crayon', name: 'Crayon', swatch: '#0a6cff', themeColor: '#f2f2f7', fonts: 'Bricolage+Grotesque:wght@600;700;800' },
  { id: 'paper', name: 'Paper', swatch: '#e5533d', themeColor: '#efebe3', fonts: 'Fraunces:wght@500;600' },
  { id: 'night', name: 'Night', swatch: '#1b2130', themeColor: '#0d1015', fonts: 'Instrument+Serif:ital@0;1' },
]
export const DEFAULT_SKIN = 'crayon'
export const SKIN_STORAGE_KEY = 'personal-note:skin'
export const CROSSFADE_MS = 400

const SHARED_FONTS = 'Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Caveat:wght@500;600'

export function resolveSkin(value) {
  return SKINS.some((skin) => skin.id === value) ? value : DEFAULT_SKIN
}

export function readStoredSkin(storage) {
  try {
    return resolveSkin(storage?.getItem(SKIN_STORAGE_KEY))
  } catch {
    return DEFAULT_SKIN
  }
}

export function writeStoredSkin(storage, id) {
  try {
    storage.setItem(SKIN_STORAGE_KEY, resolveSkin(id))
    return true
  } catch {
    return false
  }
}

export function fontUrl(id) {
  const skin = SKINS.find((entry) => entry.id === resolveSkin(id))
  return `https://fonts.googleapis.com/css2?family=${SHARED_FONTS}&family=${skin.fonts}&display=swap`
}

function browserStorage() {
  try { return globalThis.localStorage } catch { return null }
}

/** Owns the active skin. `root` is the element that carries data-skin (the <html> element). */
export function createSkinController({
  root,
  storage = browserStorage(),
  loadFonts = () => {},
  prefersReducedMotion = () => false,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  onChange = () => {},
} = {}) {
  let current = readStoredSkin(storage)
  let fadeTimer = null

  function paint(id) {
    root.dataset.skin = id
    loadFonts(id)
    const themeColor = SKINS.find((skin) => skin.id === id).themeColor
    root.ownerDocument?.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor)
  }

  paint(current)

  return {
    get current() { return current },
    select(value) {
      const next = resolveSkin(value)
      if (next === current) return current
      if (!prefersReducedMotion()) {
        root.classList.add('skin-fading')
        if (fadeTimer !== null) cancel(fadeTimer)
        fadeTimer = schedule(() => { root.classList.remove('skin-fading'); fadeTimer = null }, CROSSFADE_MS)
      }
      current = next
      paint(next)
      writeStoredSkin(storage, next)
      onChange(next)
      return current
    },
  }
}

export function injectFonts(id, doc = globalThis.document) {
  if (!doc) return
  const href = fontUrl(id)
  if ([...doc.querySelectorAll('link[data-skin-font]')].some((link) => link.href === href)) return
  const link = doc.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.dataset.skinFont = ''
  doc.head.append(link)
}

let controller = null

/** Apply the remembered skin as soon as the app starts. */
export function startSkins() {
  if (!controller) {
    controller = createSkinController({
      root: document.documentElement,
      loadFonts: injectFonts,
      prefersReducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
    })
  }
  return controller
}

/** Render the three swatches into `container` as a radiogroup (one tab stop, arrow keys move and select). */
export function mountSkinSwitcher(container, skins = startSkins(), doc = globalThis.document) {
  container.setAttribute('role', 'radiogroup')
  container.setAttribute('aria-label', 'Skin')
  const buttons = SKINS.map((skin) => {
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'skin-swatch'
    button.setAttribute('role', 'radio')
    button.dataset.skin = skin.id
    button.title = skin.name
    button.setAttribute('aria-label', `${skin.name} skin`)
    button.style.setProperty('--swatch', skin.swatch)
    button.addEventListener('click', () => choose(skin.id))
    button.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
      if (!step) return
      event.preventDefault?.()
      const index = (SKINS.findIndex((entry) => entry.id === skins.current) + step + SKINS.length) % SKINS.length
      choose(SKINS[index].id, true)
    })
    return button
  })
  function sync() {
    buttons.forEach((button) => {
      const on = button.dataset.skin === skins.current
      button.setAttribute('aria-checked', String(on))
      button.tabIndex = on ? 0 : -1
    })
  }
  function choose(id, focus = false) {
    skins.select(id)
    sync()
    if (focus) buttons.find((button) => button.dataset.skin === id).focus?.()
  }
  container.append(...buttons)
  sync()
  return { sync, buttons }
}
