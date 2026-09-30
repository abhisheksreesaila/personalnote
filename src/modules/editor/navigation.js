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

// The view a note opens at: every page on the desk when that stays readable, otherwise the
// first page at the smallest comfortable zoom.
export function openingView(options) {
  const { viewW, viewH, contentW, contentH, margins, min, max } = options
  const freeW = viewW - margins.left - margins.right
  const freeH = viewH - margins.top - margins.bottom
  if (Math.min(freeW / contentW, freeH / contentH) < min) {
    return { scale: min, x: margins.left, y: margins.top }
  }
  return fitView(options)
}

// How many object boxes ({ left, top, width, height } in world units) touch the window at `view`.
export function objectsInView(view, viewW, viewH, boxes) {
  let count = 0
  for (const box of boxes) {
    const left = view.x + box.left * view.scale
    const top = view.y + box.top * view.scale
    if (left + box.width * view.scale > 0 && left < viewW && top + box.height * view.scale > 0 && top < viewH) count += 1
  }
  return count
}

// Candidates run from the most zoomed-out view to the most zoomed-in. Dense notes cannot pan smoothly when
// hundreds of objects are on screen, so take the first view whose load stays under `limit`. The load is the
// objects on screen now, or the average you meet while panning (objects spread evenly over `content`), whichever is more.
export function chooseOpeningView(candidates, viewW, viewH, boxes, limit, content) {
  const load = (view) => {
    const average = content
      ? boxes.length * Math.min(1, (viewW / view.scale) * (viewH / view.scale) / (content.width * content.height))
      : 0
    return Math.max(objectsInView(view, viewW, viewH, boxes), average)
  }
  return candidates.find((view) => load(view) <= limit) ?? candidates.at(-1)
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
