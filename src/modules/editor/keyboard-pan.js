// Keyboard panning for the window-sized canvas, which has no native scrolling.
// Returns how far the content should move ({ dx, dy } in screen pixels) or null
// when the key is not a pan key. Infinity means "all the way"; the caller clamps.

const STEP = 64
const BIG_STEP = 256
const PAGE_FRACTION = 0.85

export function keyboardPan(event, { viewH }) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const step = event.shiftKey ? BIG_STEP : STEP
  const page = Math.round(viewH * PAGE_FRACTION)
  switch (event.key) {
    case 'ArrowUp': return { dx: 0, dy: step }
    case 'ArrowDown': return { dx: 0, dy: -step }
    case 'ArrowLeft': return { dx: step, dy: 0 }
    case 'ArrowRight': return { dx: -step, dy: 0 }
    case 'PageUp': return { dx: 0, dy: page }
    case 'PageDown': return { dx: 0, dy: -page }
    case ' ': return { dx: 0, dy: event.shiftKey ? page : -page }
    case 'Home': return { dx: 0, dy: Infinity }
    case 'End': return { dx: 0, dy: -Infinity }
    default: return null
  }
}

const CONTROL_SELECTOR = 'input, textarea, select, button, a[href], summary, [contenteditable], [role="radio"], [role="menuitem"], [role="tab"], [role="slider"], [tabindex]'

// Arrow and Space keys belong to the focused control whenever there is one. The canvas only pans
// from the keyboard when focus is on the page itself (or the canvas) and nothing is being typed.
export function canPanFromKeyboard({ activeElement, body, canvasElement, editingText = false, dialogOpen = false }) {
  if (editingText || dialogOpen) return false
  if (!activeElement || activeElement === body || activeElement === canvasElement) return true
  return !(activeElement.isContentEditable || activeElement.matches?.(CONTROL_SELECTOR))
}
