import { DEFAULTS, DEFAULT_PAGE, DocumentError, PAGE, SCHEMA_VERSION } from './schema.js'

// Document model <-> JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/), the stored note format (ADR 0002, F-026).
// Pure functions over plain data; the Python mirror is jsoncanvas.py in document_model.py's neighbour, `json_canvas.py`.
//
// What goes where
//   JSON Canvas fields   what any reader (Obsidian) uses: id, x/y/width/height (integers, the nearest rounding of the exact box),
//                        text (Markdown), colour, file paths, edges. Z-order is the array order.
//   `pn` on a node/edge  the exact model object minus what the JSON Canvas fields already say (type, geometry with rotation,
//                        scale, skew, ink points and path, shape kind, sticky style, opacity, shadow, extras ...). `pn` is canonical
//                        for everything it holds; the native fields are canonical for what they hold (a text node's `text`, its box
//                        when it no longer matches `pn`, a sticky or edge colour, a file path). That is how an edit made by another
//                        app (which keeps or drops `pn`) is picked up instead of overwritten.
//   top-level `pn`       { schemaVersion, page: {columns, rows}, grid: {width, height}, extras?, detached? }
//
// Ink strokes, dots and shapes are written as `file` nodes that point at an SVG picture so other apps show them; the SVG is derived
// data and ignored on the way in. Pictures are `file` nodes. Connectors are edges; one whose end is not a node of this note is kept in
// `pn.detached` so the edge list stays valid. A group is a `group` node whose children live in its `pn.children`.
//
// Media: `media` is { fromId(id) -> path, putText(text, ext) -> path, putDataUrl(url) -> path }; every member is optional. Without it
// a picture that is inline stays a `data:` URL in the node's `file` and an SVG is written as a `data:` URL too; a store (the
// server's, which writes content-addressed files `media/<sha256>.<ext>`) turns them into paths. `derived: 'omit'` writes `file: ''`
// for SVG nodes instead (the browser's transport form: the server rebuilds the pictures).

export const JSON_CANVAS_PRESETS = Object.freeze({ 1: '#fb464c', 2: '#e9973f', 3: '#e0de71', 4: '#44cf6e', 5: '#53dfdd', 6: '#a882ff' })
export const FOREIGN_TEXT_STYLE = Object.freeze({ fontFamily: 'Source Serif 4', fontSize: 24, lineHeight: 1.45, padding: 8, color: '#20201e' })
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'])
const SIDES = ['top', 'right', 'bottom', 'left']
const HEX6 = /^#[0-9a-fA-F]{6}$/

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const clone = (value) => structuredClone(value)
const round = Math.round

// ---- helpers shared in spirit with json_canvas.py: keep both in step -------------------------------------------------------

export function estimateTextBox(object) {
  const style = object.style ?? {}
  const g = object.geometry ?? {}
  const width = g.width ?? 200
  const size = isNumber(style.fontSize) ? style.fontSize : 24
  const lineHeight = isNumber(style.lineHeight) ? style.lineHeight : 1.16
  const padding = isNumber(style.padding) ? style.padding : 0
  const perLine = Math.max(1, Math.floor(width / (size * 0.5)))
  const lines = String(object.content ?? '').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].length / perLine)), 0)
  return { width, height: lines * size * lineHeight + padding * 2 }
}

// The integer box JSON Canvas readers see for a model object. Text without a stored height (an agent-written block) gets an estimate.
export function nativeBox(object) {
  const g = object.geometry ?? {}
  const textual = object.type === 'text' || object.type === 'sticky'
  const estimate = textual && (g.width === undefined || g.height === undefined) ? estimateTextBox(object) : null
  const width = g.width ?? estimate?.width ?? 0
  const height = g.height ?? estimate?.height ?? 0
  return { x: round(g.x ?? 0), y: round(g.y ?? 0), width: Math.max(1, round(width)), height: Math.max(1, round(height)) }
}

