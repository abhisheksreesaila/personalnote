// Pure geometry for the window-sized canvas. The Fabric canvas is always as big
// as the workspace; these helpers decide where the page grid sits inside it.

export function viewMargins(windowWidth) {
  if (windowWidth <= 560) return { left: 12, right: 12, top: 88, bottom: 96 }
  if (windowWidth <= 800) return { left: 12, right: 12, top: 64, bottom: 112 }
  return { left: 140, right: 140, top: 92, bottom: 180 }
}

function clampAxis(offset, viewSize, contentSize, before, after) {
  if (contentSize + before + after <= viewSize) {
    return before === after ? (viewSize - contentSize) / 2 : before
  }
  return Math.min(before, Math.max(viewSize - after - contentSize, offset))
}

// Mirrors the scroll range the old page-sized canvas had: centred when the grid
// fits, otherwise pannable from its leading margin to its trailing margin.
export function clampView(view, { viewW, viewH, contentW, contentH, scale, margins }) {
  return {
    x: clampAxis(view.x, viewW, contentW * scale, margins.left, margins.right),
    y: clampAxis(view.y, viewH, contentH * scale, margins.top, margins.bottom),
  }
}

export function zoomAtPoint(view, nextScale, point) {
  const worldX = (point.x - view.x) / view.scale
  const worldY = (point.y - view.y) / view.scale
  return { x: point.x - worldX * nextScale, y: point.y - worldY * nextScale, scale: nextScale }
}

export function pageExtents(columns, rows, pageWidth, pageHeight) {
  return { left: 0, top: 0, right: columns * pageWidth, bottom: rows * pageHeight }
}

export function shiftExtents(extents, dx, dy) {
  return {
    left: extents.left + dx,
    top: extents.top + dy,
    right: extents.right + dx,
    bottom: extents.bottom + dy,
  }
}

export function lerpExtents(from, to, t) {
  if (t <= 0) return { ...from }
  if (t >= 1) return { ...to }
  const mix = (a, b) => a + (b - a) * t
  return {
    left: mix(from.left, to.left),
    top: mix(from.top, to.top),
    right: mix(from.right, to.right),
    bottom: mix(from.bottom, to.bottom),
  }
}

export function easeInOut(progress) {
  const t = Math.min(1, Math.max(0, progress))
  return t * t * (3 - 2 * t)
}

export function wheelPanDelta(event) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
  let dx = event.deltaX * unit
  const dy = event.deltaY * unit
  if (event.shiftKey && !dx) return { dx: dy, dy: 0 }
  return { dx, dy }
}
