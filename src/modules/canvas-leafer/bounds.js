// Where an object is on the page, as Fabric's getBoundingRect() measures it (F-032): the box with its stroke, after scale and skew, turned
// about its centre. The page rules (growth, fold-back) and the connector ends are measured on this rect, so it is the Fabric rule, tested
// against real Fabric (bounds.test.js). Pure JS: no Leafer, no DOM.
import { rotatePoint, transformedDimensions } from '../../core/document/geometry.js'
import { strokeWidthOfModel } from '../../core/document/geometry.js'

const toRadians = (degrees) => degrees * (Math.PI / 180)

// `size` is the box size when the object does not store one (a text block the engine measured).
export function boundingRect(object, size = {}) {
  const g = object.geometry
  const width = g.width ?? size.width ?? 0
  const height = g.height ?? size.height ?? 0
  const dims = transformedDimensions({
    width, height, strokeWidth: strokeWidthOfModel(object), strokeUniform: object.strokeUniform === true,
    scaleX: g.scaleX ?? 1, scaleY: g.scaleY ?? 1, skewX: g.skewX ?? 0, skewY: g.skewY ?? 0,
  })
  const centre = { x: (g.x ?? 0) + width / 2, y: (g.y ?? 0) + height / 2 }
  const radians = toRadians(g.rotation ?? 0)
  const halfX = dims.x / 2
  const halfY = dims.y / 2
  const corners = [[-halfX, -halfY], [halfX, -halfY], [halfX, halfY], [-halfX, halfY]].map(([dx, dy]) => (radians ? rotatePoint({ x: centre.x + dx, y: centre.y + dy }, radians, centre) : { x: centre.x + dx, y: centre.y + dy }))
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

export const rectEdges = (rect) => ({ left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height })

// The union of every object's rect, as { left, top, right, bottom }, or null for an empty note. A connector is derived from its ends, so
// it never decides the page extents (nor does an object the model does not know). `sizeOf(object)` gives the measured size of a text.
export function contentBounds(objects, sizeOf = () => ({})) {
  let bounds = null
  for (const object of objects) {
    if (object?.type === 'unknown') { // not modelled: where its raw Fabric left, top, width and height put it; a page it occupies never folds
      const raw = object.raw
      if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.left) || !Number.isFinite(raw.top)) continue
      const edges = { left: raw.left, top: raw.top, right: raw.left + (Number.isFinite(raw.width) ? raw.width : 0), bottom: raw.top + (Number.isFinite(raw.height) ? raw.height : 0) }
      bounds = bounds ? { left: Math.min(bounds.left, edges.left), top: Math.min(bounds.top, edges.top), right: Math.max(bounds.right, edges.right), bottom: Math.max(bounds.bottom, edges.bottom) } : edges
      continue
    }
    if (!object?.geometry || object.type === 'connector') continue
    const edges = rectEdges(boundingRect(object, sizeOf(object)))
    bounds = bounds
      ? { left: Math.min(bounds.left, edges.left), top: Math.min(bounds.top, edges.top), right: Math.max(bounds.right, edges.right), bottom: Math.max(bounds.bottom, edges.bottom) }
      : edges
  }
  return bounds
}
