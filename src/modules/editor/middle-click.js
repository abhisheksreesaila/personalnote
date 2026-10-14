// Middle-button click versus middle-drag (F-071). A click is a press and release that barely moved and was not held long;
// anything else is a pan. Pure: main.js feeds it pointer events and does the real switch. Times are milliseconds, distances pixels.

export const MIDDLE_CLICK = { slop: 4, hold: 400 }

export function createMiddleClick({ slop = MIDDLE_CLICK.slop, hold = MIDDLE_CLICK.hold } = {}) {
  let start = null // { x, y, time } while the button is down
  let moved = false
  return {
    down({ x, y, time }) { start = { x, y, time }; moved = false },
    move({ x, y }) {
      if (start && Math.hypot(x - start.x, y - start.y) >= slop) moved = true // once it travels, coming back does not make it a click
    },
    /** The button came up. True when this was a click and not a pan. */
    up({ time }) {
      const click = start !== null && !moved && time - start.time <= hold
      start = null
      moved = false
      return click
    },
    cancel() { start = null; moved = false },
  }
}
