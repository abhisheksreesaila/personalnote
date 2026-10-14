// Focus mode (F-073): the window becomes only the words. Pure helpers here; main.js does the real hiding and restoring.

export const FOCUS_TOP = 96 // where the top of the text sits, in window pixels
export const FOCUS_SIDE = 24

/** Cmd+. on a Mac, Ctrl+. elsewhere; any other modifier makes it a different shortcut. */
export function focusShortcut(event, platform = '') {
  if (event.key !== '.' || event.shiftKey || event.altKey) return false
  return /mac|iphone|ipad/i.test(platform) ? Boolean(event.metaKey) && !event.ctrlKey : Boolean(event.ctrlKey) && !event.metaKey
}

/** The canvas view that puts a text in the middle of the window at `scale`, its top a little below the window's top. */
export function focusView({ viewW, text, scale }) {
  const width = (text.width ?? 0) * scale
  const centred = (viewW - width) / 2 - text.x * scale
  const leftEdge = FOCUS_SIDE - text.x * scale // (a text wider than the window starts at its left edge)
  return { x: width + 2 * FOCUS_SIDE > viewW ? leftEdge : centred, y: FOCUS_TOP - text.y * scale, scale }
}

export function countWords(text) {
  const words = String(text ?? '').trim()
  return words ? words.split(/\s+/).length : 0
}

/**
 * The on/off switch. `capture()` reads everything focus will change (tool, view, selection, caret...) before `enter(saved)` changes it,
 * and `leave(saved)` puts exactly that back.
 */
export function createFocusMode({ canFocus = () => true, capture, enter, leave }) {
  let saved = null
  const api = {
    get active() { return saved !== null },
    enter() {
      if (saved || !canFocus()) return false
      saved = capture()
      enter(saved)
      return true
    },
    leave() {
      if (!saved) return false
      const before = saved
      saved = null
      leave(before)
      return true
    },
    toggle() { return api.active ? api.leave() : api.enter() },
  }
  return api
}
