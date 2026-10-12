import { centerFromOrigin, isSimplePath, pathBounds, shiftPath, transformedDimensions } from './geometry.js'
import { paletteKeyFor } from './palette.js'
import { DEFAULTS, DEFAULT_PAGE, SCHEMA_VERSION } from './schema.js'

// Fabric JSON -> document model: the reader for notes saved by the old canvas engine (Fabric.js), before JSON Canvas became the stored
// form (ADR 0002). It opens a note the server has not converted yet and reads a version 1 backup; the server does the same
// conversion in Python (document_model.py, the same rules). Pure functions over plain data; nothing here imports Fabric. This file and
// geometry.js own every Fabric convention (origins, stroke-inclusive boxes, path offsets, group-centred child coordinates), so the
// model and the engine that draws it never see them.
//
// Fabric JSON is what canvas.toJSON() wrote ({ version, objects: [...] }), plus the page state kept beside it. fromFabric moves
// every property it understands into a typed model field and leaves the rest in `extras`. The model is written out as JSON Canvas
// (jsoncanvas.js), never back as Fabric JSON. `arrowheads`, `colorKey` and `fillKey` are derived on the way in; a content object
// without an `objects` array reads as an empty one; and an ink colour is only split into colour + alpha when it is `#rrggbb`
// followed by two lowercase hex digits (what the highlighter wrote), any other spelling staying whole.

const has = (object, key) => Object.hasOwn(object, key)
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const clone = (value) => structuredClone(value)

const TEXT_STYLE = [['fontFamily', 'fontFamily'], ['fontSize', 'fontSize'], ['fontWeight', 'fontWeight'], ['fontStyle', 'fontStyle'], ['lineHeight', 'lineHeight'], ['textAlign', 'textAlign'], ['underline', 'underline'], ['overline', 'overline'], ['linethrough', 'linethrough'], ['charSpacing', 'charSpacing'], ['padding', 'padding'], ['fill', 'color']]

// Fabric key -> model key, per type. Dotted model keys are nested ('style.color').
const FIELDS = {
  text: [['text', 'content'], ...TEXT_STYLE.map(([from, to]) => [from, `style.${to}`])],
  sticky: [['text', 'content'], ['stickyColor', 'color'], ...TEXT_STYLE.map(([from, to]) => [from, `style.${to}`])],
  rect: [['rx', 'cornerRadius'], ['ry', 'cornerRadiusY'], ['fill', 'fill'], ['stroke', 'stroke'], ['strokeWidth', 'strokeWidth']],
  circle: [['radius', 'radius'], ['fill', 'fill'], ['stroke', 'stroke'], ['strokeWidth', 'strokeWidth']],
  connector: [['fromId', 'fromId'], ['toId', 'toId'], ['color', 'color'], ['lineWidth', 'lineWidth'], ['reverseX', 'reverseX'], ['reverseY', 'reverseY']],
  stroke: [['inkTool', 'tool'], ['strokeWidth', 'width'], ['globalCompositeOperation', 'blend'], ['strokeLineCap', 'cap'], ['strokeLineJoin', 'join']],
  dot: [['inkTool', 'tool'], ['radius', 'radius'], ['globalCompositeOperation', 'blend']],
}

function setPath(target, path, value) {
  const keys = path.split('.')
  const last = keys.pop()
  let node = target
  for (const key of keys) node = node[key] ??= {}
  node[last] = value
}

// Moves each listed key out of `rest` into `target`.
function take(rest, target, pairs) {
  for (const [from, to] of pairs) {
    if (!has(rest, from)) continue
    setPath(target, to, rest[from])
    delete rest[from]
  }
}

