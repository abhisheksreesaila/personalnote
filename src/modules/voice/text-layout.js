// Where a new dictation box goes when nothing is being edited: 42 px below the content (left-aligned with it, kept inside the page grid), or
// near the top-left of the first page on an empty note. `bounds` is { left, top, right, bottom } of the note's content, or null.
export function voiceInsertPoint(bounds, { columns = 1, pageWidth = 860 } = {}) {
  if (!bounds) return { x: 96, y: 96 }
  return { x: Math.max(64, Math.min(bounds.left, columns * pageWidth - 260)), y: bounds.bottom + 42 }
}

export function pageBoundedTextLayout(point, {
  pageWidth = 860,
  leftMargin = 64,
  rightMargin = 64,
  minWidth = 220,
} = {}) {
  const column = Math.max(0, Math.floor(point.x / pageWidth))
  const pageLeft = column * pageWidth
  const pageRight = pageLeft + pageWidth
  const maxLeft = pageRight - rightMargin - minWidth
  const left = Math.max(pageLeft + leftMargin, Math.min(point.x, maxLeft))

  return {
    x: left,
    y: point.y,
    width: pageRight - rightMargin - left,
  }
}