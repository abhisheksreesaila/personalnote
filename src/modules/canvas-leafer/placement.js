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
