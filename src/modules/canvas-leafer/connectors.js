// Connectors on the document model (F-032), as pure functions: no Leafer, no DOM, tested in Node. A connector joins two top-level objects by
// id (`fromId`, `toId`); its own geometry is derived data, the box between the two ends and two direction flags (`reverseX`, `reverseY`),
// exactly as the Fabric path stores it, so that translating the box translates the arrow. Whenever an end moves, is resized, turned or its
// words change, the connector's box is worked out again from the two objects' bounding rects (bounds.js: the rects Fabric measures).
// The geometry rules are the Fabric path's (modules/editor/connectors.js); this file applies them to the model.
import { arrowHeadPoints, connectorBox, connectorEndpoints, distanceToSegment, endpointsFromBox } from '../editor/connectors.js'
import { boundingRect } from './bounds.js'

export const CONNECTOR_HEAD = 15
export const CONNECTOR_HIT = 9 // page pixels at zoom 1 (divided by the zoom, like Fabric's HIT_TOLERANCE)
export const CONNECTOR_DEFAULTS = { lineWidth: 2.6, color: '#20201e' }

const isConnector = (object) => object?.type === 'connector'
const UPRIGHT = { rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const close = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-9

// A document's objects by id (top-level, with an id).
export const indexById = (objects) => new Map(objects.filter((object) => object && object.id !== undefined).map((object) => [object.id, object]))

// The rect of a connector's end object: `rectOf(object)` is the host's (it knows measured text sizes).
export const rectOfObject = (object, sizeOf) => boundingRect(object, sizeOf?.(object) ?? {})

// What a connector between two rects looks like: { geometry: { x, y, width, height }, reverseX, reverseY, visible }. `visible` is false when the
// two objects overlap or are too close to show an arrow; the box then stays where it was (the arrow is simply not drawn).
export function connectorLayout(fromRect, toRect) {
  const ends = connectorEndpoints(fromRect, toRect)
  if (!ends.visible) return { visible: false }
  const box = connectorBox(ends.start, ends.end)
  return { visible: true, geometry: { x: box.left, y: box.top, width: box.width, height: box.height }, reverseX: box.reverseX, reverseY: box.reverseY }
}

// The connector object with `layout` applied, or the same object when nothing changes (no churn in the history).
export function withLayout(connector, layout) {
  if (!layout.visible) {
    if (connector.visible === false) return connector
    return { ...connector, visible: false }
  }
  const g = connector.geometry ?? {}
  const same = close(g.x, layout.geometry.x) && close(g.y, layout.geometry.y) && close(g.width, layout.geometry.width) && close(g.height, layout.geometry.height)
    && (connector.reverseX ?? false) === layout.reverseX && (connector.reverseY ?? false) === layout.reverseY && connector.visible !== false
  if (same) return connector
  const next = { ...connector, geometry: { ...UPRIGHT, ...g, ...layout.geometry }, reverseX: layout.reverseX, reverseY: layout.reverseY }
  if (next.visible === false) delete next.visible
  return next
}

// The changes that bring connectors back in line with their ends. `ids` limits it to the connectors touching those objects (null: all).
// `objects` is the document's object list; `rectOf(object)` its rects. A connector whose end is gone is not touched here (see danglingChanges).
export function followChanges(objects, ids, rectOf) {
  const byId = indexById(objects)
  const wanted = ids ? new Set(ids) : null
  const changes = []
  for (const object of objects) {
    if (!isConnector(object)) continue
    if (wanted && !wanted.has(object.fromId) && !wanted.has(object.toId)) continue
    const from = byId.get(object.fromId)
    const to = byId.get(object.toId)
    if (!from?.geometry || !to?.geometry || isConnector(from) || isConnector(to)) continue
    const next = withLayout(object, connectorLayout(rectOf(from), rectOf(to)))
    if (next !== object) changes.push({ id: object.id, before: object, after: next })
  }
  return changes
}

// Connectors whose end is not in the document any more (or that join an object to itself): they go with it.
export function danglingChanges(objects) {
  const byId = indexById(objects)
  return objects
    .filter((object) => isConnector(object) && (object.fromId === object.toId || !byId.has(object.fromId) || !byId.has(object.toId)))
    .map((object) => ({ id: object.id, before: object, after: null }))
}

export const newConnectorId = () => `res_${globalThis.crypto.randomUUID().replaceAll('-', '')}`

// A new connector from one object to another, or null when there is nothing to show (the same object, an end that is itself a connector,
// the two already joined that way, or the objects so close that no arrow fits).
export function newConnector(objects, { id = newConnectorId(), fromId, toId, color, z, rectOf }) {
  if (!fromId || !toId || fromId === toId) return null
  const byId = indexById(objects)
  const from = byId.get(fromId)
  const to = byId.get(toId)
  if (!from?.geometry || !to?.geometry || isConnector(from) || isConnector(to)) return null
  if (objects.some((object) => isConnector(object) && object.fromId === fromId && object.toId === toId)) return null
  const layout = connectorLayout(rectOf(from), rectOf(to))
  if (!layout.visible) return null
  return {
    type: 'connector', id, z, fromId, toId, color: color ?? CONNECTOR_DEFAULTS.color, lineWidth: CONNECTOR_DEFAULTS.lineWidth,
    reverseX: layout.reverseX, reverseY: layout.reverseY, arrowheads: { start: false, end: true },
    geometry: { ...UPRIGHT, ...layout.geometry },
    opacity: 1, visible: true, strokeUniform: false, extras: {},
  }
}

// The two ends of a stored connector, in page coordinates.
export function endpointsOf(connector) {
  const g = connector.geometry
  return endpointsFromBox({ left: g.x, top: g.y, width: g.width, height: g.height, reverseX: connector.reverseX ?? false, reverseY: connector.reverseY ?? false })
}

// An arrow from `start` to `end` as one path: a line to the base of the head, and the head (a filled triangle). Same drawing as the Fabric
// path's drawArrow (modules/editor/connector-object.js).
export function arrowPathFrom(start, end) {
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  const [tip, wingA, wingB] = arrowHeadPoints(start, end, Math.min(CONNECTOR_HEAD, length * 0.6))
  const tail = { x: (wingA.x + wingB.x) / 2, y: (wingA.y + wingB.y) / 2 }
  return `M ${start.x} ${start.y} L ${tail.x} ${tail.y} M ${tip.x} ${tip.y} L ${wingA.x} ${wingA.y} L ${wingB.x} ${wingB.y} Z`
}

// The arrow's drawing in its own box frame (origin at the box's top-left).
export function arrowPath(connector) {
  const g = connector.geometry
  const { start, end } = endpointsFromBox({ left: 0, top: 0, width: g.width, height: g.height, reverseX: connector.reverseX ?? false, reverseY: connector.reverseY ?? false })
  return arrowPathFrom(start, end)
}

// The topmost connector whose line passes within `tolerance` page pixels of the point, or null. Only the line is hit, never the whole
// diagonal box; a hidden one cannot be picked.
export function connectorAt(objects, point, tolerance) {
  let found = null
  let best = -Infinity
  objects.forEach((object, index) => {
    if (!isConnector(object) || object.visible === false || !object.geometry) return
    const { start, end } = endpointsOf(object)
    const distance = distanceToSegment(point, start, end)
    const rank = object.z ?? index
    if (distance <= tolerance && (!found || rank >= best)) { found = object; best = rank }
  })
  return found
}
