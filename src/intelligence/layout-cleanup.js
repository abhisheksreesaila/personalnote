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

function overlaps(left, right, padding = 0) {
  return !(
    left.left + left.width + padding <= right.left
    || right.left + right.width + padding <= left.left
    || left.top + left.height + padding <= right.top
    || right.top + right.height + padding <= left.top
  )
}

export function planObstacleAwareLayout(
  items,
  { obstacles = [], maxWidth = 760, maxHeight = 1080, gapX = 28, gapY = 22, padding = 18 } = {},
) {
  if (!Array.isArray(items) || items.length < 2) return []
  const ordered = [...items].sort((left, right) => left.top - right.top || left.left - right.left)
  const originLeft = Math.max(padding, Math.min(...ordered.map(item => item.left)))
  const originTop = Math.max(padding, Math.min(...ordered.map(item => item.top)))
  const cellWidth = Math.max(...ordered.map(item => item.width)) + gapX
  const cellHeight = Math.max(...ordered.map(item => item.height)) + gapY
  const columns = Math.max(1, Math.floor((maxWidth - originLeft + gapX) / cellWidth))
  const placed = []

  for (const item of ordered) {
    let target = null
    const maxRows = Math.max(1, Math.ceil((maxHeight - originTop) / cellHeight))
    for (let slot = 0; slot < columns * maxRows; slot += 1) {
      const candidate = {
        id: item.id,
        left: originLeft + (slot % columns) * cellWidth,
        top: originTop + Math.floor(slot / columns) * cellHeight,
        width: item.width,
        height: item.height,
      }
      const blocked = obstacles.some(obstacle => overlaps(candidate, obstacle, padding))
        || placed.some(previous => overlaps(candidate, previous, gapY / 2))
      if (!blocked) {
        target = candidate
        break
      }
    }
    placed.push(target || { ...item })
  }

  return placed.map(({ id, left, top }) => ({ id, left, top }))
}