// Geometry for the document model: the only place that knows Fabric's placement rules (origins, stroke-inclusive bounding
// boxes, rotation about the origin point, path offsets). Pure maths, no Fabric import. The functions mirror Fabric 7.4's
// ObjectGeometry and Path code, and geometry.test.js checks them against real Fabric objects.

const PI_BY_180 = Math.PI / 180
const HALF_PI = Math.PI / 2
const toRadians = (degrees) => degrees * PI_BY_180

// Fabric special-cases exact quarter turns so 90 degrees gives exact 0 and 1, not 6e-17.
function cosine(radians) {
  if (radians === 0) return 1
  switch (Math.abs(radians) / HALF_PI) {
    case 1: case 3: return 0
    case 2: return -1
    default: return Math.cos(radians)
  }
}
function sine(radians) {
  if (radians === 0) return 0
  const sign = Math.sign(radians)
  switch (radians / HALF_PI) {
    case 1: return sign
    case 2: return 0
    case 3: return -sign
    default: return Math.sin(radians)
  }
}

export function rotatePoint(point, radians, origin) {
  const sin = sine(radians)
  const cos = cosine(radians)
  const x = point.x - origin.x
  const y = point.y - origin.y
  return { x: x * cos - y * sin + origin.x, y: x * sin + y * cos + origin.y }
}

const ORIGINS = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 }
export const originNumber = (origin) => (typeof origin === 'number' ? origin : ORIGINS[origin] ?? 0.5)

// Size of the object's bounding box as Fabric measures it: the box plus its stroke, after scale and skew (not rotation).
export function transformedDimensions({ width = 0, height = 0, strokeWidth = 0, strokeUniform = false, scaleX = 1, scaleY = 1, skewX = 0, skewY = 0 }) {
  const pre = strokeUniform ? 0 : strokeWidth
  const post = strokeUniform ? strokeWidth : 0
  const dimX = width + pre
  const dimY = height + pre
  if (skewX === 0 && skewY === 0) return { x: dimX * scaleX + post, y: dimY * scaleY + post }
  let m = [scaleX, 0, 0, scaleY]
  const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3]]
  if (skewX) m = multiply(m, [1, 0, Math.tan(toRadians(skewX)), 1])
  if (skewY) m = multiply(m, [1, Math.tan(toRadians(skewY)), 0, 1])
  const halfX = dimX / 2
  const halfY = dimY / 2
  const xs = []
  const ys = []
  for (const [px, py] of [[-halfX, -halfY], [halfX, -halfY], [-halfX, halfY], [halfX, halfY]]) {
    xs.push(m[0] * px + m[2] * py)
    ys.push(m[1] * px + m[3] * py)
  }
  return { x: Math.max(...xs) - Math.min(...xs) + post, y: Math.max(...ys) - Math.min(...ys) + post }
}

// Fabric positions an object by the point at (originX, originY) of its bounding box; rotation turns the object about its centre.
export function centerFromOrigin({ left, top, originX, originY, angle, dimensions }) {
  const point = { x: left + (0.5 - originNumber(originX)) * dimensions.x, y: top + (0.5 - originNumber(originY)) * dimensions.y }
  return angle ? rotatePoint(point, toRadians(angle), { x: left, y: top }) : point
}

// Extremes of a cubic Bezier, as Fabric's getBoundsOfCurve finds them.
function curveBounds(begX, begY, cp1X, cp1Y, cp2X, cp2Y, endX, endY) {
  const ts = []
  let b = 6 * begX - 12 * cp1X + 6 * cp2X
  let a = -3 * begX + 9 * cp1X - 9 * cp2X + 3 * endX
  let c = 3 * cp1X - 3 * begX
  for (let axis = 0; axis < 2; axis += 1) {
    if (axis > 0) {
      b = 6 * begY - 12 * cp1Y + 6 * cp2Y
      a = -3 * begY + 9 * cp1Y - 9 * cp2Y + 3 * endY
      c = 3 * cp1Y - 3 * begY
    }
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) < 1e-12) continue
      const t = -c / b
      if (t > 0 && t < 1) ts.push(t)
      continue
    }
    const b2ac = b * b - 4 * c * a
    if (b2ac < 0) continue
    const root = Math.sqrt(b2ac)
    const t1 = (-b + root) / (2 * a)
    if (t1 > 0 && t1 < 1) ts.push(t1)
    const t2 = (-b - root) / (2 * a)
    if (t2 > 0 && t2 < 1) ts.push(t2)
  }
  const xs = [begX, endX]
  const ys = [begY, endY]
  for (const t of ts) {
    const u = 1 - t
    xs.push(u * u * u * begX + 3 * u * u * t * cp1X + 3 * u * t * t * cp2X + t * t * t * endX)
    ys.push(u * u * u * begY + 3 * u * u * t * cp1Y + 3 * u * t * t * cp2Y + t * t * t * endY)
  }
  return [{ x: Math.min(...xs), y: Math.min(...ys) }, { x: Math.max(...xs), y: Math.max(...ys) }]
}

const ARGUMENT_COUNT = { M: 2, L: 2, Q: 4, C: 6, Z: 0 }
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// True when every command is one this model can shift and measure: absolute M, L, Q, C and Z with numeric arguments.
export function isSimplePath(path) {
  return Array.isArray(path) && path.every((command) => Array.isArray(command)
    && Object.hasOwn(ARGUMENT_COUNT, command[0])
    && command.length === ARGUMENT_COUNT[command[0]] + 1
    && command.slice(1).every(isNumber))
}

// The bounding box Fabric gives a Path (its width, height and pathOffset come from this), quirks included: a Q is measured as a
// cubic whose two control points are the Q's one, and an L is measured from the start of its sub-path.
export function pathBounds(path) {
  const points = []
  let startX = 0
  let startY = 0
  let x = 0
  let y = 0
  for (const command of path) {
    switch (command[0]) {
      case 'L':
        x = command[1]; y = command[2]
        points.push({ x: startX, y: startY }, { x, y })
        break
      case 'M':
        x = command[1]; y = command[2]; startX = x; startY = y
        break
      case 'C':
        points.push(...curveBounds(x, y, command[1], command[2], command[3], command[4], command[5], command[6]))
        x = command[5]; y = command[6]
        break
      case 'Q':
        points.push(...curveBounds(x, y, command[1], command[2], command[1], command[2], command[3], command[4]))
        x = command[3]; y = command[4]
        break
      default: // Z
        x = startX; y = startY
    }
  }
  let left = 0
  let top = 0
  let right = 0
  let bottom = 0
  points.forEach((point, index) => {
    if (point.x > right || !index) right = point.x
    if (point.x < left || !index) left = point.x
    if (point.y > bottom || !index) bottom = point.y
    if (point.y < top || !index) top = point.y
  })
  return { left, top, width: right - left, height: bottom - top }
}

export function shiftPath(path, dx, dy) {
  return path.map((command) => command.map((value, index) => (index === 0 ? value : value + (index % 2 === 1 ? dx : dy))))
}

// The model's own stroke width (it lives under a different name per type), with the old engine's default when the note had none:
// none for a group, a picture and a connector, 1 for the rest.
export function strokeWidthOfModel(object) {
  const stored = object.type === 'shape' ? object.strokeWidth : object.type === 'ink' && object.kind === 'stroke' ? object.width : object.extras?.strokeWidth
  return typeof stored === 'number' && Number.isFinite(stored) ? stored : ['group', 'image', 'connector'].includes(object.type) ? 0 : 1
}
