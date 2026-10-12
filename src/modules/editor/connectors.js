// Pure connector geometry. No DOM: endpoints are plain
// bounding rectangles ({ left, top, width, height }) in canvas coordinates.

export const CONNECTOR_GAP = 6
export const CONNECTOR_MIN_LENGTH = 6

const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })

// Where the ray from a rectangle's centre toward `toward` leaves the rectangle.
function edgePoint(rect, toward) {
  const c = center(rect)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  const halfW = Math.max(rect.width / 2, 1e-6)
  const halfH = Math.max(rect.height / 2, 1e-6)
  const scale = 1 / Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH, 1e-9)
  return { x: c.x + dx * scale, y: c.y + dy * scale }
}

// Edge-to-edge endpoints between two bounding boxes, each pulled back by `gap`.
// `visible` is false when the boxes overlap or are too close to show an arrow.
export function connectorEndpoints(fromRect, toRect, gap = CONNECTOR_GAP) {
  const a = center(fromRect)
  const b = center(toRect)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const distance = Math.hypot(dx, dy)
  if (distance < 1e-6) return { start: a, end: b, visible: false }
  const ux = dx / distance
  const uy = dy / distance
  const fromEdge = edgePoint(fromRect, b)
  const toEdge = edgePoint(toRect, a)
  const start = { x: fromEdge.x + ux * gap, y: fromEdge.y + uy * gap }
  const end = { x: toEdge.x - ux * gap, y: toEdge.y - uy * gap }
  const length = (end.x - start.x) * ux + (end.y - start.y) * uy
  return { start, end, visible: length >= CONNECTOR_MIN_LENGTH }
}

// A connector is stored as a box plus two direction flags, so translating the box
// (as page prepend compensation does) translates the arrow with it.
export function connectorBox(start, end) {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    width: Math.max(Math.abs(end.x - start.x), 1),
    height: Math.max(Math.abs(end.y - start.y), 1),
    reverseX: end.x < start.x,
    reverseY: end.y < start.y,
  }
}

export function endpointsFromBox({ left, top, width, height, reverseX, reverseY }) {
  const x1 = reverseX ? left + width : left
  const x2 = reverseX ? left : left + width
  const y1 = reverseY ? top + height : top
  const y2 = reverseY ? top : top + height
  return { start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

// [tip, wingA, wingB] of an arrowhead pointing from `start` toward `end`.
export function arrowHeadPoints(start, end, size, spread = Math.PI / 7) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const wing = (offset) => ({
    x: end.x - size * Math.cos(angle + offset),
    y: end.y - size * Math.sin(angle + offset),
  })
  return [{ x: end.x, y: end.y }, wing(-spread), wing(spread)]
}

export function distanceToSegment(point, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}
