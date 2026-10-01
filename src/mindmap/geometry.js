// Pure branch geometry: one-bend organic curves and tapered ribbons. Derived from node
// positions on every render, so saved map JSON never stores it.
export const PORT_VECTORS = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}
const INSET = { start: 30, end: 2 }

// Where a ray from the frame's centre toward (tx, ty) leaves its rectangle.
function attach(frame, tx, ty, inset) {
  if (frame.pin) return { x: frame.x, y: frame.y + 5 }
  const dx = tx - frame.x
  const dy = ty - frame.y
  const length = Math.hypot(dx, dy) || 1
  const t = Math.min(frame.hw / (Math.abs(dx) || 1e-9), frame.hh / (Math.abs(dy) || 1e-9))
  const reach = (t * length - Math.min(inset, 0.6 * t * length)) / length
  return { x: frame.x + dx * reach, y: frame.y + dy * reach }
}

const smooth = (value, low, high) => {
  const x = Math.min(1, Math.max(0, (value - low) / (high - low)))
  return x * x * (3 - 2 * x)
}

// A saved port is only a creation hint. Its edge midpoint is blended with the computed facing
// point by a weight that fades in smoothly as the port comes to face the other node and the
// chord from it heads outward, so attachment points never snap while a node is dragged.
function portPoint(frame, name, ray, otherCentre, otherRay, inset) {
  const vector = PORT_VECTORS[name]
  if (!vector || frame.pin) return ray
  const dx = otherCentre.x - frame.x
  const dy = otherCentre.y - frame.y
  const point = { x: frame.x + vector.x * (frame.hw - inset), y: frame.y + vector.y * (frame.hh - inset) }
  const chord = Math.hypot(otherRay.x - point.x, otherRay.y - point.y) || 1
  const weight = smooth((vector.x * dx + vector.y * dy) / (Math.hypot(dx, dy) || 1), 0.3, 0.8) * smooth(((otherRay.x - point.x) * vector.x + (otherRay.y - point.y) * vector.y) / chord, 0, 0.5)
  return { x: ray.x + (point.x - ray.x) * weight, y: ray.y + (point.y - ray.y) * weight, vector, weight }
}

const lerpAnchor = (s, e, { t, n }) => ({ x: s.x + (e.x - s.x) * t - (e.y - s.y) * n, y: s.y + (e.y - s.y) * t + (e.x - s.x) * n })

/**
 * Both control points sit on the same side of the chord, so the curve bends once.
 * The side is mirrored left/right and fades to a straight line directly above or below,
 * which keeps it continuous while a node is dragged around its parent.
 */
export function branchGeometry(parent, child, { curve = 78, anchors = null, sourcePort = null, targetPort = null } = {}) {
  let s = attach(parent, child.x, child.y, INSET.start)
  let e = attach(child, parent.x, parent.y, INSET.end)
  const s0 = s
  s = portPoint(parent, sourcePort, s0, child, e, 12)
  e = portPoint(child, targetPort, e, parent, s0, 1)
  const length = Math.hypot(e.x - s.x, e.y - s.y) || 1
  const cx = (e.x - s.x) / length
  const cy = (e.y - s.y) / length
  let side = Math.tanh(2.2 * cx) * (0.04 + (curve / 100) * 0.26)
  // On a port edge the curve must not turn back into the node: keep it leaving/arriving outward.
  const free = side
  if (s.vector) {
    const along = Math.max(0, cx * s.vector.x + cy * s.vector.y)
    const across = -cy * s.vector.x + cx * s.vector.y
    if (0.3 * along + side * across < 0) side = free + ((-0.3 * along) / across - free) * s.weight
  }
  if (e.vector) {
    const along = Math.min(0, cx * e.vector.x + cy * e.vector.y)
    const across = -cy * e.vector.x + cx * e.vector.y
    if (side * across < 0.3 * along) side += ((0.3 * along) / across - side) * e.weight
  }
  const controls = (anchors?.length === 2 ? anchors : [{ t: 0.3, n: side }, { t: 0.7, n: side }]).map((anchor) => lerpAnchor(s, e, anchor))
  return { sx: s.x, sy: s.y, ex: e.x, ey: e.y, controls }
}

const axis = (a, b, c, d, t, order) => {
  const u = 1 - t
  if (order === 0) return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
  if (order === 1) return 3 * (u * u * (b - a) + 2 * u * t * (c - b) + t * t * (d - c))
  return 6 * (u * (c - 2 * b + a) + t * (d - 2 * c + b))
}

/** Point (order 0), velocity (1) or acceleration (2) of the cubic at t. */
export function cubicAt({ sx, sy, ex, ey, controls: [a, b] }, t, order = 0) {
  return { x: axis(sx, a.x, b.x, ex, t, order), y: axis(sy, a.y, b.y, ey, t, order) }
}

/** Filled outline: offset along the normal, width falling steadily from `start` to `end`, never wider than the bend allows. */
export function ribbonOutline({ sx, sy, ex, ey, controls: [a, b] }, { start, end }, samples = 36) {
  const widths = new Array(samples + 1)
  const outline = new Array(2 * samples + 2)
  let previous = Infinity
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const px = axis(sx, a.x, b.x, ex, t, 0)
    const py = axis(sy, a.y, b.y, ey, t, 0)
    const dx = axis(sx, a.x, b.x, ex, t, 1)
    const dy = axis(sy, a.y, b.y, ey, t, 1)
    const speed = Math.hypot(dx, dy)
    const curvature = Math.abs(dx * axis(sy, a.y, b.y, ey, t, 2) - dy * axis(sx, a.x, b.x, ex, t, 2)) / speed ** 3
    previous = Math.min(start + (end - start) * t, Math.max(end, 1.8 / curvature), previous)
    widths[i] = previous
    const nx = (-dy / speed) * previous / 2
    const ny = (dx / speed) * previous / 2
    outline[i] = { x: px + nx, y: py + ny }
    outline[2 * samples + 1 - i] = { x: px - nx, y: py - ny }
  }
  return { outline, widths }
}

export function ribbonPath(geometry, widths) {
  const fmt = (p) => `${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`
  return `M ${ribbonOutline(geometry, widths).outline.map(fmt).join(' L ')} Z`
}
