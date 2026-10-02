import { paletteKeyFor } from './palette.js'
import { DEFAULTS, DEFAULT_PAGE, DocumentError, SCHEMA_VERSION } from './schema.js'
import { validateDocument } from './validate.js'

// Fabric JSON <-> document model. Pure functions over plain data; nothing here imports Fabric.
//
// Fabric JSON is what the app saves today: canvas.toJSON() ({ version, objects: [...] }), plus the page state kept beside it.
// fromFabric moves every property it understands into a typed model field and leaves the rest in `extras`, so
// toFabric(fromFabric(x)) is deep-equal to x. The only things that are not carried over one-to-one:
//   - `arrowheads`, `colorKey` and `fillKey` are derived on the way in and ignored on the way out (Fabric stores none of them);
//   - a content object without an `objects` array comes back with an empty one;
//   - an ink colour is only split into colour + alpha when it is `#rrggbb` followed by two lowercase hex digits (what the
//     highlighter writes); any other spelling stays whole in `color`, so it is never rewritten.

const has = (object, key) => Object.hasOwn(object, key)
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const clone = (value) => structuredClone(value)

const GEOMETRY = [['left', 'x'], ['top', 'y'], ['width', 'width'], ['height', 'height'], ['angle', 'rotation'], ['scaleX', 'scaleX'], ['scaleY', 'scaleY'], ['originX', 'originX'], ['originY', 'originY']]
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
const FABRIC_TYPE = { sticky: 'Sticky', rect: 'Rect', circle: 'Circle', stroke: 'Path', dot: 'Circle', image: 'Image', connector: 'Connector', group: 'Group' }
const TEXT_TYPE = { point: 'IText', box: 'Textbox' }

function setPath(target, path, value) {
  const keys = path.split('.')
  const last = keys.pop()
  let node = target
  for (const key of keys) node = node[key] ??= {}
  node[last] = value
}
const getPath = (source, path) => path.split('.').reduce((node, key) => (isObject(node) ? node[key] : undefined), source)

// Moves each listed key out of `rest` into `target`.
function take(rest, target, pairs) {
  for (const [from, to] of pairs) {
    if (!has(rest, from)) continue
    setPath(target, to, rest[from])
    delete rest[from]
  }
}

// The reverse of take: model fields back into Fabric keys, skipping fields the model does not have.
function put(source, out, pairs) {
  for (const [fabricKey, path] of pairs) {
    const value = getPath(source, path)
    if (value !== undefined) out[fabricKey] = value
  }
}

const HEX_WITH_ALPHA = /^(#[0-9a-fA-F]{6})([0-9a-f]{2})$/
function splitColor(value) {
  const match = typeof value === 'string' ? HEX_WITH_ALPHA.exec(value) : null
  return match ? { color: match[1], alpha: Number.parseInt(match[2], 16) / 255 } : { color: value }
}
function joinColor(color, alpha) {
  return alpha === undefined || typeof color !== 'string' ? color : `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`
}

function classify(raw) {
  switch (raw.type) {
    case 'IText': case 'Textbox': return typeof raw.text === 'string' ? 'text' : null
    case 'Sticky': return typeof raw.text === 'string' ? 'sticky' : null
    case 'Rect': return 'rect'
    case 'Circle': return raw.isInk === true ? 'dot' : 'circle'
    case 'Path': return raw.isInk === true ? 'stroke' : null
    case 'Image': return typeof raw.src === 'string' ? 'image' : null
    case 'Connector': return 'connector'
    case 'Group': return Array.isArray(raw.objects) ? 'group' : null
    default: return null
  }
}

function objectFromFabric(raw, index) {
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

  const geometry = {}
  take(rest, geometry, GEOMETRY)
  if (Object.keys(geometry).length) object.geometry = geometry
  take(rest, object, [['opacity', 'opacity']])

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
    object.children = rest.objects.map((child, childIndex) => objectFromFabric(child, childIndex))
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
      if (Array.isArray(rest.inkPoints)) { object.points = rest.inkPoints; delete rest.inkPoints }
      if (Array.isArray(rest.path)) { object.path = rest.path; delete rest.path }
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

function objectToFabric(object, resolveMedia) {
  if (object.type === 'unknown') return clone(object.raw)
  const out = clone(object.extras ?? {})
  const source = object
  if (object.id !== undefined) out.semanticId = object.id
  for (const [fabricKey, key] of GEOMETRY) if (object.geometry && object.geometry[key] !== undefined) out[fabricKey] = object.geometry[key]
  if (object.opacity !== undefined) out.opacity = object.opacity

  switch (object.type) {
    case 'text':
      out.type = TEXT_TYPE[object.mode]
      put(source, out, FIELDS.text)
      break
    case 'sticky':
      out.type = FABRIC_TYPE.sticky
      put(source, out, FIELDS.sticky)
      break
    case 'shape':
      out.type = FABRIC_TYPE[object.kind]
      put(source, out, FIELDS[object.kind])
      break
    case 'connector':
      out.type = FABRIC_TYPE.connector
      put(source, out, FIELDS.connector)
      break
    case 'image': {
      out.type = FABRIC_TYPE.image
      const ref = object.mediaRef
      if (ref.kind === 'inline') out.src = ref.dataUrl
      else {
        const resolved = resolveMedia ? resolveMedia(ref) : null
        if (typeof resolved !== 'string') throw new DocumentError(`Picture ${JSON.stringify(ref.id)} is in the media library; pass resolveMedia to turn it into a data URL`)
        out.src = resolved
      }
      break
    }
    case 'group':
      out.type = FABRIC_TYPE.group
      out.objects = orderedChildren(object.children).map((child) => objectToFabric(child, resolveMedia))
      break
    default: { // ink
      out.type = FABRIC_TYPE[object.kind]
      out.isInk = true
      put(source, out, FIELDS[object.kind])
      const colorKey = object.kind === 'dot' ? 'fill' : 'stroke'
      if (object.color !== undefined) out[colorKey] = joinColor(object.color, object.alpha)
      if (object.points !== undefined) out.inkPoints = object.points
      if (object.path !== undefined) out.path = object.path
    }
  }
  return structuredClone(out)
}

function orderedChildren(objects) {
  return objects.map((object, index) => [object, index]).sort(([a, i], [b, j]) => ((a.z ?? i) - (b.z ?? j)) || (i - j)).map(([object]) => object)
}

// Document -> Fabric content. `resolveMedia(ref)` turns a { kind: 'media', id } picture into a data URL.
export function toFabric(doc, { resolveMedia } = {}) {
  const { ok, errors } = validateDocument(doc, { requireIds: false, strict: false })
  if (!ok) throw new DocumentError(`Not a valid document: ${errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`, errors)
  return { ...clone(doc.extras ?? {}), objects: orderedChildren(doc.objects).map((object) => objectToFabric(object, resolveMedia)) }
}

export function pageStateOf(doc) {
  return clone(doc.page)
}
