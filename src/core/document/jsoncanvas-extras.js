import { PAGE } from './schema.js'
import { HEX6, isDataUrl, isNumber, isObject, mediaRefOf, ordered, plainGeometry, presetHex, readJsonCanvas, writeJsonCanvas } from './jsoncanvas.js'

// The parts of the JSON Canvas support that the browser does not need at run time (it only reads and writes notes this app
// stored): SVG pictures for ink and shapes, reading a canvas another app wrote (Obsidian: no `pn`, negative coordinates, files,
// links, groups), the spec validator and the Markdown projection. `toJsonCanvas` and `fromJsonCanvas` here are the complete
// versions; the Python mirror in json_canvas.py is complete in one file.

export const FOREIGN_TEXT_STYLE = Object.freeze({ fontFamily: 'Source Serif 4', fontSize: 24, lineHeight: 1.45, padding: 8, color: '#20201e' })
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'])
const SIDES = ['top', 'right', 'bottom', 'left']
const num = (value) => String(Math.round(value * 1000) / 1000)
const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

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


const imageExtension = (path) => (isDataUrl(path) ? path.toLowerCase().startsWith('data:image/') : IMAGE_EXTENSIONS.has(String(path).split(/[?#]/)[0].split('.').pop().toLowerCase()))


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


const FOREIGN = Object.freeze({ objects: foreignObjects, frame: foreignFrame })

export const toJsonCanvas = (doc, options = {}) => writeJsonCanvas(doc, { svg: svgOf, ...options })
export const fromJsonCanvas = (canvas) => readJsonCanvas(canvas, { foreign: FOREIGN })

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