const HEX_WITH_ALPHA = /^(#[0-9a-fA-F]{6})([0-9a-f]{2})$/
function splitColor(value) {
  const match = typeof value === 'string' ? HEX_WITH_ALPHA.exec(value) : null
  return match ? { color: match[1], alpha: Number.parseInt(match[2], 16) / 255 } : { color: value }
}
// Only objects whose placement fields are all well-formed are modelled; anything odd stays verbatim as `unknown`.
const NUMERIC_PLACEMENT = ['left', 'top', 'width', 'height', 'angle', 'scaleX', 'scaleY', 'skewX', 'skewY', 'strokeWidth']
function hasCleanPlacement(raw) {
  return NUMERIC_PLACEMENT.every((key) => !has(raw, key) || isNumber(raw[key]))
    && ['flipX', 'flipY', 'strokeUniform', 'visible'].every((key) => !has(raw, key) || typeof raw[key] === 'boolean')
    && ['originX', 'originY'].every((key) => !has(raw, key) || ['left', 'center', 'right', 'top', 'bottom'].includes(raw[key]))
}

function classify(raw) {
  if (!hasCleanPlacement(raw)) return null
  switch (raw.type) {
    case 'IText': case 'Textbox': return typeof raw.text === 'string' ? 'text' : null
    case 'Sticky': return typeof raw.text === 'string' ? 'sticky' : null
    case 'Rect': return 'rect'
    case 'Circle': return raw.isInk === true ? 'dot' : 'circle'
    case 'Path': return raw.isInk === true && isSimplePath(raw.path) ? 'stroke' : null
    case 'Image': return typeof raw.src === 'string' ? 'image' : null
    case 'Connector': return 'connector'
    case 'Group': return Array.isArray(raw.objects) ? 'group' : null
    default: return null
  }
}

// Fabric's stroke width when a note does not say: none for a group, a picture and the app's connector, 1 for the rest.
const NO_STROKE_BY_DEFAULT = new Set(['Group', 'Image', 'Connector'])
const strokeWidthOfRaw = (raw, type) => (isNumber(raw.strokeWidth) ? raw.strokeWidth : NO_STROKE_BY_DEFAULT.has(type) ? 0 : 1)

const FLAT = { dx: 0, dy: 0 }

// Fabric placement -> neutral geometry: the box's top-left in the parent frame, size, and rotation/scale/flip/skew about the
// box centre. `frame` shifts a group child from Fabric's group-centred coordinates to the group's top-left.
function geometryFromFabric(rest, frame, size, fabricType) {
  const number = (key, fallback) => (has(rest, key) ? rest[key] : fallback)
  const geometry = {
    rotation: number('angle', 0), scaleX: number('scaleX', 1), scaleY: number('scaleY', 1),
    flipX: number('flipX', false), flipY: number('flipY', false), skewX: number('skewX', 0), skewY: number('skewY', 0),
  }
  const width = size ? size.width : has(rest, 'width') ? rest.width : undefined
  const height = size ? size.height : has(rest, 'height') ? rest.height : undefined
  const dimensions = transformedDimensions({
    width: width ?? 0, height: height ?? 0, strokeWidth: strokeWidthOfRaw(rest, fabricType), strokeUniform: rest.strokeUniform === true,
    scaleX: geometry.scaleX, scaleY: geometry.scaleY, skewX: geometry.skewX, skewY: geometry.skewY,
  })
  const center = centerFromOrigin({
    left: number('left', 0), top: number('top', 0), originX: number('originX', 'center'), originY: number('originY', 'center'),
    angle: geometry.rotation, dimensions,
  })
  for (const key of ['left', 'top', 'width', 'height', 'angle', 'scaleX', 'scaleY', 'flipX', 'flipY', 'skewX', 'skewY', 'originX', 'originY']) delete rest[key]
  const ordered = { x: center.x - (width ?? 0) / 2 + frame.dx, y: center.y - (height ?? 0) / 2 + frame.dy }
  if (width !== undefined) ordered.width = width
  if (height !== undefined) ordered.height = height
  return Object.assign(ordered, geometry)
}

function shadowFromFabric(rest) {
  const shadow = rest.shadow
  if (!isObject(shadow) || typeof shadow.color !== 'string' || !isNumber(shadow.blur) || !isNumber(shadow.offsetX) || !isNumber(shadow.offsetY)) return undefined
  const { color, blur, offsetX, offsetY, ...others } = shadow
  delete rest.shadow
  const model = { color, blur, x: offsetX, y: offsetY }
  if (Object.keys(others).length) model.extras = others
  return model
}

function objectFromFabric(raw, index, frame = FLAT) {
  const kind = isObject(raw) ? classify(raw) : null
  if (!kind) {
    const unknown = { type: 'unknown', z: index, raw: clone(raw) }
    if (isObject(raw) && typeof raw.semanticId === 'string') unknown.id = raw.semanticId
    return unknown
  }
  const rest = clone(raw)
  const object = { type: kind === 'rect' || kind === 'circle' ? 'shape' : kind === 'stroke' || kind === 'dot' ? 'ink' : kind, z: index }
  delete rest.type
  if (typeof rest.semanticId === 'string') { object.id = rest.semanticId; delete rest.semanticId }

  const bounds = kind === 'stroke' ? pathBounds(rest.path) : null
  object.geometry = geometryFromFabric(rest, frame, bounds, raw.type)
  take(rest, object, [['opacity', 'opacity'], ['visible', 'visible'], ['strokeUniform', 'strokeUniform']])
  const shadow = shadowFromFabric(rest)
  if (shadow) object.shadow = shadow

  if (kind === 'text') {
    object.mode = raw.type === 'IText' ? 'point' : 'box'
    take(rest, object, FIELDS.text)
  } else if (kind === 'sticky') {
    take(rest, object, FIELDS.sticky)
    const key = paletteKeyFor(object.color)
    if (key) object.colorKey = key
  } else if (kind === 'rect' || kind === 'circle') {
    object.kind = kind
    take(rest, object, FIELDS[kind])
    const key = paletteKeyFor(object.fill)
    if (key) object.fillKey = key
  } else if (kind === 'connector') {
    take(rest, object, FIELDS.connector)
    object.arrowheads = { ...DEFAULTS.connector.arrowheads }
  } else if (kind === 'image') {
    object.mediaRef = { kind: 'inline', dataUrl: rest.src }
    delete rest.src
  } else if (kind === 'group') {
    const childFrame = { dx: (object.geometry.width ?? 0) / 2, dy: (object.geometry.height ?? 0) / 2 }
    object.children = rest.objects.map((child, childIndex) => objectFromFabric(child, childIndex, childFrame))
    delete rest.objects
  } else {
    object.kind = kind
    delete rest.isInk
    take(rest, object, FIELDS[kind])
    const colorKey = kind === 'dot' ? 'fill' : 'stroke'
    if (has(rest, colorKey)) {
      const { color, alpha } = splitColor(rest[colorKey])
      object.color = color
      if (alpha !== undefined) object.alpha = alpha
      delete rest[colorKey]
    }
    if (kind === 'stroke') {
      // Path and points are stored relative to the box's top-left corner, so they do not depend on Fabric's pathOffset.
      object.path = shiftPath(rest.path, -bounds.left, -bounds.top)
      delete rest.path
      const points = rest.inkPoints
      if (Array.isArray(points) && points.every((point) => isObject(point) && isNumber(point.x) && isNumber(point.y))) {
        object.points = points.map((point) => ({ ...point, x: point.x - bounds.left, y: point.y - bounds.top }))
        delete rest.inkPoints
      }
    }
  }
  object.extras = rest
  return object
}

// Fabric content ({ version, objects }) and the note's page state -> document.
export function fromFabric(content, pageState) {
  const source = isObject(content) ? content : {}
  const extras = clone(source)
  delete extras.objects
  const objects = Array.isArray(source.objects) ? source.objects.map((raw, index) => objectFromFabric(raw, index)) : []
  const page = isObject(pageState) ? clone(pageState) : { ...DEFAULT_PAGE }
  return { schemaVersion: SCHEMA_VERSION, page, objects, extras }
}
