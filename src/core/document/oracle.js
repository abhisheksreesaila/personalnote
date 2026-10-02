// Test support: where things end up on the page, worked out with real Fabric's own matrix maths, for Fabric JSON and for
// document-model objects. Two objects that put the same points in the same places render the same. Not imported by the app.
import { Circle, FabricImage, FabricObject, Group, IText, Path, Rect, Textbox, util } from 'fabric'
import { Connector } from '../../modules/editor/connector-object.js'
import { Sticky } from '../../modules/editor/sticky-object.js'

const IDENTITY = [1, 0, 0, 1, 0, 0]
const PLACEMENT = ['left', 'top', 'width', 'height', 'angle', 'scaleX', 'scaleY', 'flipX', 'flipY', 'skewX', 'skewY', 'originX', 'originY', 'strokeWidth', 'strokeUniform']
// What each saved type really defaults to is read from the real Fabric (and app) classes, not restated here.
const CLASSES = { IText, Textbox, Sticky, Rect, Circle, Path, Group, Image: FabricImage, Connector }
const defaultStrokeWidth = (type) => (CLASSES[type] ?? FabricObject).getDefaults().strokeWidth
const placement = (raw) => ({ strokeWidth: defaultStrokeWidth(raw.type), ...Object.fromEntries(PLACEMENT.filter((key) => Object.hasOwn(raw, key)).map((key) => [key, raw[key]])) })
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function coordinatePairs(path) {
  const pairs = []
  for (const command of path) for (let i = 1; i + 1 < command.length; i += 2) pairs.push({ x: command[i], y: command[i + 1] })
  return pairs
}

const corners = (width, height) => [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]].map(([x, y]) => ({ x, y }))

function emit(points, matrix, out) {
  for (const point of points) {
    const moved = util.transformPoint(point, matrix)
    out.push(moved.x, moved.y)
  }
}

// Page positions of every modelled object's box corners, ink path points and ink points, in stacking order. Fabric JSON in.
export function fabricPoints(objects, parent = IDENTITY, out = []) {
  for (const raw of objects) {
    if (!isObject(raw)) continue
    const isInk = raw.type === 'Path' && raw.isInk === true
    if (!['IText', 'Textbox', 'Sticky', 'Rect', 'Circle', 'Image', 'Connector', 'Group'].includes(raw.type) && !isInk) continue
    const real = isInk ? new Path(raw.path, placement(raw)) : new FabricObject(placement(raw))
    const matrix = util.multiplyTransformMatrices(parent, real.calcOwnMatrix())
    emit(corners(real.width, real.height), matrix, out)
    if (isInk) {
      const offset = real.pathOffset
      emit([...coordinatePairs(raw.path), ...(raw.inkPoints ?? [])].map((p) => ({ x: p.x - offset.x, y: p.y - offset.y })), matrix, out)
    }
    if (raw.type === 'Group') fabricPoints(raw.objects, matrix, out)
  }
  return out
}

// The same positions, from the model alone: no origins, no pathOffset, no group-centre rule.
export function modelPoints(objects, parent = IDENTITY, out = []) {
  for (const object of objects) {
    if (object.type === 'unknown') continue
    const g = object.geometry ?? {}
    const width = g.width ?? 0
    const height = g.height ?? 0
    const matrix = util.multiplyTransformMatrices(parent, util.composeMatrix({
      angle: g.rotation ?? 0, translateX: (g.x ?? 0) + width / 2, translateY: (g.y ?? 0) + height / 2,
      scaleX: g.scaleX ?? 1, scaleY: g.scaleY ?? 1, flipX: g.flipX ?? false, flipY: g.flipY ?? false, skewX: g.skewX ?? 0, skewY: g.skewY ?? 0,
    }))
    emit(corners(width, height), matrix, out)
    if (object.type === 'ink' && object.kind === 'stroke') {
      emit([...coordinatePairs(object.path), ...(object.points ?? [])].map((p) => ({ x: p.x - width / 2, y: p.y - height / 2 })), matrix, out)
    }
    if (object.type === 'group') {
      const toChildren = util.multiplyTransformMatrices(matrix, [1, 0, 0, 1, -width / 2, -height / 2])
      modelPoints([...object.children].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)), toChildren, out)
    }
  }
  return out
}

const GEOMETRIC_KEYS = new Set(['left', 'top', 'width', 'height', 'angle', 'scaleX', 'scaleY', 'flipX', 'flipY', 'skewX', 'skewY', 'originX', 'originY', 'path', 'inkPoints'])

// The Fabric JSON with its placement properties removed, for comparing everything else exactly.
export function withoutPlacement(value) {
  if (Array.isArray(value)) return value.map(withoutPlacement)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !GEOMETRIC_KEYS.has(key)).map(([key, item]) => [key, withoutPlacement(item)]))
}
