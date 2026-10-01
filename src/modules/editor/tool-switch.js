// Quick tool switching: single-key tool shortcuts and the hold-Space temporary hand.
// Pure logic only; main.js owns the real tool change, the cursor and the typing guards.

const SHORTCUTS = { v: 'select', h: 'hand', m: 'highlight' }

/** Tool a plain key selects, or null. Modified keys never switch tools. */
export function toolShortcut(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  return SHORTCUTS[String(event.key).toLowerCase()] ?? null
}

/** Hold Space: begin(currentTool) returns 'hand' when the hand should take over (else null);
 * end() returns the tool to go back to (or null when nothing should change). */
export function createTemporaryHand() {
  let previous = null
  return {
    get active() { return previous !== null },
    begin(currentTool) {
      if (previous !== null || currentTool === 'hand') return null
      previous = currentTool
      return 'hand'
    },
    end() {
      const back = previous
      previous = null
      return back
    },
    cancel() { previous = null },
  }
}