function rawBox(raw) {
  const r = isObject(raw) ? raw : {}
  const n = (value, fallback) => (isNumber(value) ? round(value) : fallback)
  return { x: n(r.left, 0), y: n(r.top, 0), width: Math.max(1, n(r.width, 1)), height: Math.max(1, n(r.height, 1)) }
}

const num = (value) => String(round(value * 1000) / 1000)
const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

function hexOf(value) {
  return typeof value === 'string' && HEX6.test(value) ? value : undefined
}
function presetHex(value) {
  if (typeof value !== 'string') return undefined
  if (HEX6.test(value)) return value.toLowerCase()
  return JSON_CANVAS_PRESETS[value]
}
// The colour a node or edge means: its own field wins when another app changed it, otherwise the exact stored one.
function colorFromNative(nativeColor, storedColor) {
  if (nativeColor === undefined) return storedColor
  const hex = presetHex(nativeColor)
  if (hex === undefined) return storedColor
  return typeof storedColor === 'string' && storedColor.toLowerCase() === hex ? storedColor : hex
}

function dataUrlParts(url) {
  const match = /^data:([^;,]+)(;base64)?,/i.exec(url)
  return match ? { mime: match[1].toLowerCase(), base64: Boolean(match[2]) } : null
}
export const isDataUrl = (value) => typeof value === 'string' && value.startsWith('data:')

function svgDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

// ---- SVG pictures for ink and shapes (what Obsidian shows) ------------------------------------------------------------------

function pathData(path) {
  return path.map((command) => command[0] + command.slice(1).map((value) => ` ${num(value)}`).join('')).join(' ')
}

export function svgOf(object, box) {
  const w = box.width
  const h = box.height
  const head = (pad, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${num(-pad)} ${num(-pad)} ${num(w + pad * 2)} ${num(h + pad * 2)}"${extra}>`
  if (object.type === 'shape') {
    const sw = isNumber(object.strokeWidth) ? object.strokeWidth : 0
    const fill = typeof object.fill === 'string' ? object.fill : 'none'
    const stroke = typeof object.stroke === 'string' ? ` stroke="${escapeXml(object.stroke)}" stroke-width="${num(sw)}"` : ''
    const body = object.kind === 'circle'
      ? `<circle cx="${num(w / 2)}" cy="${num(h / 2)}" r="${num(object.radius ?? Math.min(w, h) / 2)}" fill="${escapeXml(fill)}"${stroke}/>`
      : `<rect x="0" y="0" width="${num(object.geometry?.width ?? w)}" height="${num(object.geometry?.height ?? h)}" rx="${num(object.cornerRadius ?? 0)}" ry="${num(object.cornerRadiusY ?? object.cornerRadius ?? 0)}" fill="${escapeXml(fill)}"${stroke}/>`
    return `${head(sw / 2)}${body}</svg>`
  }
  const color = escapeXml(object.color ?? '#20201e')
  const opacity = object.alpha !== undefined ? ` opacity="${num(object.alpha)}"` : ''
  if (object.kind === 'dot') {
    return `${head(0)}<circle cx="${num(w / 2)}" cy="${num(h / 2)}" r="${num(object.radius ?? Math.min(w, h) / 2)}" fill="${color}"${opacity}/></svg>`
  }
  const sw = isNumber(object.width) ? object.width : 2
  const cap = typeof object.cap === 'string' ? ` stroke-linecap="${escapeXml(object.cap)}"` : ' stroke-linecap="round"'
  const join = typeof object.join === 'string' ? ` stroke-linejoin="${escapeXml(object.join)}"` : ' stroke-linejoin="round"'
  return `${head(sw / 2)}<path d="${escapeXml(pathData(object.path ?? []))}" fill="none" stroke="${color}" stroke-width="${num(sw)}"${cap}${join}${opacity}/></svg>`
}

// ---- document -> JSON Canvas -------------------------------------------------------------------------------------------------

function ordered(objects) {
  return objects.map((object, index) => [object, index]).sort(([a, i], [b, j]) => ((a?.z ?? i) - (b?.z ?? j)) || (i - j)).map(([object]) => object)
}

function filled(media = {}) {
  return {
    fromId: media.fromId ?? ((id) => (String(id).includes('/') ? id : `media/${id}`)),
    putText: media.putText ?? ((text, ext) => (ext === 'svg' ? svgDataUrl(text) : text)),
    putDataUrl: media.putDataUrl ?? ((url) => url),
  }
}

// A picture reference as a child inside `pn` (group children): an inline picture becomes a library reference when a store exists.
function externalize(object, store) {
  const copy = clone(object)
  const visit = (item) => {
    if (item.type === 'image' && item.mediaRef?.kind === 'inline') {
      const path = store.putDataUrl(item.mediaRef.dataUrl)
      if (typeof path === 'string' && !isDataUrl(path) && path.startsWith('media/')) item.mediaRef = { kind: 'media', id: path.slice('media/'.length) }
    }
    if (item.type === 'group') item.children.forEach(visit)
  }
  visit(copy)
  return copy
}

function nodeCommon(object, id, box) {
  return { id, type: 'text', x: box.x, y: box.y, width: box.width, height: box.height }
}

function pnOf(object, extra = {}) {
  const { id, z, type, content, mediaRef, children, raw, ...rest } = object
  void id; void z; void content; void mediaRef; void children; void raw
  return { type, ...extra, ...clone(rest) }
}

function sideOf(from, to) {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2)
  const dy = to.y + to.height / 2 - (from.y + from.height / 2)
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? ['right', 'left'] : ['left', 'right']) : (dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'])
}

