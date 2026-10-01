// Native-window chrome flags. desktop.py opens the macOS window with ?host=desktop&chrome=mac and
// extends the page under a transparent title bar, so the page reserves room for the traffic lights
// and offers drag strips. Every other host (browser tab, Linux window) gets none of this.
export const MAC_CHROME_CLASS = 'chrome-mac'
export const MAC_FULLSCREEN_CLASS = 'chrome-mac-fullscreen'
export const DRAG_STRIP_CLASS = 'mac-drag-strip'

export function readHostChrome(search = '') {
  const params = new URLSearchParams(search)
  const host = params.get('host') === 'desktop' ? 'desktop' : ''
  return { host, chrome: host && params.get('chrome') === 'mac' ? 'mac' : '' }
}

// `pywebview-drag-region` is the class pywebview moves the window by; mousedown on the strip itself
// starts the drag, and the strips sit behind the controls so buttons and fields keep their clicks.
export function createDragStrip(doc, className, onDoubleClick) {
  const strip = doc.createElement('div')
  strip.className = `pywebview-drag-region ${DRAG_STRIP_CLASS} ${className}`
  strip.setAttribute('aria-hidden', 'true')
  if (onDoubleClick) strip.addEventListener('dblclick', onDoubleClick)
  return strip
}

/** Marks <html> for the unified title bar and adds the drag strips. Returns true when mac chrome applied. */
export function applyHostChrome({ root, doc = root?.ownerDocument, search = '', zoomWindow = () => {} } = {}) {
  const { chrome } = readHostChrome(search)
  if (chrome !== 'mac' || !root || !doc) return false
  root.classList.add(MAC_CHROME_CLASS)
  doc.querySelector('.main-view')?.prepend(createDragStrip(doc, 'mac-drag-main', zoomWindow))
  doc.querySelector('.sidebar')?.prepend(createDragStrip(doc, 'mac-drag-sidebar', zoomWindow))
  return true
}

/** Native full screen hides the traffic lights, so the reserved space goes away. */
export function setMacFullscreen(root, on) {
  root?.classList.toggle(MAC_FULLSCREEN_CLASS, Boolean(on))
}
