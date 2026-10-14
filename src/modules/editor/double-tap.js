// Double-tap the command key (Control on Linux and Windows): toggles writing and the last pen tool (F-070).
// Pure timing logic; main.js feeds it key and pointer events and does the real switch. Times are milliseconds.
// A tap is the modifier alone going down and up briefly, with no other key or mouse button between. Two taps close together fire once.

export const DOUBLE_TAP = { gap: 300, hold: 250 }

/** The key that is tapped: Meta on a Mac, Control elsewhere. */
export const tapKeyFor = (platform = '') => (/mac|iphone|ipad/i.test(platform) ? 'Meta' : 'Control')

export function createDoubleTap({ key = 'Meta', gap = DOUBLE_TAP.gap, hold = DOUBLE_TAP.hold } = {}) {
  let downAt = null // when the modifier went down, while it is down
  let dirty = false // something else happened during this press
  let lastTapEnd = null // when the previous clean tap came up

  const cancel = () => { lastTapEnd = null }
  return {
    /** A key went down. A double tap fires on the second tap's key up. */
    keydown({ key: name, repeat = false, time }) {
      if (name !== key) { dirty = true; cancel(); return }
      if (repeat) { dirty = true; return } // held down: not a tap
      downAt = time
      dirty = false
      if (lastTapEnd !== null && time - lastTapEnd > gap) cancel()
    },
    /** A key came up. True when this completes a double tap. */
    keyup({ key: name, time }) {
      if (name !== key || downAt === null) return false
      const clean = !dirty && time - downAt <= hold
      downAt = null
      dirty = false
      if (!clean) { cancel(); return false }
      if (lastTapEnd !== null) { cancel(); return true } // (a third tap starts afresh)
      lastTapEnd = time
      return false
    },
    /** A mouse button or touch went down (a modifier-click is not a tap). */
    pointerdown() { dirty = true; cancel() },
    /** The window lost focus: forget everything. */
    reset() { downAt = null; dirty = false; lastTapEnd = null },
  }
}