export function toJsonCanvas(doc, { media, derived = 'file' } = {}) {
  const store = filled(media)
  const objects = ordered(doc.objects ?? [])
  const used = new Set(objects.map((object) => object?.id).filter((id) => typeof id === 'string' && id !== ''))
  let counter = 0
  const seen = new Set()
  const fallbackId = () => { let id; do { id = `node-${counter++}` } while (used.has(id)); used.add(id); return id }

  const nodes = []
  const connectors = []
  const boxes = new Map()
  objects.forEach((object, index) => {
    const hasId = typeof object.id === 'string' && object.id !== '' && !seen.has(object.id)
    const id = hasId ? object.id : fallbackId()
    seen.add(id)
    // An id that cannot be a node id (missing, empty, or already taken by an earlier object) is replaced; `pn` remembers what it was.
    const noId = hasId ? {} : object.id === undefined ? { noId: true } : { origId: object.id }
    if (object.type === 'connector') { connectors.push({ object, id, noId, index }); return }
    let node
    if (object.type === 'unknown') {
      const box = rawBox(object.raw)
      node = { ...nodeCommon(object, id, box), text: '', pn: { type: 'unknown', ...noId, raw: clone(object.raw) } }
    } else {
      const box = nativeBox(object)
      boxes.set(id, box)
      node = nodeCommon(object, id, box)
      const pn = pnOf(object, noId)
      if (object.type === 'text') node.text = object.content ?? ''
      else if (object.type === 'sticky') { node.text = object.content ?? ''; const hex = hexOf(object.color); if (hex) node.color = hex }
      else if (object.type === 'image') {
        node.type = 'file'
        const ref = object.mediaRef
        node.file = ref.kind === 'media' ? store.fromId(ref.id) : store.putDataUrl(ref.dataUrl)
        if (typeof node.file !== 'string') node.file = ref.dataUrl
      } else if (object.type === 'group') {
        node.type = 'group'
        pn.children = object.children.map((child) => externalize(child, store))
      } else { // shape, ink
        node.type = 'file'
        node.file = derived === 'omit' ? '' : store.putText(svgOf(object, box), 'svg')
      }
      node.pn = pn
    }
    nodes.push(node)
  })

  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = []
  const detached = []
  for (const { object, id, noId, index } of connectors) {
    const { fromId, toId } = object
    const pn = { ...pnOf(object, noId), z: object.z ?? index }
    delete pn.fromId
    delete pn.toId
    if (!nodeIds.has(fromId) || !nodeIds.has(toId)) { const entry = { ...clone(object), z: object.z ?? index }; if (!noId.noId) entry.id = object.id; detached.push(entry); continue }
    const edge = { id, fromNode: fromId, toNode: toId }
    const [fromSide, toSide] = sideOf(boxes.get(fromId) ?? { x: 0, y: 0, width: 1, height: 1 }, boxes.get(toId) ?? { x: 0, y: 0, width: 1, height: 1 })
    edge.fromSide = fromSide
    edge.toSide = toSide
    const heads = object.arrowheads ?? DEFAULTS.connector.arrowheads
    if (heads.start) edge.fromEnd = 'arrow'
    if (!heads.end) edge.toEnd = 'none'
    const hex = hexOf(object.color)
    if (hex) edge.color = hex
    edge.pn = pn
    edges.push(edge)
  }
  edges.sort((a, b) => a.pn.z - b.pn.z)

  const pn = { schemaVersion: SCHEMA_VERSION, page: clone(doc.page ?? DEFAULT_PAGE), grid: { width: PAGE.width, height: PAGE.height } }
  if (doc.extras && Object.keys(doc.extras).length) pn.extras = clone(doc.extras)
  if (detached.length) pn.detached = detached
  return { nodes, edges, pn }
}

