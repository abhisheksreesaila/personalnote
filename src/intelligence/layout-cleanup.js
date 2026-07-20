export function planGridLayout(items, { maxWidth = 760, gapX = 28, gapY = 22 } = {}) {
  if (!Array.isArray(items) || items.length < 2) return []
  const ordered = [...items].sort((left, right) => left.top - right.top || left.left - right.left)
  const originLeft = Math.min(...ordered.map(item => item.left))
  const originTop = Math.min(...ordered.map(item => item.top))
  const cellWidth = Math.max(...ordered.map(item => item.width)) + gapX
  const cellHeight = Math.max(...ordered.map(item => item.height)) + gapY
  const availableWidth = Math.max(cellWidth, maxWidth - originLeft)
  const preferredColumns = ordered.length > 4 ? 2 : 1
  const columns = Math.max(1, Math.min(preferredColumns, Math.floor(availableWidth / cellWidth)))

  return ordered.map((item, index) => ({
    id: item.id,
    left: originLeft + (index % columns) * cellWidth,
    top: originTop + Math.floor(index / columns) * cellHeight,
  }))
}