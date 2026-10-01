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
function attach(frame, tx, ty, port, inset) {
  if (frame.pin) return { x: frame.x, y: frame.y + 5 }
  if (port) return { x: frame.x + PORT_VECTORS[port].x * frame.hw, y: frame.y + PORT_VECTORS[port].y * frame.hh }
  const dx = tx - frame.x
  const dy = ty - frame.y
  const length = Math.hypot(dx, dy) || 1
  const t = Math.min(frame.hw / (Math.abs(dx) || 1e-9), frame.hh / (Math.abs(dy) || 1e-9))
  const reach = (t * length - Math.min(inset, 0.6 * t * length)) / length
  return { x: frame.x + dx * reach, y: frame.y + dy * reach }
}

const lerpAnchor = (s, e, { t, n }) => ({ x: s.x + (e.x - s.x) * t - (e.y - s.y) * n, y: s.y + (e.y - s.y) * t + (e.x - s.x) * n })

/**
 * Both control points sit on the same side of the chord, so the curve bends once.
 * The side is mirrored left/right and fades to a straight line directly above or below,
 * which keeps it continuous while a node is dragged around its parent.
 */
export function branchGeometry(parent, child, { curve = 78, anchors = null, sourcePort = null, targetPort = null } = {}) {
  const s = attach(parent, child.x, child.y, sourcePort, INSET.start)
  const e = attach(child, parent.x, parent.y, targetPort, INSET.end)
  const length = Math.hypot(e.x - s.x, e.y - s.y) || 1
  const side = Math.tanh(2.2 * (e.x - s.x) / length) * (0.04 + (curve / 100) * 0.26)
  const controls = (anchors?.length === 2 ? anchors : [{ t: 0.3, n: side }, { t: 0.7, n: side }]).map((anchor) => lerpAnchor(s, e, anchor))
  return { sx: s.x, sy: s.y, ex: e.x, ey: e.y, controls }
}

const reduce = (points, t) => (points.length < 2 ? points[0] : reduce(points.slice(1).map((q, i) => ({ x: points[i].x + (q.x - points[i].x) * t, y: points[i].y + (q.y - points[i].y) * t })), t))

/** Point (order 0), velocity (1) or acceleration (2) of the cubic at t, by de Casteljau. */
export function cubicAt({ sx, sy, ex, ey, controls }, t, order = 0) {
  let points = [{ x: sx, y: sy }, ...controls, { x: ex, y: ey }]
  for (let k = 0; k < order; k++) points = points.slice(1).map((q, i) => ({ x: (q.x - points[i].x) * (points.length - 1), y: (q.y - points[i].y) * (points.length - 1) }))
  return reduce(points, t)
}

/** Filled outline: offset along the normal, width falling steadily from `start` to `end`, never wider than the bend allows. */
export function ribbonOutline(geometry, { start, end }, samples = 36) {
  const widths = []
  const outline = []
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const p = cubicAt(geometry, t)
    const d1 = cubicAt(geometry, t, 1)
    const d2 = cubicAt(geometry, t, 2)
    const speed = Math.hypot(d1.x, d1.y)
    const curvature = Math.abs(d1.x * d2.y - d1.y * d2.x) / speed ** 3
    const width = Math.min(start + (end - start) * t, Math.max(end, 1.8 / curvature), widths[i - 1] ?? Infinity)
    widths.push(width)
    const nx = (-d1.y / speed) * width / 2
    const ny = (d1.x / speed) * width / 2
    outline.splice(i, 0, { x: p.x + nx, y: p.y + ny }, { x: p.x - nx, y: p.y - ny })
  }
  return { outline, widths }
}

export function ribbonPath(geometry, widths) {
  const fmt = (p) => `${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`
  return `M ${ribbonOutline(geometry, widths).outline.map(fmt).join(' L ')} Z`
}
