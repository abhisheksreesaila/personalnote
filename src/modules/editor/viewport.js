// Pure geometry for the window-sized canvas. The Fabric canvas is always as big
// as the workspace; these helpers decide where the page grid sits inside it.

export function viewMargins(windowWidth) {
  if (windowWidth <= 560) return { left: 12, right: 12, top: 88, bottom: 96 }
  if (windowWidth <= 800) return { left: 12, right: 12, top: 64, bottom: 112 }
  return { left: 140, right: 140, top: 92, bottom: 180 }
}

function clampAxis(offset, viewSize, contentSize, before, after, keep) {
  if (keep) return offset
  if (contentSize + before + after <= viewSize) {
    return before === after ? (viewSize - contentSize) / 2 : before
  }
  return Math.min(before, Math.max(viewSize - after - contentSize, offset))
}

// Mirrors the scroll range the old page-sized canvas had: centred when the grid
// fits, otherwise pannable from its leading margin to its trailing margin.
// `keep` skips the clamp so page growth never moves what is on screen; the next
// pan or zoom clamps again.
export function clampView(view, { viewW, viewH, contentW, contentH, scale, margins, keep = false }) {
  return {
    x: clampAxis(view.x, viewW, contentW * scale, margins.left, margins.right, keep),
    y: clampAxis(view.y, viewH, contentH * scale, margins.top, margins.bottom, keep),
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

// Splits a CSS box-shadow value (no inset) into layers a canvas can draw.
export function parseBoxShadow(value) {
  if (!value || value.trim() === 'none') return []
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i <= value.length; i += 1) {
    const ch = value[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if ((ch === ',' && depth === 0) || i === value.length) {
      parts.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  const layers = []
  for (const part of parts) {
    const color = part.match(/[a-z-]+\((?:[^()]|\([^()]*\))*\)|#[0-9a-f]{3,8}\b/i)?.[0]
    if (!color) continue
    const numbers = part.replace(color, '').trim().split(/\s+/).filter(Boolean).map((token) => parseFloat(token))
    if (numbers.length < 2 || numbers.some(Number.isNaN)) continue
    const [x, y, blur = 0, spread = 0] = numbers
    layers.push({ x, y, blur, spread, color })
  }
  return layers
}

function normalCdf(z) {
  // Abramowitz-Stegun 7.1.26 via erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const poly = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592
  const erf = 1 - poly * t * Math.exp(-(z * z) / 2)
  return 0.5 * (1 + (z >= 0 ? erf : -erf))
}

// A gaussian-blurred rectangle shadow approximated by stacked solid rectangles,
// which is far cheaper to paint than canvas shadowBlur on a window-sized surface.
// Bands go from the outermost to the innermost; each is a rect inflated by `grow`
// (CSS px) painted with `alpha` of the shadow colour.
export function shadowBands({ blur, spread, alpha: peak }, steps = 8) {
  if (blur <= 0) return [{ grow: spread, alpha: peak }]
  const sigma = blur / 2
  const bands = []
  let covered = 0
  for (let k = 0; k < steps; k += 1) {
    const edge = blur - (2 * blur * k) / (steps - 1)
    const target = peak * (1 - normalCdf(edge / sigma))
    const alpha = covered >= 1 ? 0 : Math.max(0, 1 - (1 - target) / (1 - covered))
    bands.push({ grow: spread + edge, alpha })
    covered = Math.max(covered, target)
  }
  return bands
}
