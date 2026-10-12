// How ink looks: the pens, smooth paths, shapes and text objects as SVG and DOM. Shared by marks (ink.js) and drawings (drawings.js).

export const SVG = 'http://www.w3.org/2000/svg'
export const TOOLS = {
  pen: { label: 'Pen', color: '#1d3f9e', width: 2.4, opacity: 1 },
  red: { label: 'Red', color: '#d23b26', width: 2.6, opacity: 1 },
  highlight: { label: 'Highlighter', color: '#ffd400', width: 16, opacity: 0.38 },
}
// Word-art text sizes, in px.
export const TEXT_SIZES = { s: 18, m: 28, l: 44, xl: 72 }
export const INK_COLOR = '#1f1b16'

export const round = (value) => Math.round(value * 10) / 10

// A smooth path through the points (quadratic curves through the midpoints).
export function pathOf(points) {
  if (!points.length) return ''
  const [x0, y0] = points[0]
  if (points.length === 1) return `M${x0} ${y0} l0.1 0`
  let d = `M${x0} ${y0}`
  for (let i = 1; i < points.length - 1; i += 1) {
    const [x, y] = points[i]
    const [nx, ny] = points[i + 1]
    d += ` Q${x} ${y} ${round((x + nx) / 2)} ${round((y + ny) / 2)}`
  }
  const [xl, yl] = points[points.length - 1]
  return `${d} L${xl} ${yl}`
}

export function bounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  return { minX, minY, maxX, maxY }
}

export function strokeElement(tool, points) {
  const style = TOOLS[tool] ?? TOOLS.pen
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', pathOf(points))
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', style.color)
  path.setAttribute('stroke-width', style.width)
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  path.setAttribute('opacity', style.opacity)
  if (tool === 'highlight') path.style.mixBlendMode = 'multiply'
  return path
}

// A rectangle or ellipse item { kind, x, y, w, h, color }, drawn as a hand-held outline.
export function shapeElement(item) {
  const shape = document.createElementNS(SVG, item.kind === 'ellipse' ? 'ellipse' : 'rect')
  if (item.kind === 'ellipse') {
    shape.setAttribute('cx', round(item.x + item.w / 2))
    shape.setAttribute('cy', round(item.y + item.h / 2))
    shape.setAttribute('rx', round(Math.max(1, item.w / 2)))
    shape.setAttribute('ry', round(Math.max(1, item.h / 2)))
  } else {
    shape.setAttribute('x', item.x)
    shape.setAttribute('y', item.y)
    shape.setAttribute('width', Math.max(1, item.w))
    shape.setAttribute('height', Math.max(1, item.h))
    shape.setAttribute('rx', 8)
  }
  shape.setAttribute('fill', 'none')
  shape.setAttribute('stroke', item.color || TOOLS.pen.color)
  shape.setAttribute('stroke-width', 2.4)
  shape.setAttribute('stroke-linejoin', 'round')
  return shape
}
