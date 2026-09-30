// Pure helpers behind the page minimap, zoom control and scroll indicator.
// World units are canvas pixels; a view is { x, y, scale } exactly as in viewport.js.

const ZOOM_STEP = 1.25

export function pageLabel(columns, rows) {
  const count = columns * rows
  return `${count} ${count === 1 ? 'page' : 'pages'} · ${columns} × ${rows}`
}

export function zoomPercent(scale) {
  return Math.round(scale * 100)
}

export function stepZoom(current, direction, { min, max }, ratio = ZOOM_STEP) {
  return Math.min(max, Math.max(min, current * ratio ** direction))
}

// The view that fits the whole page grid inside the window margins, centred in the free area.
export function fitView({ viewW, viewH, contentW, contentH, margins, min, max }) {
  const freeW = viewW - margins.left - margins.right
  const freeH = viewH - margins.top - margins.bottom
  const scale = Math.min(max, Math.max(min, Math.min(freeW / contentW, freeH / contentH)))
  return {
    scale,
    x: margins.left + (freeW - contentW * scale) / 2,
    y: margins.top + (freeH - contentH * scale) / 2,
  }
}

// Indexes (row-major) of the pages that intersect the window.
export function visiblePages({ view, viewW, viewH, columns, rows, pageW, pageH }) {
  const visible = new Set()
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = view.x + column * pageW * view.scale
      const top = view.y + row * pageH * view.scale
      const right = left + pageW * view.scale
      const bottom = top + pageH * view.scale
      if (right > 0 && left < viewW && bottom > 0 && top < viewH) visible.add(row * columns + column)
    }
  }
  return visible
}

export function viewForPage({ column, row, scale, viewW, viewH, pageW, pageH }) {
  return {
    x: viewW / 2 - (column + 0.5) * pageW * scale,
    y: viewH / 2 - (row + 0.5) * pageH * scale,
  }
}

function thumb(offset, viewSize, contentSize, before, after) {
  const total = contentSize + before + after
  if (total <= viewSize) return null
  const farthest = viewSize - after - contentSize
  const progress = Math.min(1, Math.max(0, (before - offset) / (before - farthest)))
  const length = viewSize / total
  return { start: progress * (1 - length), length }
}

// Where an overlay scroll indicator sits, as fractions (0-1) of its track; null when that axis does not scroll.
export function scrollThumbs({ view, viewW, viewH, contentW, contentH, margins }) {
  return {
    x: thumb(view.x, viewW, contentW * view.scale, margins.left, margins.right),
    y: thumb(view.y, viewH, contentH * view.scale, margins.top, margins.bottom),
  }
}
