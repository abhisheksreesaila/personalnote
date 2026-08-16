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