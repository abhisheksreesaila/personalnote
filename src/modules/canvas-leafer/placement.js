// Placement for the Leafer adapter: turns a document object's geometry into the one affine matrix that takes the object's own
// frame (origin at its box's top-left corner, before any transform) into its parent's frame. Only the documented rules are used
// (src/core/document/schema.js): with the box's centre c, a point p lands at c + Rotate(rotation) * Scale * SkewX * SkewY * (p - c).
// No Leafer import, so the rule is tested against the oracle without a browser.

const toRadians = (degrees) => degrees * (Math.PI / 180)

// `size` overrides the box size. A text block saved without a height has none in the model; the adapter measures the text first
// and places it from the measured box, so rotation, scale and skew turn about the real centre.
export function placementMatrix(geometry, size = {}) {
  const width = size.width ?? geometry.width ?? 0
  const height = size.height ?? geometry.height ?? 0
  const x = geometry.x ?? 0
  const y = geometry.y ?? 0
  const sx = (geometry.flipX ? -1 : 1) * (geometry.scaleX ?? 1)
  const sy = (geometry.flipY ? -1 : 1) * (geometry.scaleY ?? 1)
  const tanX = Math.tan(toRadians(geometry.skewX ?? 0))
  const tanY = Math.tan(toRadians(geometry.skewY ?? 0))
  const cos = Math.cos(toRadians(geometry.rotation ?? 0))
  const sin = Math.sin(toRadians(geometry.rotation ?? 0))
  // Scale * SkewX * SkewY, then Rotate (a, b is the first column and c, d the second, as in a canvas matrix).
  const m11 = sx * (1 + tanX * tanY)
  const m12 = sx * tanX
  const m21 = sy * tanY
  const m22 = sy
  const a = cos * m11 - sin * m21
  const c = cos * m12 - sin * m22
  const b = sin * m11 + cos * m21
  const d = sin * m12 + cos * m22
  // The box's top-left corner is (-width / 2, -height / 2) from the centre; the centre sits at (x + w/2, y + h/2) in the parent.
  const cx = x + width / 2
  const cy = y + height / 2
  return { a, b, c, d, e: cx + a * (-width / 2) + c * (-height / 2), f: cy + b * (-width / 2) + d * (-height / 2) }
}

export const applyMatrix = (m, point) => ({ x: m.a * point.x + m.c * point.y + m.e, y: m.b * point.x + m.d * point.y + m.f })

export function multiplyMatrices(outer, inner) {
  return {
    a: outer.a * inner.a + outer.c * inner.b, b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d, d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e, f: outer.b * inner.e + outer.d * inner.f + outer.f,
  }
}

// ---- the inverse (F-028) ----------------------------------------------------------------------------------------------------
// A matrix an editor produced (move, resize, turn) back into model geometry, by the same documented rule. `size` is the box the
// matrix is for; `previous` is the geometry before the edit, so what the edit did not change (turn, scale, skew, flips) is kept
// exactly instead of being re-derived with rounding noise. SkewY is not recovered (the editor never makes one).
// `bake` folds a change of scale into the box size and keeps the old scale: the way a text block or sticky resizes (wider box,
// same letters) when the editor scaled it instead of resizing it.
const EPSILON = 1e-9
const toDegrees = (radians) => radians * (180 / Math.PI)

export function geometryFromMatrix(matrix, size, previous = {}, { bake = false } = {}) {
  const { a, b, c, d } = matrix
  const width = size.width ?? previous.width ?? 0
  const height = size.height ?? previous.height ?? 0
  const centre = applyMatrix(matrix, { x: width / 2, y: height / 2 })
  const was = placementMatrix(previous, { width, height })
  const unchanged = Math.abs(a - was.a) < EPSILON && Math.abs(b - was.b) < EPSILON && Math.abs(c - was.c) < EPSILON && Math.abs(d - was.d) < EPSILON
  if (unchanged) return { ...previous, x: centre.x - width / 2, y: centre.y - height / 2, width, height }

  const flipX = previous.flipX === true
  const length = Math.hypot(a, b)
  if (length < EPSILON) return { ...previous, x: centre.x - width / 2, y: centre.y - height / 2, width, height }
  const sign = flipX ? -1 : 1
  const radians = Math.atan2(sign * b, sign * a)
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const scaleXSigned = sign * length
  const skewed = c * cos + d * sin // = scaleX * tan(skewX)
  const scaleYSigned = -c * sin + d * cos
  const next = {
    ...previous,
    rotation: toDegrees(radians),
    scaleX: length,
    scaleY: Math.abs(scaleYSigned),
    flipX,
    flipY: scaleYSigned < 0,
    skewX: toDegrees(Math.atan(skewed / scaleXSigned)),
  }
  let w = width
  let h = height
  if (bake) {
    w = width * (next.scaleX / (previous.scaleX ?? 1))
    h = height * (next.scaleY / (previous.scaleY ?? 1))
    next.scaleX = previous.scaleX ?? 1
    next.scaleY = previous.scaleY ?? 1
  }
  return { ...next, x: centre.x - w / 2, y: centre.y - h / 2, width: w, height: h }
}