// ---- JSON Canvas -> document -------------------------------------------------------------------------------------------------

export function isJsonCanvas(value) {
  return isObject(value) && !Array.isArray(value.objects) && (Array.isArray(value.nodes) || Array.isArray(value.edges) || isObject(value.pn))
}

const imageExtension = (path) => IMAGE_EXTENSIONS.has(String(path).split(/[?#]/)[0].split('.').pop().toLowerCase())

function mediaRefOf(file) {
  if (isDataUrl(file)) return { kind: 'inline', dataUrl: file }
  return { kind: 'media', id: file.startsWith('media/') ? file.slice('media/'.length) : file }
}

function geometryOver(geometry, node, expected) {
  const same = node.x === expected.x && node.y === expected.y && node.width === expected.width && node.height === expected.height
  if (same) return geometry
  return { ...geometry, x: node.x, y: node.y, width: node.width, height: node.height }
}

function plainGeometry(node) {
  return { x: node.x, y: node.y, width: node.width, height: node.height, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
}

const asText = (object, node) => ({ ...object, geometry: plainGeometry(node) })

function foreignObjects(node) {
  const geometry = plainGeometry(node)
  const color = presetHex(node.color)
  if (node.type === 'text') {
    const base = { id: node.id, geometry, content: String(node.text ?? ''), style: { ...FOREIGN_TEXT_STYLE }, extras: {} }
    return [color ? { ...base, type: 'sticky', color } : { ...base, type: 'text', mode: 'box' }]
  }
  if (node.type === 'file' && imageExtension(node.file)) return [{ id: node.id, type: 'image', geometry, mediaRef: mediaRefOf(node.file), extras: {} }]
  if (node.type === 'file' || node.type === 'link') {
    const content = node.type === 'file' ? `[[${node.file}${node.subpath ?? ''}]]` : `[${node.url}](${node.url})`
    return [{ id: node.id, type: 'text', mode: 'box', geometry, content, style: { ...FOREIGN_TEXT_STYLE }, extras: {} }]
  }
  // A group of another app: a dashed frame with its label at the top left.
  const frame = { id: node.id, type: 'shape', kind: 'rect', geometry, cornerRadius: 12, cornerRadiusY: 12, fill: 'transparent', stroke: color ?? '#8a8a85', strokeWidth: 2, extras: { strokeDashArray: [8, 6] } }
  if (typeof node.label !== 'string' || !node.label) return [frame]
  const label = { id: `${node.id}-label`, type: 'text', mode: 'box', geometry: { ...plainGeometry({ x: node.x + 12, y: node.y + 8, width: Math.max(1, node.width - 24), height: 40 }) }, content: node.label, style: { ...FOREIGN_TEXT_STYLE }, extras: {} }
  return [frame, label]
}

function objectFromNode(node) {
  const pn = isObject(node.pn) ? node.pn : null
  const kind = pn?.type
  if (pn && kind === 'unknown') {
    const object = { type: 'unknown', raw: clone(pn.raw) }
    if (pn.origId !== undefined) object.id = pn.origId
    else if (!pn.noId) object.id = node.id
    return [object]
  }
  const valid = new Set(['text', 'sticky', 'shape', 'ink', 'image', 'group'])
  if (!pn || !valid.has(kind)) return foreignObjects(node)
  const object = { ...clone(pn), id: node.id }
  delete object.noId
  delete object.origId
  delete object.member
  if (pn.noId) delete object.id
  else if (pn.origId !== undefined) object.id = pn.origId
  object.geometry = geometryOver(object.geometry ?? plainGeometry(node), node, nativeBox({ ...object, content: node.text, geometry: object.geometry }))
  if (kind === 'text' || kind === 'sticky') {
    object.content = typeof node.text === 'string' ? node.text : ''
    if (kind === 'sticky') {
      const color = colorFromNative(node.color, object.color)
      if (color !== undefined) object.color = color
    }
  } else if (kind === 'image') {
    object.mediaRef = typeof node.file === 'string' && node.file !== '' ? mediaRefOf(node.file) : { kind: 'inline', dataUrl: '' }
  } else if (kind === 'group') {
    object.children = Array.isArray(pn.children) ? clone(pn.children) : []
  }
  if (!object.extras) object.extras = {}
  return [object]
}

function connectorFromEdge(edge) {
  const pn = isObject(edge.pn) && edge.pn.type === 'connector' ? edge.pn : null
  const heads = { start: edge.fromEnd === 'arrow', end: edge.toEnd !== 'none' }
  if (!pn) {
    const color = presetHex(edge.color)
    return { id: edge.id, type: 'connector', geometry: { x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }, fromId: edge.fromNode, toId: edge.toNode, color: color ?? DEFAULTS.connector.color, lineWidth: DEFAULTS.connector.lineWidth, reverseX: false, reverseY: false, arrowheads: heads, extras: {} }
  }
  const object = { ...clone(pn), id: edge.id, fromId: edge.fromNode, toId: edge.toNode }
  delete object.noId
  delete object.origId
  delete object.z
  if (pn.noId) delete object.id
  else if (pn.origId !== undefined) object.id = pn.origId
  const color = colorFromNative(edge.color, object.color)
  if (color !== undefined) object.color = color
  const stored = pn.arrowheads ?? DEFAULTS.connector.arrowheads
  if (stored.start !== heads.start || stored.end !== heads.end) object.arrowheads = heads
  if (!object.extras) object.extras = {}
  return object
}

// Another app's canvas has no `pn.page` and may use negative coordinates, which a page-based note cannot show: move it onto the pages.
function foreignFrame(nodes) {
  if (!nodes.length) return { dx: 0, dy: 0, columns: 1, rows: 1 }
  const minX = Math.min(...nodes.map((n) => n.x))
  const minY = Math.min(...nodes.map((n) => n.y))
  const dx = minX < 0 ? 72 - minX : 0
  const dy = minY < 0 ? 72 - minY : 0
  const maxX = Math.max(...nodes.map((n) => n.x + n.width)) + dx
  const maxY = Math.max(...nodes.map((n) => n.y + n.height)) + dy
  return { dx, dy, columns: Math.max(1, Math.ceil((maxX + 72) / PAGE.width)), rows: Math.max(1, Math.ceil((maxY + 72) / PAGE.height)) }
}

export function fromJsonCanvas(canvas) {
  if (!isObject(canvas)) throw new DocumentError('A JSON Canvas must be an object')
  if (canvas.nodes !== undefined && !Array.isArray(canvas.nodes)) throw new DocumentError('nodes must be an array')
  if (canvas.edges !== undefined && !Array.isArray(canvas.edges)) throw new DocumentError('edges must be an array')
  const pnTop = isObject(canvas.pn) ? canvas.pn : null
  if (pnTop && isNumber(pnTop.schemaVersion) && pnTop.schemaVersion > SCHEMA_VERSION) throw new DocumentError(`This note was saved by a newer version (schemaVersion ${pnTop.schemaVersion})`)
  let nodes = (canvas.nodes ?? []).filter((node) => isObject(node) && typeof node.id === 'string' && ['text', 'file', 'link', 'group'].includes(node.type) && [node.x, node.y, node.width, node.height].every(isNumber))
  nodes = nodes.filter((node) => !(isObject(node.pn) && node.pn.member))
  const edges = (canvas.edges ?? []).filter((edge) => isObject(edge) && typeof edge.id === 'string' && typeof edge.fromNode === 'string' && typeof edge.toNode === 'string')

  let frame = { dx: 0, dy: 0 }
  let page
  if (pnTop && isObject(pnTop.page)) page = clone(pnTop.page)
  else {
    const found = foreignFrame(nodes)
    frame = { dx: found.dx, dy: found.dy }
    page = { columns: found.columns, rows: found.rows }
  }
  if (frame.dx || frame.dy) nodes = nodes.map((node) => ({ ...node, x: node.x + frame.dx, y: node.y + frame.dy }))

  const list = nodes.flatMap(objectFromNode)
  const edgeObjects = edges.map((edge) => ({ z: isObject(edge.pn) && isNumber(edge.pn.z) ? edge.pn.z : Number.POSITIVE_INFINITY, object: connectorFromEdge(edge) }))
  const detached = Array.isArray(pnTop?.detached) ? pnTop.detached.filter(isObject).map((object) => ({ z: isNumber(object.z) ? object.z : Number.POSITIVE_INFINITY, object: (() => { const copy = clone(object); delete copy.z; return copy })() })) : []
  // Edges and detached connectors go back in at their stored stacking position among the nodes, lowest first.
  for (const { z, object } of [...edgeObjects, ...detached].sort((a, b) => a.z - b.z)) list.splice(Math.min(Number.isFinite(z) ? z : list.length, list.length), 0, object)
  list.forEach((object, index) => { object.z = index })

  return { schemaVersion: SCHEMA_VERSION, page, objects: list, extras: isObject(pnTop?.extras) ? clone(pnTop.extras) : {} }
}

// ---- spec check ------------------------------------------------------------------------------------------------------------

// Checks a canvas against JSON Canvas 1.0 and lists every problem as { path, message }. `pn` and any other extra property are allowed.
export function validateJsonCanvas(canvas) {
  const errors = []
  const report = (path, message) => errors.push({ path, message })
  if (!isObject(canvas)) return { ok: false, errors: [{ path: '', message: 'a canvas must be an object' }] }
  for (const key of ['nodes', 'edges']) if (canvas[key] !== undefined && !Array.isArray(canvas[key])) report(key, 'must be an array')
  const ids = new Set()
  const nodeIds = new Set()
  const colorOk = (value) => typeof value === 'string' && (/^[1-6]$/.test(value) || HEX6.test(value))
  ;(Array.isArray(canvas.nodes) ? canvas.nodes : []).forEach((node, index) => {
    const path = `nodes[${index}]`
    if (!isObject(node)) return report(path, 'must be an object')
    if (typeof node.id !== 'string' || node.id === '') report(`${path}.id`, 'missing id')
    else if (ids.has(node.id)) report(`${path}.id`, `duplicate id ${JSON.stringify(node.id)}`)
    else { ids.add(node.id); nodeIds.add(node.id) }
    if (!['text', 'file', 'link', 'group'].includes(node.type)) report(`${path}.type`, `unknown node type ${JSON.stringify(node.type)}`)
    for (const key of ['x', 'y', 'width', 'height']) if (!Number.isInteger(node[key])) report(`${path}.${key}`, 'must be an integer')
    if (node.color !== undefined && !colorOk(node.color)) report(`${path}.color`, 'must be a hex colour or a preset "1" to "6"')
    if (node.type === 'text' && typeof node.text !== 'string') report(`${path}.text`, 'text nodes need a text string')
    if (node.type === 'file') {
      if (typeof node.file !== 'string' || node.file === '') report(`${path}.file`, 'file nodes need a path')
      if (node.subpath !== undefined && !(typeof node.subpath === 'string' && node.subpath.startsWith('#'))) report(`${path}.subpath`, 'must start with #')
    }
    if (node.type === 'link' && typeof node.url !== 'string') report(`${path}.url`, 'link nodes need a url')
    if (node.type === 'group') {
      if (node.label !== undefined && typeof node.label !== 'string') report(`${path}.label`, 'must be a string')
      if (node.backgroundStyle !== undefined && !['cover', 'ratio', 'repeat'].includes(node.backgroundStyle)) report(`${path}.backgroundStyle`, 'must be cover, ratio or repeat')
    }
  })
  ;(Array.isArray(canvas.edges) ? canvas.edges : []).forEach((edge, index) => {
    const path = `edges[${index}]`
    if (!isObject(edge)) return report(path, 'must be an object')
    if (typeof edge.id !== 'string' || edge.id === '') report(`${path}.id`, 'missing id')
    else if (ids.has(edge.id)) report(`${path}.id`, `duplicate id ${JSON.stringify(edge.id)}`)
    else ids.add(edge.id)
    for (const key of ['fromNode', 'toNode']) {
      if (typeof edge[key] !== 'string') report(`${path}.${key}`, 'missing')
      else if (!nodeIds.has(edge[key])) report(`${path}.${key}`, `refers to unknown node ${JSON.stringify(edge[key])}`)
    }
    for (const key of ['fromSide', 'toSide']) if (edge[key] !== undefined && !SIDES.includes(edge[key])) report(`${path}.${key}`, 'must be top, right, bottom or left')
    for (const key of ['fromEnd', 'toEnd']) if (edge[key] !== undefined && !['none', 'arrow'].includes(edge[key])) report(`${path}.${key}`, 'must be none or arrow')
    if (edge.color !== undefined && !colorOk(edge.color)) report(`${path}.color`, 'must be a hex colour or a preset "1" to "6"')
    if (edge.label !== undefined && typeof edge.label !== 'string') report(`${path}.label`, 'must be a string')
  })
  return { ok: errors.length === 0, errors }
}

// ---- Markdown projection ---------------------------------------------------------------------------------------------------

const textOf = (object) => {
  if (object.type === 'unknown') return typeof object.raw?.text === 'string' ? object.raw.text : null
  if (object.type === 'text' || object.type === 'sticky') return typeof object.content === 'string' ? object.content : null
  return typeof object.extras?.text === 'string' ? object.extras.text : null
}

// Text blocks in reading order (box top edge, then left edge), as the agent CLI, search and the Markdown export read a note.
export function plainTextBlocks(doc) {
  const position = (object) => (object.type === 'unknown' ? [Number(object.raw?.top) || 0, Number(object.raw?.left) || 0] : [object.geometry?.y ?? 0, object.geometry?.x ?? 0])
  return ordered(doc.objects ?? []).filter(isObject).map((object, index) => ({ object, index, at: position(object) }))
    .sort((a, b) => (a.at[0] - b.at[0]) || (a.at[1] - b.at[1]) || (a.index - b.index))
    .map(({ object }) => textOf(object)).filter((text) => text !== null && text.trim()).map((text) => text.trim())
}
export const plainText = (doc) => plainTextBlocks(doc).join('\n\n')
