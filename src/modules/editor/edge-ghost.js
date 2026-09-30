// While an object is dragged toward the edge of the page grid, the page that would be added
// is previewed. `bounds` are the object's world-space extents; `reach` is how close to an edge
// (in world px) the preview starts. Returns the ghost page rectangle and its page number, or null.

export function nextPageGhost(bounds, { columns, rows, pageW, pageH, reach }) {
  const width = columns * pageW
  const height = rows * pageH
  const centerX = (bounds.left + bounds.right) / 2
  const centerY = (bounds.top + bounds.bottom) / 2
  const column = Math.min(columns - 1, Math.max(0, Math.floor(centerX / pageW)))
  const row = Math.min(rows - 1, Math.max(0, Math.floor(centerY / pageH)))
  const total = columns * rows

  const candidates = [
    { depth: bounds.right - (width - reach), rect: { left: width, top: row * pageH }, pageNumber: total + 1 },
    { depth: bounds.bottom - (height - reach), rect: { left: column * pageW, top: height }, pageNumber: total + 1 },
    { depth: reach - bounds.left, rect: { left: -pageW, top: row * pageH }, pageNumber: 1 },
    { depth: reach - bounds.top, rect: { left: column * pageW, top: -pageH }, pageNumber: 1 },
  ].filter((candidate) => candidate.depth > 0)
  if (!candidates.length) return null

  const best = candidates.reduce((winner, candidate) => (candidate.depth > winner.depth ? candidate : winner))
  return { rect: { ...best.rect, width: pageW, height: pageH }, pageNumber: best.pageNumber }
}
