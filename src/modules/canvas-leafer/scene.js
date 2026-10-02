// The Leafer adapter (F-027, F-028): draws a document-model note and edits it. Everything about WHERE an object goes comes from the
// documented model rules (placement.js: the one matrix per object, and its inverse; schema.js: frames, ink frame, group frames); this
// file only knows how to make each model type look like the Fabric render. Leafer is imported here and in editing.js (the
// selection and transform layer) and overlay.js (the ghost page, the connector halo, the connect tool's outlines) and nowhere else. An edit is
// a document-model operation (operations.js); the nodes follow the model. F-032: every edit goes through pages.js finalizeOp, so the connectors
// that follow what moved and the pages that grow or fold back are part of the same undo step.
import { App, Box, Group, Ellipse, Image, Leafer, MatrixHelper, Path, Rect, Text } from 'leafer-ui'
import { PAGE } from '../../core/document/index.js'
import { applyChanges, isLocked, planLock, planMove, planRemove, planReorder, planSetGeometry, stacking } from '../../core/document/operations.js'
import { connectorEndpoints } from '../editor/connectors.js'
import { nextPageGhost } from '../editor/edge-ghost.js'
import { LIFT_SHADOW, LIFT_TILT_DEGREES } from '../editor/lift.js'
import { STICKY_PADDING } from '../editor/objects.js'
import { boundingRect, rectEdges } from './bounds.js'
import { FOLD_COLOR, FOLD_DASH, FOLD_WIDTH, LABEL_FONT_FAMILY, LABEL_FONT_SIZE, pageChrome } from './chrome.js'
import { CONNECTOR_DEFAULTS, CONNECTOR_HIT, arrowPath, connectorAt, connectorLayout, followChanges, newConnector, newConnectorId, withLayout } from './connectors.js'
import { createEditing, EDITOR_CONFIG } from './editing.js'
import { createOverlays } from './overlay.js'
import { GHOST_REACH, finalizeOp, growForDrag } from './pages.js'
import { applyMatrix, geometryFromMatrix, multiplyMatrices, placementMatrix } from './placement.js'
import { bakedStickyShadow, STICKY_CORNERS } from './sticky-shadow.js'
import { canvasFamily, fabricLineMetrics, withAlpha } from './style.js'
import { newImage } from './media.js'
import { createTextOverlay } from './text.js'
import { fitGeometry, newSticky, newText, nextZ, objectAt, planSetContent, planSetStyle, toLocal } from './text-ops.js'

// What Fabric assumes for a text field a saved note leaves out (the model is sparse and does not write defaults).
const TEXT_DEFAULTS = { fontFamily: 'Times New Roman', fontSize: 40, fontWeight: 'normal', fontStyle: 'normal', lineHeight: 1.16, textAlign: 'left', color: 'rgb(0,0,0)' }
const SHAPE_DEFAULT_FILL = 'rgb(0,0,0)'
const INK_HIT_RADIUS = 10 // a pen line is a few pixels wide; a click this close to it (page pixels) picks it

const LEGACY_TEXT_PLACEHOLDER = 'Start typing'
const isPlaceholderText = (value) => { const trimmed = String(value ?? '').trim(); return !trimmed || trimmed === LEGACY_TEXT_PLACEHOLDER }
const isColor = (value) => typeof value === 'string' && value.length > 0

function pathString(commands) {
  return commands.map((command) => command.join(' ')).join(' ')
}

// An elliptical-cornered rectangle (Fabric's rx differs from ry); Leafer's cornerRadius is circular only.
function roundedRectPath(width, height, rx, ry) {
  const cx = Math.min(rx, width / 2)
  const cy = Math.min(ry, height / 2)
  const k = 0.5522847498
  return [
    `M ${cx} 0`, `L ${width - cx} 0`, `C ${width - cx + cx * k} 0 ${width} ${cy - cy * k} ${width} ${cy}`,
    `L ${width} ${height - cy}`, `C ${width} ${height - cy + cy * k} ${width - cx + cx * k} ${height} ${width - cx} ${height}`,
    `L ${cx} ${height}`, `C ${cx - cx * k} ${height} 0 ${height - cy + cy * k} 0 ${height - cy}`,
    `L 0 ${cy}`, `C 0 ${cy - cy * k} ${cx - cx * k} 0 ${cx} 0 Z`,
  ].join(' ')
}

function textProps(object, { width, padding = 0, offsetY = 0 }) {
  const style = object.style ?? {}
  const fontSize = style.fontSize ?? TEXT_DEFAULTS.fontSize
  const { pitch, firstBaselineShift } = fabricLineMetrics(fontSize, style.lineHeight ?? TEXT_DEFAULTS.lineHeight)
  const props = {
    text: object.content ?? '',
    fontFamily: canvasFamily(!style.fontFamily ? TEXT_DEFAULTS.fontFamily : style.fontFamily === 'Georgia' ? 'Source Serif 4' : style.fontFamily), // the Fabric path renames the legacy Georgia
    fontSize,
    fontWeight: style.fontWeight ?? TEXT_DEFAULTS.fontWeight,
    italic: (style.fontStyle ?? TEXT_DEFAULTS.fontStyle) === 'italic',
    lineHeight: pitch,
    textAlign: style.textAlign ?? TEXT_DEFAULTS.textAlign,
    fill: isColor(style.color) ? style.color : TEXT_DEFAULTS.color,
    letterSpacing: ((style.charSpacing ?? 0) / 1000) * fontSize,
    textDecoration: style.underline ? 'under' : style.linethrough ? 'delete' : 'none',
    x: padding,
    y: padding + firstBaselineShift + offsetY,
    hittable: false,
  }
  if (width) {
    props.width = width
    props.textWrap = object.mode === 'point' ? 'none' : 'normal'
  } else props.textWrap = 'none'
  return props
}

const FOLD_PATH = (folds) => folds.map((f) => `M ${f.x1} ${f.y1} L ${f.x2} ${f.y2}`).join(' ')

// `onOperation(op, { coalesce })` is how an edit leaves the scene: the host records it (undo history, save) and returns the new document.
// `onDelete(ids)` records a delete the same way (the host's one owner of the rule) and returns the new document.
// F-029: `defaults.text()` is the model style for a new text ({ fontFamily, fontSize, color ... }); `defaults.sticky()` is
// { fill, ink, style } for a new sticky. `onBegin(label)` / `onEnd()` group edits into one undo step (a new sticky and the words typed
// into it); `onTextEvent(type)` hears 'start', 'end' and 'escape' of a text edit.
// F-032: `onPages({ columns, rows, shiftX, shiftY })` hears that the page grid grew while an object was being dragged, resized or turned (the
// host sets its page state and moves the view by the shift so nothing seems to move); an edit's own page change travels in the op instead.
export function createScene({ host, width, height, onOperation = () => null, onDelete = null, onBegin = () => {}, onEnd = () => {}, onTextEvent = () => {}, onPages = () => {}, defaults = {} }) {
  // Two layers in one App: the note (tree) and, above it, the selection and its handles (sky), so a drag repaints only what moved.
  const app = new App({ view: host, width, height, pixelRatio: Math.min(2, globalThis.devicePixelRatio || 1), tree: { type: 'draw' }, sky: { type: 'draw' }, editor: EDITOR_CONFIG })
  const leafer = app.tree
  const chrome = new Group({ hittable: false })
  const world = new Group()
  leafer.add(chrome)
  leafer.add(world)

  let view = { x: 0, y: 0, scale: 1 }
  let size = { width, height }
  let pages = { columns: 1, rows: 1 }
  let colors = { paper: '#fbfaf5', label: '#6e6e78', radius: 6, edge: '#2c2c34', shadows: [] }
  let boxes = []
  let stats = { drawn: 0, skipped: 0, unknown: 0, images: 0 }
  const textNodes = []
  const measuredText = []
  const uniformStrokes = [] // strokeScaleFixed keeps a stroke a constant number of SCREEN pixels; Fabric's uniform stroke still follows the zoom
  let resolveMedia = null
  const mediaUrls = new Map() // media id -> the URL of a picture added in this session (its bytes are already here), so it needs no fetch
  let doc = null // the document model on screen: edits change it, the nodes follow
  let committing = false // true while an edit made here is being handed to the host: the host need not draw it again
  const entries = new Map() // object id -> { id, node, built, rect, ... }: every top-level object that has a node
  const entryOfNode = new WeakMap()
  const linked = new Map() // object id -> the ids of the connectors on it (a drag only touches its own arrows)
  // What a drag, resize or turn in progress has done on screen. `shift` is how far the page grid has grown on the top and left since it began:
  // the grid (and the view) are in the new frame, the nodes and the document stay in the old one until the gesture lands (the editor works
  // out every move from where the node was when the drag began), so the note's layer is placed by that much to keep everything where it is.
  const live = { active: false, kind: null, rest: null, shift: { x: 0, y: 0 }, grown: false, lifted: [], ghost: '' }
  let connectorSelected = null // the id of the selected connector (it is picked by its line, apart from the editor's selection)
  const sizeOf = (object) => entries.get(object?.id)?.size ?? {}

  // ---- page furniture (screen space), stacked: shadow bands, edge, paper, fold lines, labels
  const shadowGroup = new Group({ hittable: false })
  const labelGroup = new Group({ hittable: false })
  const edgeNode = new Rect({ hittable: false })
  const paperNode = new Rect({ hittable: false })
  const foldNode = new Path({ hittable: false, stroke: FOLD_COLOR, strokeWidth: FOLD_WIDTH, dashPattern: FOLD_DASH, strokeAlign: 'center', path: 'M 0 0' })
  for (const node of [shadowGroup, edgeNode, paperNode, foldNode, labelGroup]) chrome.add(node)
  const pool = { shadows: [], labels: [] }
  const overlays = createOverlays({ app, chrome })

  function ensure(list, count, make, parent) {
    while (list.length < count) { const node = make(); list.push(node); parent.add(node) }
    list.forEach((node, index) => { node.visible = index < count })
  }

  function drawChrome() {
    const plan = pageChrome({ view, viewW: size.width, viewH: size.height, columns: pages.columns, rows: pages.rows, pageW: PAGE.width, pageH: PAGE.height, colors })
    ensure(pool.shadows, plan.shadows.length, () => new Rect({ hittable: false }), shadowGroup)
    plan.shadows.forEach((band, index) => pool.shadows[index].set({ x: band.x, y: band.y, width: band.width, height: band.height, fill: band.fill, opacity: band.alpha }))
    if (plan.edge) {
      edgeNode.set({ visible: true, x: plan.edge.x, y: plan.edge.y, width: plan.edge.width, height: plan.edge.height, cornerRadius: plan.edge.radius, fill: plan.edge.fill })
      paperNode.set({ visible: true, x: plan.paper.x, y: plan.paper.y, width: plan.paper.width, height: plan.paper.height, cornerRadius: plan.paper.radius, fill: plan.paper.fill })
      foldNode.set({ visible: plan.folds.length > 0, path: FOLD_PATH(plan.folds) || 'M 0 0' })
    } else {
      edgeNode.visible = paperNode.visible = foldNode.visible = false
    }
    ensure(pool.labels, plan.labels.length, () => new Text({ hittable: false, fontFamily: LABEL_FONT_FAMILY, fontSize: LABEL_FONT_SIZE, lineHeight: LABEL_FONT_SIZE, textWrap: 'none' }), labelGroup)
    plan.labels.forEach((label, index) => pool.labels[index].set({ text: label.text, x: label.x, y: label.y, fill: colors.label }))
    overlays.setView(view, { x: view.x + live.shift.x * view.scale, y: view.y + live.shift.y * view.scale, scale: view.scale })
  }

  // ---- objects (page space, in the model's frames)
  function measure(textNode) {
    const bounds = textNode.getBounds('box', 'inner')
    return { width: bounds.width, height: bounds.height }
  }

  function place(node, matrix) {
    node.set(MatrixHelper.getLayout(matrix))
  }

  function commonProps(object) {
    const props = { hittable: true }
    if (object.opacity !== undefined && object.opacity !== 1) props.opacity = object.opacity
    if (object.visible === false) props.visible = false
    if (object.shadow) props.shadow = { x: object.shadow.x, y: object.shadow.y, blur: object.shadow.blur, color: object.shadow.color }
    return props
  }

  function strokeProps(color, widthValue, uniform, cap, join) {
    if (!isColor(color) || !(widthValue > 0)) return {}
    const props = { stroke: color, strokeWidth: widthValue, strokeAlign: 'center' }
    if (uniform) props.strokeScaleFixed = true
    if (cap) props.strokeCap = cap
    if (join) props.strokeJoin = join
    return props
  }

  // A connector's node follows its model object: placed at its box, the arrow drawn in the box frame, hidden when the two ends are too close.
  function connectorProps(object) {
    return { x: object.geometry.x, y: object.geometry.y, path: arrowPath(object), visible: object.visible !== false }
  }

  // Returns { node, size } where size is the box the matrix uses (measured for text without a stored height).
  function build(object) {
    const g = object.geometry
    const base = commonProps(object)
    switch (object.type) {
      case 'text': {
        // The Fabric path drops empty and legacy placeholder text blocks when it opens a note; so does this one.
        if (isPlaceholderText(object.content)) return null
        const text = new Text(textProps(object, { width: g.width }))
        textNodes.push(text)
        // Measure before any turn: a block saved without a height (an agent-written Textbox) is placed from what the engine lays out.
        const measured = g.width === undefined || g.height === undefined ? measure(text) : null
        const size = measured ? { width: g.width ?? measured.width, height: g.height ?? measured.height } : { width: g.width, height: g.height }
        if (object.mode === 'point') { // a point text has no box of its own: it scales like a picture (the Fabric IText does too)
          const holder = new Group({ ...base, hitChildren: false })
          holder.add(text)
          return { node: holder, text, size: measured ? size : {}, measured: Boolean(measured), lockRatio: true }
        }
        // A text box is a sized node, so the editor resizes it (wider box, wrapped lines) instead of stretching the letters.
        const holder = new Box({ ...base, width: size.width, height: size.height, hitFill: 'all', hitChildren: false })
        holder.add(text)
        const relayout = () => { text.width = holder.width }
        return { node: holder, text, size, measured: Boolean(measured), sized: true, relayout }
      }
      case 'sticky': {
        const w = g.width ?? 240
        const h = g.height ?? 200
        const holder = new Box({ ...base, width: w, height: h, hitFill: 'all', hitChildren: false })
        const shadow = bakedStickyShadow(w, h)
        const shadowImage = new Image({ url: shadow.url, x: -shadow.margin, y: -shadow.margin, width: shadow.width, height: shadow.height, hittable: false })
        const paper = new Rect({ width: w, height: h, fill: isColor(object.color) ? object.color : '#ffd60a', cornerRadius: STICKY_CORNERS, hittable: false })
        holder.add(shadowImage)
        holder.add(paper)
        const text = new Text(textProps(object, { width: w - STICKY_PADDING * 2, padding: STICKY_PADDING }))
        textNodes.push(text)
        holder.add(text)
        // While the editor resizes the box the paper and the words follow it; the baked shadow is re-made when the resize ends.
        const relayout = () => {
          paper.set({ width: holder.width, height: holder.height })
          text.width = holder.width - STICKY_PADDING * 2
          shadowImage.set({ width: holder.width + shadow.margin * 2, height: holder.height + shadow.margin * 2 })
        }
        return { node: holder, text, size: { width: w, height: h }, sized: true, relayout }
      }
      case 'shape': {
        const fill = isColor(object.fill) ? object.fill : SHAPE_DEFAULT_FILL
        const strokes = strokeProps(object.stroke, object.strokeWidth ?? 1, object.strokeUniform, undefined, 'miter')
        if (object.kind === 'circle') return { node: new Ellipse({ ...base, width: g.width, height: g.height, fill, ...strokes }), size: {}, sized: true }
        const rx = object.cornerRadius ?? 0
        const ry = object.cornerRadiusY ?? rx
        if (rx !== ry && rx > 0 && ry > 0) return { node: new Path({ ...base, path: roundedRectPath(g.width, g.height, rx, ry), fill, ...strokes }), size: {} }
        return { node: new Rect({ ...base, width: g.width, height: g.height, fill, cornerRadius: rx || undefined, ...strokes }), size: {}, sized: true }
      }
      case 'ink': {
        const color = withAlpha(object.color, object.alpha)
        const blend = object.blend && object.blend !== 'source-over' ? { blendMode: object.blend } : {}
        if (object.kind === 'dot') {
          const radius = object.radius ?? g.width / 2
          return { node: new Ellipse({ ...base, ...blend, width: radius * 2, height: radius * 2, fill: color }), size: {} }
        }
        return { node: new Path({ ...base, ...blend, hitRadius: INK_HIT_RADIUS, path: pathString(object.path), fill: undefined, ...strokeProps(color, object.width ?? 1, object.strokeUniform, object.cap, object.join) }), size: {} }
      }
      case 'image': {
        const ref = object.mediaRef
        const url = ref?.kind === 'inline' ? ref.dataUrl : mediaUrls.get(ref?.id) ?? resolveMedia?.(ref)
        if (typeof url !== 'string') return null
        stats.images += 1
        return { node: new Image({ ...base, url, width: g.width, height: g.height }), size: {}, sized: true }
      }
      case 'connector': {
        const color = isColor(object.color) ? object.color : CONNECTOR_DEFAULTS.color
        const props = connectorProps(object)
        return { node: new Path({ ...base, hittable: false, ...props, fill: color, ...strokeProps(color, object.lineWidth ?? CONNECTOR_DEFAULTS.lineWidth, false, 'round', 'round') }), size: {} }
      }
      case 'group': {
        const group = new Group({ ...base, hitChildren: false })
        for (const child of [...object.children].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))) addObject(group, child, null)
        return { node: group, size: {} }
      }
      default:
        return null
    }
  }

  const boxOf = (matrix, w, h) => {
    const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => applyMatrix(matrix, { x, y }))
    const xs = corners.map((p) => p.x)
    const ys = corners.map((p) => p.y)
    return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
  }

  // `boxList` is given for the note's own objects (those that get a placement box and an entry); group children are placed but not boxed.
  function addObject(parent, object, boxList, index) {
    if (object.type === 'unknown') { if (boxList) stats.unknown += 1; return }
    const built = build(object)
    if (!built) { if (boxList) stats.skipped += 1; return }
    if (boxList) stats.drawn += 1
    const g = object.geometry
    const matrix = placementMatrix(g, built.size)
    place(built.node, matrix)
    if (built.sized && built.size.width !== undefined) built.node.set({ width: built.size.width, height: built.size.height })
    if (index === undefined) parent.add(built.node)
    else parent.addAt(built.node, index)
    if (object.strokeUniform && built.node.stroke && built.node.strokeScaleFixed) {
      uniformStrokes.push({ node: built.node, width: built.node.strokeWidth })
      built.node.strokeWidth = built.node.strokeWidth * view.scale
    }
    let box = null
    if (boxList && object.type !== 'connector') {
      box = boxOf(matrix, built.size.width ?? g.width ?? 0, built.size.height ?? g.height ?? 0)
      boxList.push(box)
    }
    // Text laid out by the engine (no stored size) is placed from what was measured, so it is placed again when fonts change.
    if (built.measured) measuredText.push({ object, built, box })
    if (boxList) register(object, built, box)
  }

  function applyView() {
    world.set({ x: view.x + live.shift.x * view.scale, y: view.y + live.shift.y * view.scale, scaleX: view.scale, scaleY: view.scale })
    for (const entry of uniformStrokes) entry.node.strokeWidth = entry.width * view.scale
    drawChrome()
    placeEditor()
  }

  // ---- editing: the nodes of the note's own objects, and the model operations that change them

  // Which nodes can be picked, and how they may be edited. A locked object can be picked (to unlock it) but has no handles and does
  // not move; paths, groups and point text scale as a whole, boxes (text, sticky, shapes, pictures) are resized.
  function register(object, built, box) {
    const entry = { id: object.id, object, built, node: built.node, box, size: built.size.width !== undefined ? { ...built.size } : { width: object.geometry.width, height: object.geometry.height }, rect: null }
    if (object.type === 'connector') link(object)
    else entry.rect = boundingRect(object, entry.size)
    entries.set(object.id, entry)
    entryOfNode.set(built.node, entry)
    configure(entry)
    return entry
  }

  function link(connector) {
    for (const end of [connector.fromId, connector.toId]) {
      if (!linked.has(end)) linked.set(end, new Set())
      linked.get(end).add(connector.id)
    }
  }
  function unlink(connector) { for (const end of [connector.fromId, connector.toId]) linked.get(end)?.delete(connector.id) }

  function configure(entry) {
    const { object, built, node } = entry
    const pickable = object.type !== 'connector'
    const locked = isLocked(object)
    const config = {}
    if (locked) Object.assign(config, { moveable: false, resizeable: false, rotateable: false })
    if (!built.sized) config.editSize = 'scale'
    node.set({ hittable: pickable, editable: pickable ? (locked ? 'single' : true) : false, editConfig: Object.keys(config).length ? config : undefined })
    if (built.lockRatio) node.lockRatio = true
    if (built.text && object.mode === 'point') built.text.hittable = true
  }

  const selectionListeners = new Set()

  function refreshBox(entry) {
    const g = entry.object.geometry
    if (entry.rect) entry.rect = boundingRect(entry.object, entry.size)
    if (!entry.box) return
    Object.assign(entry.box, boxOf(placementMatrix(g, entry.size), entry.size.width ?? g.width ?? 0, entry.size.height ?? g.height ?? 0))
  }

  // A resize (or a multi-object scale) changed the size of the model object: make the node from the model again, in the same place.
  function rebuild(entry) {
    const { object } = entry
    const index = world.children.indexOf(entry.node)
    const old = entry.node
    const slot = measuredText.findIndex((item) => item.object === object)
    if (slot !== -1) measuredText.splice(slot, 1)
    const stroke = uniformStrokes.findIndex((item) => item.node === old)
    if (stroke !== -1) uniformStrokes.splice(stroke, 1)
    entries.delete(entry.id)
    const at = boxes.indexOf(entry.box)
    if (at !== -1) boxes.splice(at, 1)
    addObject(world, object, boxes, index)
    old.remove()
  }

  // The selection holds nodes; when nodes are made again or taken away, the same objects are selected again afterwards.
  function keepingSelection(change) {
    const keep = editorEntries().map((entry) => entry.id)
    editing.clear()
    try { change() } finally { editing.select(keep.map((id) => entries.get(id)?.node).filter(Boolean)) }
  }

  // ---- edits. The document is an immutable value the host owns (and the undo history keeps): an edit is an `op` of { id, before, after }
  // changes planned by core/document/operations.js, handed to `onOperation`, which returns the new document.

  const objectsById = (document) => new Map(document.objects.filter((object) => object?.id !== undefined).map((object) => [object.id, object]))

  // Moves every node (and its box and rect) by whole page distances: the page frame's origin moved because pages were added or folded on the
  // top or left. The host moves the view by the same amount, so nothing seems to move.
  function shiftNodes(by) {
    for (const entry of entries.values()) {
      entry.node.set({ x: entry.node.x + by.x, y: entry.node.y + by.y })
      if (entry.box) { entry.box.left += by.x; entry.box.top += by.y }
      if (entry.rect) { entry.rect.left += by.x; entry.rect.top += by.y }
    }
    editing.update()
  }

  // A connector's node from its model object (or from a trial layout while its ends are being dragged).
  function syncConnector(entry, object = entry.object) {
    entry.node.set(connectorProps(object))
    if (connectorSelected === entry.id) showHalo()
  }

  // Hands an op to the host, takes the document it returns, and points the entries at the new objects. The op is first made whole
  // (pages.js finalizeOp): the connectors that follow what moved, the connectors left without an end, and the page growth or fold-back the
  // edit causes, with every object moved when pages are added on the top or left: all of it one undo step.
  function commit(op, { coalesce, selection } = {}) {
    if (!op.changes.length && !op.page) return false
    const named = new Set(op.changes.map((change) => change.id))
    const { op: whole, shift } = finalizeOp(doc, op, { sizeOf })
    if (!whole.changes.length && !whole.page) return false
    // The view has followed the growth the drag made already; it follows the rest, and the note's layer goes back to the view's own place.
    const viewShift = { x: shift.x - live.shift.x, y: shift.y - live.shift.y }
    const offset = live.shift
    live.shift = { x: 0, y: 0 }
    const handed = { ...whole, viewShift }
    if (selection) handed.selection = selection
    committing = true
    try { doc = onOperation(handed, { coalesce }) ?? applyChanges(doc, whole) } finally { committing = false }
    const latest = objectsById(doc)
    for (const change of whole.changes) {
      const entry = entries.get(change.id)
      if (!entry) continue
      if (change.after) entry.object = latest.get(change.id) ?? change.after
      else if (!named.has(change.id)) dropEntry(entry) // a connector left without an end (the edit's own removals are dropped by its caller)
    }
    if (shift.x || shift.y) shiftNodes(shift)
    if (offset.x || offset.y) applyView() // the note's layer goes back to the view's own place, in the same frame as the nodes catch up
    if (whole.page) pages = { columns: whole.page.after.columns, rows: whole.page.after.rows }
    for (const change of whole.changes) {
      const entry = entries.get(change.id)
      if (!entry || !change.after) continue
      if (entry.object.type === 'connector') syncConnector(entry)
      else if (entry.rect) entry.rect = boundingRect(entry.object, entry.size)
    }
    placeEditor()
    return true
  }

  const editorEntries = () => editing.nodes().map((node) => entryOfNode.get(node)).filter(Boolean) // the editor's own (never a connector)
  const selectedEntries = () => {
    const picked = editorEntries()
    const arrow = connectorSelected && entries.get(connectorSelected)
    return picked.length ? picked : arrow ? [arrow] : []
  }
  const selectedIds = () => selectedEntries().map((entry) => entry.id)

  // ---- a drag, a resize or a turn in progress (F-032): the arrows follow live, pages appear as the object nears an edge, the dragged object
  // lifts and the page that would be added is previewed. None of it touches the document until the gesture ends (flushGesture).

  // Where a selected node is now, as a rect on the page (the same measure the model rules use).
  function liveRect(entry) {
    const { node, object } = entry
    if (live.kind === 'move') { // a drag is a pure move: the model geometry moved by how far the node has come (the lift's tilt turns about the node's own corner, which stays put)
      const g = { ...object.geometry, x: object.geometry.x + (node.x - entry.liveBase.x), y: object.geometry.y + (node.y - entry.liveBase.y) }
      return boundingRect({ ...object, geometry: g }, entry.size)
    }
    const size = entry.built.sized ? { width: node.width, height: node.height } : entry.size
    const g = geometryFromMatrix(node.localTransform, size, object.geometry, { bake: Boolean(entry.built.sized) })
    return boundingRect({ ...object, geometry: g }, size)
  }

  function startLift(list) {
    const scale = view.scale
    for (const entry of list) {
      if (isLocked(entry.object)) continue
      const { node } = entry
      const item = { entry, rotation: node.rotation, shadow: node.shadow, index: world.children.indexOf(node) }
      node.rotation = node.rotation + LIFT_TILT_DEGREES
      node.shadow = { x: 0, y: LIFT_SHADOW.offsetY / scale, blur: LIFT_SHADOW.blur / scale, color: `rgba(0, 0, 0, ${LIFT_SHADOW.alpha})` }
      live.lifted.push(item)
    }
    live.lifted.sort((a, b) => a.index - b.index)
    for (const item of live.lifted) overlays.dragLayer.add(item.entry.node) // out of the note's layer: a drag repaints only what moves
  }

  function endLift() {
    for (const item of live.lifted) {
      const { node } = item.entry
      node.rotation = item.rotation
      node.shadow = item.shadow ?? undefined
      world.addAt(node, Math.min(item.index, world.children.length))
    }
    live.lifted = []
  }

  function beginGesture(kind, list) {
    live.active = true
    live.kind = kind
    const moving = new Set(list.map((entry) => entry.id))
    let rest = null
    for (const entry of entries.values()) {
      if (!entry.rect || moving.has(entry.id)) continue
      const edges = rectEdges(entry.rect)
      rest = rest ? { left: Math.min(rest.left, edges.left), top: Math.min(rest.top, edges.top), right: Math.max(rest.right, edges.right), bottom: Math.max(rest.bottom, edges.bottom) } : edges
    }
    live.rest = rest
    for (const entry of list) entry.liveBase = { x: entry.node.x, y: entry.node.y }
    if (kind === 'move') startLift(list)
  }

  const unionOf = (a, b) => (a && b ? { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) } : a ?? b)

  function onGesture(kind) {
    const list = editorEntries()
    if (!list.length) return
    if (!live.active) beginGesture(kind, list)
    for (const entry of list) entry.live = { rect: liveRect(entry) }
    // the arrows on what moves follow it
    const arrows = new Set()
    for (const entry of list) for (const id of linked.get(entry.id) ?? []) arrows.add(id)
    for (const id of arrows) {
      const arrow = entries.get(id)
      const from = entries.get(arrow?.object.fromId)
      const to = entries.get(arrow?.object.toId)
      if (!arrow || !from?.rect || !to?.rect) continue
      syncConnector(arrow, withLayout(arrow.object, connectorLayout(from.live?.rect ?? from.rect, to.live?.rect ?? to.rect)))
    }
    // pages appear before the object reaches an edge, in every direction
    let bounds = null
    for (const entry of list) bounds = unionOf(bounds, rectEdges(entry.live.rect))
    const inGrid = (box) => ({ left: box.left + live.shift.x, top: box.top + live.shift.y, right: box.right + live.shift.x, bottom: box.bottom + live.shift.y })
    const grow = growForDrag(pages, inGrid(unionOf(live.rest, bounds)))
    if (grow.changed) {
      pages = { columns: grow.columns, rows: grow.rows }
      live.shift = { x: live.shift.x + grow.shiftX, y: live.shift.y + grow.shiftY }
      live.grown = true
      onPages({ columns: grow.columns, rows: grow.rows, shiftX: grow.shiftX, shiftY: grow.shiftY }) // the host sets its grid and moves the view by the shift
    }
    bounds = inGrid(bounds)
    // the page that would be added next, previewed
    if (kind === 'move') {
      const ghost = nextPageGhost(bounds, { columns: pages.columns, rows: pages.rows, pageW: PAGE.width, pageH: PAGE.height, reach: GHOST_REACH })
      const key = JSON.stringify(ghost)
      if (key !== live.ghost) { live.ghost = key; overlays.showGhost(ghost) }
    }
  }

  // Back to rest: the lift is put down, the preview goes, nothing of the gesture stays on the nodes.
  function endGesture() {
    endLift()
    overlays.showGhost(null)
    for (const entry of entries.values()) { entry.live = null; entry.liveBase = null }
    live.active = false
    live.kind = null
    live.rest = null
    live.shift = { x: 0, y: 0 }
    live.grown = false
    live.ghost = ''
  }

  // The editor has finished a gesture: read where each selected node ended up and commit it as one step.
  function flushGesture() {
    const ids = selectedIds()
    endLift() // the tilt comes off before the nodes are read
    const changes = []
    const rebuilds = []
    for (const entry of editorEntries()) {
      const { node, object } = entry
      const size = entry.built.sized ? { width: node.width, height: node.height } : entry.size
      const next = geometryFromMatrix(node.localTransform, size, object.geometry, { bake: Boolean(entry.built.sized) })
      const before = object.geometry
      const same = ['x', 'y', 'width', 'height', 'rotation', 'scaleX', 'scaleY', 'skewX'].every((key) => Math.abs((next[key] ?? 0) - (before[key] ?? (key.startsWith('scale') ? 1 : 0))) < 1e-6)
      if (same) continue
      const plan = planSetGeometry(doc, { id: entry.id, geometry: next })
      if (!plan.op.changes.length) continue
      changes.push(...plan.op.changes)
      entry.size = { width: next.width, height: next.height }
      if (entry.built.sized) rebuilds.push(entry) // the size may have changed: shadow, wrapping and sticky corners are made again from the model
    }
    const grew = live.grown
    const dragShift = live.shift
    const committed = commit({ label: 'Transform', changes }, { selection: { before: ids, after: ids } })
    // The grid the document holds is the one that counts now. A step that records a page change has told the host already; when the edit
    // left the grid as it was (the object came back) or nothing was recorded, the pages the drag added go again.
    if (grew && (!committed || pages.columns !== doc.page.columns || pages.rows !== doc.page.rows)) {
      live.shift = { x: 0, y: 0 }
      pages = { columns: doc.page.columns, rows: doc.page.rows }
      onPages({ ...pages, shiftX: committed ? 0 : -dragShift.x, shiftY: committed ? 0 : -dragShift.y })
    }
    endGesture()
    if (!committed) return
    for (const entry of rebuilds) refreshBox(entry)
    if (rebuilds.length) keepingSelection(() => { for (const entry of rebuilds) rebuild(entry) })
    for (const entry of editorEntries()) refreshBox(entry)
  }

  const editing = createEditing({
    app,
    onResize(node) { entryOfNode.get(node)?.built.relayout?.() },
    onGesture,
    onGestureEnd: flushGesture,
    onSelect(nodes) {
      if (nodes.length) { lastEdited = null; if (connectorSelected) selectConnector(null, true) }
      const ids = nodes.map((node) => entryOfNode.get(node)?.id).filter(Boolean)
      for (const listener of selectionListeners) listener(ids)
    },
  })

  // After a reorder (or an undo of one): put the nodes whose place in the stack changed where the document says.
  function syncStacking(ids) {
    const nodes = stacking(doc).map((object) => entries.get(object.id)?.node).filter(Boolean)
    const changed = new Set(ids)
    nodes.forEach((node, position) => { if (changed.has(entryOfNode.get(node)?.id) && world.children[position] !== node) world.addAt(node, position) })
  }

  function dropEntry(entry) {
    entries.delete(entry.id)
    if (entry.object.type === 'connector') { unlink(entry.object); if (connectorSelected === entry.id) selectConnector(null) }
    const stroke = uniformStrokes.findIndex((item) => item.node === entry.node)
    if (stroke !== -1) uniformStrokes.splice(stroke, 1)
    const at = boxes.indexOf(entry.box)
    if (at !== -1) boxes.splice(at, 1)
    const slot = measuredText.findIndex((item) => item.object === entry.object)
    if (slot !== -1) measuredText.splice(slot, 1)
    entry.node.remove()
  }

  // ---- connectors (F-032): picked by their line (never by the whole diagonal box), apart from the editor's selection, drawn with a halo while
  // selected, and deleted with Delete (or with an end). A connector is never moved by hand; it only follows its ends.
  function selectConnector(id, silent = false) {
    if (connectorSelected === id) return
    connectorSelected = id
    showHalo()
    if (!silent) for (const listener of selectionListeners) listener(selectedIds())
  }

  function showHalo() {
    const entry = connectorSelected && entries.get(connectorSelected)
    overlays.showHalo(entry ? { path: arrowPath(entry.object), x: entry.object.geometry.x, y: entry.object.geometry.y, lineWidth: entry.object.lineWidth ?? CONNECTOR_DEFAULTS.lineWidth } : null)
  }

  // A press on a connector's line picks it (and leaves the editor's selection); a press anywhere else lets the editor have it.
  host.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target === overlay.element || !doc) return
    const rect = host.getBoundingClientRect()
    const point = { x: (event.clientX - rect.left - view.x) / view.scale, y: (event.clientY - rect.top - view.y) / view.scale }
    const arrow = connectorAt(doc.objects, point, CONNECTOR_HIT / view.scale)
    if (!arrow || !entries.has(arrow.id)) { if (connectorSelected) selectConnector(null); return }
    event.stopPropagation()
    editing.clear()
    selectConnector(arrow.id)
  }, true)

  // ---- text and sticky editing (F-029). The words are typed in a real textarea laid over them (text.js); this is the glue between that
  // overlay, the nodes and the document. A typing session is ONE undo step: it runs inside one history group (onBegin/onEnd), and the
  // words typed so far go into the document a moment after the typing pauses (never in the middle of an input-method composition), so
  // they are saved as they are typed. A new text is made at its first such moment (and never at all when nothing is typed); a new
  // sticky is made at once (an empty sticky stays, as in the Fabric path). An emptied text is removed when the session ends.
  const overlay = createTextOverlay({ host })
  const DRAFT_DELAY = 650 // the save delay
  let textEdit = null // { id, entry|null, object, size, select, caret }
  let draftTimer = 0
  let lastEdited = null // the id of the text just edited with nothing selected (the Text tool): the style controls apply to it
  const isTextual = (object) => object?.type === 'text' || object?.type === 'sticky'
  const LAYOUT_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'charSpacing', 'textAlign', 'underline', 'linethrough']

  const wrapWidth = (object) => (object.type === 'sticky' ? (object.geometry.width ?? 240) - STICKY_PADDING * 2 : object.mode === 'point' ? undefined : object.geometry.width)

  // How big the words are once laid out ({ width, height }, inside a sticky's padding), measured on a scratch node.
  function contentSize(object) {
    const props = textProps(object, { width: wrapWidth(object) })
    const scratch = new Text({ ...props, x: 0, y: 0 })
    const size = measure(scratch)
    scratch.destroy?.()
    return size
  }

  const viewMatrix = () => ({ a: view.scale, b: 0, c: 0, d: view.scale, e: view.x, f: view.y })
  const textOffset = (object) => { const props = textProps(object, { width: wrapWidth(object), padding: object.type === 'sticky' ? STICKY_PADDING : 0 }); return { x: props.x, y: props.y } }
  // The overlay sits over the text node: its frame is the text's own (the node's offset inside the object, then the object's matrix, then the view).
  function overlayMatrix() {
    const { object, size } = textEdit
    const at = textOffset(object)
    return multiplyMatrices(viewMatrix(), multiplyMatrices(placementMatrix(object.geometry, size), { a: 1, b: 0, c: 0, d: 1, e: at.x, f: at.y }))
  }

  function overlayFont(object) {
    const props = textProps(object, { width: wrapWidth(object) })
    return { family: props.fontFamily, size: props.fontSize, weight: props.fontWeight, italic: props.italic, lineHeight: props.lineHeight, letterSpacing: props.letterSpacing, align: props.textAlign, color: props.fill, decoration: props.textDecoration === 'under' ? 'underline' : props.textDecoration === 'delete' ? 'line-through' : 'none', baseline: (props.lineHeight + 0.7 * props.fontSize) / 2 }
  }

  // `began`: the caller already opened the history group (a new sticky); otherwise it is opened here. `point`: a page point to put the caret at.
  function startTextEdit(object, { entry = null, began = false, select = true, point = null } = {}) {
    if (overlay.isOpen) overlay.commit()
    if (!began) onBegin('Edit text')
    const size = entry ? entry.size : { width: object.geometry.width ?? 0, height: object.geometry.height ?? 0 }
    textEdit = { id: object.id, entry, object, size, select }
    lastEdited = null
    editing.clear()
    if (entry?.built.text) entry.built.text.visible = false
    const width = wrapWidth(object)
    let caret = null
    if (point) {
      const local = toLocal(object.geometry, size, point)
      if (local) { const at = textOffset(object); caret = { x: local.x - at.x, y: local.y - at.y } }
    }
    overlay.open({
      value: object.content ?? '',
      font: overlayFont(object),
      wrap: width !== undefined,
      width: width ?? 0,
      matrix: overlayMatrix(),
      caret,
      onInput: onTextInput,
      onCommit: finishTextEdit,
      onEscape: () => onTextEvent('escape'),
    })
    onTextEvent('start')
    return true
  }

  function onTextInput(content) {
    const edit = textEdit
    if (!edit) return
    // A sticky is as tall as its words need, the paper following the text while it is typed.
    const entry = edit.entry
    if (entry && entry.object.type === 'sticky' && content) {
      const wanted = fitGeometry(entry.object, content).height
      if (wanted !== entry.node.height) { entry.node.height = wanted; entry.built.relayout?.() }
    }
    clearTimeout(draftTimer)
    draftTimer = setTimeout(flushDraft, DRAFT_DELAY)
  }

  // The words typed so far go into the document (and so into a save), inside the session's one history group.
  function flushDraft() {
    const edit = textEdit
    if (!edit || !overlay.isOpen) return
    if (overlay.composing) { draftTimer = setTimeout(flushDraft, 200); return } // never in the middle of a composition
    storeWords(edit, overlay.value, { final: false })
  }

  // Puts `value` into the model for the edit's object (making a new text when it has words). Returns false when nothing changed.
  function storeWords(edit, value, { final }) {
    if (!edit.entry) { // a new text: it exists from its first words
      if (!value.trim()) return false
      const next = { ...edit.object, content: value }
      const placed = { ...next, geometry: fitGeometry(next, contentSize(next)) }
      commit({ label: 'Add text', changes: [{ id: placed.id, before: null, after: placed }] }, { selection: { before: [], after: [placed.id] } })
      addObject(world, doc.objects.find((candidate) => candidate?.id === placed.id) ?? placed, boxes)
      const entry = entries.get(placed.id)
      if (!entry) return false
      if (entry.built.text && !final) entry.built.text.visible = false
      edit.entry = entry
      edit.object = entry.object
      edit.size = { ...entry.size }
      return true
    }
    const { entry } = edit
    const object = entry.object
    if ((object.content ?? '') === value) return false
    if (object.type === 'text' && !value.trim() && !final) return false // an emptied text is removed when the session ends
    const next = { ...object, content: value }
    const plan = planSetContent(doc, { id: entry.id, content: value, geometry: fitGeometry(next, contentSize(next)) })
    if (!plan.op.changes.length) return false
    commit(plan.op, { selection: { before: [entry.id], after: [entry.id] } })
    edit.object = entry.object
    edit.size = { width: entry.object.geometry.width ?? 0, height: entry.object.geometry.height ?? 0 }
    return true
  }

  function finishTextEdit(value) {
    clearTimeout(draftTimer)
    const edit = textEdit
    textEdit = null
    if (!edit) return
    try {
      const entry = edit.entry
      if (entry && entry.object.type === 'text' && !value.trim()) { // an emptied text goes
        const removal = planRemove(doc, { ids: [entry.id] })
        commit(removal.op, { selection: { before: [entry.id], after: [] } })
        for (const change of removal.op.changes) { const gone = entries.get(change.id); if (gone) dropEntry(gone) }
        if (entries.get(entry.id) === entry) dropEntry(entry)
        return
      }
      storeWords(edit, value, { final: true })
      const made = edit.entry
      if (!made) return // nothing was typed into a new text
      refreshBox(made)
      rebuild(made) // the node is made again from the model: new words, size and shadow, and its text shown again
      const node = entries.get(made.id)?.node
      if (edit.select && node) editing.select([node])
      else if (!edit.select) lastEdited = made.id
    } finally {
      const live = edit.entry && entries.get(edit.entry.id)
      if (live?.built.text) live.built.text.visible = true
      onEnd()
      onTextEvent('end')
    }
  }

  const newId = () => `res_${globalThis.crypto.randomUUID().replaceAll('-', '')}`

  // Puts the overlay back over its text (the view moved or was resized).
  function placeEditor() { if (textEdit && overlay.isOpen) overlay.setMatrix(overlayMatrix()) }

  // The text and stickies the style controls act on: the selection, or the text just edited with the Text tool.
  function styleTargets() {
    const picked = selectedEntries().filter((entry) => isTextual(entry.object))
    if (picked.length || selectedEntries().length) return picked
    const entry = lastEdited && entries.get(lastEdited)
    return entry && isTextual(entry.object) ? [entry] : []
  }

  const textApi = {
    isEditingText: () => overlay.isOpen,
    // Before a merge: the words typed so far go into the document now (not in the middle of a composition, which cannot be read yet).
    // Returns the id of the object being typed (it counts as the user's in the merge), or null.
    flushText() {
      if (!textEdit || !overlay.isOpen) return null
      if (!overlay.composing) { clearTimeout(draftTimer); storeWords(textEdit, overlay.value, { final: false }) }
      return textEdit.entry?.id ?? null
    },
    // Ends a text edit in progress (the words typed so far are kept). The host calls it before it saves or leaves the note.
    finishTextEdit() { if (overlay.isOpen) overlay.commit() },
    // Starts editing the words of a text or sticky (by id, or the topmost one at a page point, with the caret there). False when nothing editable is there.
    editText(target, options = {}) {
      const byPoint = typeof target !== 'string'
      const object = byPoint ? objectAt(doc, new Map([...entries].map(([id, entry]) => [id, entry.size])), target) : doc.objects.find((candidate) => candidate?.id === target)
      const entry = object && entries.get(object.id)
      if (!entry || !isTextual(entry.object) || isLocked(entry.object)) return false
      return startTextEdit(entry.object, { entry, select: options.select ?? true, point: byPoint ? target : null })
    },
    // A new text at a page point (typed in the overlay; nothing is made until there are words).
    createText(point, options = {}) {
      const object = newText({ id: newId(), z: nextZ(doc), point, style: defaults.text?.() ?? {} })
      return startTextEdit(object, { select: options.select ?? true })
    },
    // A new sticky centred on a page point: made at once, selected, with its first words in the same undo step.
    createSticky(point) {
      const { fill, ink, style } = defaults.sticky?.() ?? { fill: '#ffd60a', ink: '#292202', style: {} }
      const object = newSticky({ id: newId(), z: nextZ(doc), point, fill, ink, style })
      if (overlay.isOpen) overlay.commit()
      onBegin('Add sticky')
      commit({ label: 'Add sticky', changes: [{ id: object.id, before: null, after: object }] }, { selection: { before: [], after: [object.id] } })
      addObject(world, doc.objects.find((candidate) => candidate?.id === object.id) ?? object, boxes)
      const entry = entries.get(object.id)
      if (!entry) { onEnd(); return false }
      return startTextEdit(entry.object, { entry, began: true })
    },
    // What Leafer drew for a text or sticky (for checks): its lines, and the font it used.
    textInfo(id) {
      const node = entries.get(id)?.built.text
      if (!node) return null
      const rows = node.__?.__textDrawData?.rows ?? []
      return { rows: rows.map((row) => row.text), fontSize: node.fontSize, fontFamily: node.fontFamily, fill: node.fill, visible: node.visible, lineHeight: node.lineHeight, height: node.getBounds('box', 'inner').height }
    },
    // The text and stickies the style controls act on.
    selectedText: () => styleTargets().map((entry) => ({ id: entry.id, type: entry.object.type, style: entry.object.style ?? {}, color: entry.object.color })),
    // Font, size, colour of those (`style`), or the sticky paper (`paper`: { fill, ink }). One step (a slider drag is one).
    setTextStyle({ style, paper }) {
      const targets = styleTargets()
      const ids = targets.map((entry) => entry.id)
      const plan = planSetStyle(doc, { ids, style, paper })
      if (!plan.op.changes.length) return false
      const relayout = style && Object.keys(style).some((key) => LAYOUT_KEYS.includes(key))
      const changes = plan.op.changes.map((change) => (relayout ? { ...change, after: { ...change.after, geometry: fitGeometry(change.after, contentSize(change.after)) } } : change))
      commit({ label: plan.op.label, changes }, { coalesce: 'text-style', selection: { before: ids, after: ids } })
      keepingSelection(() => { for (const change of changes) { const entry = entries.get(change.id); if (entry) { refreshBox(entry); rebuild(entry) } } })
      return true
    },
  }

  // A double click on a text or sticky edits it; on empty paper it makes a new text (the Fabric path does the same).
  host.addEventListener('dblclick', (event) => {
    if (event.button !== 0 || event.target === overlay.element) return
    const rect = host.getBoundingClientRect()
    const point = { x: (event.clientX - rect.left - view.x) / view.scale, y: (event.clientY - rect.top - view.y) / view.scale }
    if (textApi.editText(point)) return
    if (boxes.some((box) => point.x >= box.left && point.x <= box.left + box.width && point.y >= box.top && point.y <= box.top + box.height)) return
    textApi.createText(point)
  })

  // ---- pictures (F-033). media.js prepares and uploads them; each is one model object that references the media library file.
  const pictureApi = {
    // `pictures`: [{ mediaId, url, width, height }] (the stored size of each), placed around a page point as one undo step; the last is selected.
    addImages(pictures, point) {
      if (!pictures.length) return []
      if (overlay.isOpen) overlay.commit()
      onBegin('Add picture')
      const ids = []
      try {
        pictures.forEach((picture, index) => {
          mediaUrls.set(picture.mediaId, picture.url)
          const object = newImage({ id: newId(), z: nextZ(doc), mediaId: picture.mediaId, width: picture.width, height: picture.height, point, index })
          commit({ label: 'Add picture', changes: [{ id: object.id, before: null, after: object }] }, { selection: { before: [], after: [object.id] } })
          addObject(world, doc.objects.find((candidate) => candidate?.id === object.id) ?? object, boxes)
          if (entries.has(object.id)) ids.push(object.id)
        })
      } finally { onEnd() }
      if (ids.length) editing.select([entries.get(ids.at(-1)).node])
      return ids
    },
    // A point in client (window) pixels -> the page point under it.
    pageAt(clientX, clientY) {
      const rect = host.getBoundingClientRect()
      return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale }
    },
  }

  // ---- output (F-033): the note as it prints and exports, drawn from the model on a leafer of its own (white paper, no page furniture,
  // no handles), so the screen's view, selection and chrome never reach it. `region` is a rectangle of the page grid, in page pixels.
  async function renderRegion(region, { pixelRatio = 2, type = 'image/png', quality } = {}) {
    await document.fonts?.ready // text is laid out with the fonts that are loaded now, never a fallback
    const surface = document.createElement('canvas')
    const sheet = new Leafer({ view: surface, width: region.width, height: region.height, pixelRatio, type: 'draw', hittable: false })
    const marks = { text: textNodes.length, measured: measuredText.length, strokes: uniformStrokes.length }
    const counted = { ...stats }
    const group = new Group({ x: -region.x, y: -region.y, hittable: false })
    try {
      sheet.add(group)
      for (const object of stacking(doc)) addObject(group, object, null)
      // The bookkeeping addObject keeps for the live view is not for these nodes; a uniform stroke is its own width at scale 1.
      for (const item of uniformStrokes.splice(marks.strokes)) item.node.strokeWidth = item.width
      textNodes.length = marks.text
      measuredText.length = marks.measured
      Object.assign(stats, counted) // what the screen drew is what stats() reports, not these copies
      await new Promise((resolve) => { sheet.waitViewCompleted(() => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
      // White paper under whatever is transparent, as the Fabric print sheet had it.
      const paper = document.createElement('canvas')
      paper.width = surface.width
      paper.height = surface.height
      const context = paper.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, paper.width, paper.height)
      context.drawImage(surface, 0, 0)
      return await new Promise((resolve, reject) => paper.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not draw the page'))), type, quality))
    } finally { sheet.destroy() }
  }

  const api = {
    leafer,
    ...textApi,
    ...pictureApi,
    renderRegion,
    // Draws a note. `next` is a document model (fromFabric output); `options.resolveMedia` turns a media-library picture into a URL.
    load(next, options = {}) {
      if ('resolveMedia' in options) resolveMedia = options.resolveMedia ?? null // a redraw from the document (undo, redo, an erase pass given up) keeps the pictures the note was opened with
      if (overlay.isOpen) overlay.commit() // words being typed are kept
      if ('resolveMedia' in options) { for (const url of mediaUrls.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url); mediaUrls.clear() } // a note is opened: the pictures added to the one before are not needed
      lastEdited = null
      doc = next
      endGesture()
      connectorSelected = null
      overlays.showHalo(null)
      editing.clear()
      world.clear()
      entries.clear()
      linked.clear()
      textNodes.length = 0
      measuredText.length = 0
      uniformStrokes.length = 0
      boxes = []
      stats = { drawn: 0, skipped: 0, unknown: 0, images: 0 }
      for (const object of stacking(doc)) addObject(world, object, boxes)
      pages = { columns: doc.page?.columns ?? 1, rows: doc.page?.rows ?? 1 }
      drawChrome()
    },
    // True while the scene is handing its own edit to the host (so the host does not draw it a second time).
    isCommitting: () => committing,
    document: () => doc,
    // The same document, held by the history now (a new open, an agent's merge): the objects are equal, so only the references change.
    adopt(next) {
      doc = next
      const latest = objectsById(doc)
      for (const entry of entries.values()) entry.object = latest.get(entry.id) ?? entry.object
    },
    // An agent's changes merged into the document (core/document/merge.js): only the objects that differ are drawn again, the
    // selection stays, and a text being typed keeps its editor (its new model is used when the session ends).
    applyMerged(next, options = {}) {
      if (options.resolveMedia) resolveMedia = options.resolveMedia
      const before = objectsById(doc)
      const after = objectsById(next)
      doc = next
      const editingId = textEdit?.id
      keepingSelection(() => {
        for (const entry of [...entries.values()]) {
          const object = after.get(entry.id)
          if (object === entry.object) continue
          if (!object) {
            if (entry.id === editingId) continue // never taken from under the typing: the merge treats it as the user's, so this is not reached
            dropEntry(entry)
            continue
          }
          entry.object = object
          if (entry.id === editingId) { textEdit.object = object; textEdit.size = { width: object.geometry.width ?? 0, height: object.geometry.height ?? 0 }; continue }
          rebuild(entry)
        }
        for (const object of stacking(doc)) if (object?.id !== undefined && !before.has(object.id) && !entries.has(object.id)) addObject(world, object, boxes)
      })
      placeEditor()
      pages = { columns: doc.page?.columns ?? pages.columns, rows: doc.page?.rows ?? pages.rows }
      drawChrome()
    },
    setPages(next) { pages = { ...next }; drawChrome() },
    setColors(next) { colors = next; overlays.setColors(next); drawChrome() },
    setView(next) { view = { ...next }; applyView() },
    resize(nextWidth, nextHeight) {
      size = { width: nextWidth, height: nextHeight }
      app.resize({ width: nextWidth, height: nextHeight })
      drawChrome()
    },
    // Text layout is cached per element and text without a stored size was measured with whatever font was loaded then. Call after
    // web fonts finish loading: layout is redone, such text is measured and placed again, and its placement box follows.
    refreshText() {
      textNodes.forEach((node) => node.forceUpdate?.())
      for (const item of measuredText) {
        const g = item.object.geometry
        const measured = measure(item.built.text)
        const size = { width: g.width ?? measured.width, height: g.height ?? measured.height }
        const matrix = placementMatrix(g, size)
        place(item.built.node, matrix)
        if (item.built.sized) item.built.node.set({ width: size.width, height: size.height })
        const entry = entries.get(item.object.id)
        if (entry) entry.size = size
        if (item.box) Object.assign(item.box, boxOf(matrix, size.width, size.height))
      }
    },
    boxes: () => boxes,
    stats: () => ({ ...stats, drawn: entries.size }),

    // ---- selection and edits (F-028)
    onSelection(listener) { selectionListeners.add(listener); return () => selectionListeners.delete(listener) },
    selection: selectedIds,
    select(ids) {
      const arrow = ids.find((id) => entries.get(id)?.object.type === 'connector')
      editing.select(ids.filter((id) => id !== arrow).map((id) => entries.get(id)?.node).filter(Boolean))
      selectConnector(arrow && !editorEntries().length ? arrow : null)
    },
    clearSelection() { editing.clear(); selectConnector(null) },
    selectAll() { editing.select([...entries.values()].filter((entry) => entry.object.type !== 'connector' && !isLocked(entry.object)).map((entry) => entry.node)) },
    isLocked: (id) => isLocked(entries.get(id)?.object),

    // ---- connectors and the connect tool (F-032)
    // The topmost object under a page point that a connector can join (a pen line only when nothing else is there), or null.
    connectTargetAt(point, exclude = null) {
      let ink = null
      for (const object of stacking(doc).reverse()) {
        if (object.id === exclude || !object.geometry || object.type === 'connector' || object.type === 'unknown' || object.visible === false) continue
        const entry = entries.get(object.id)
        if (!entry) continue
        const width = object.geometry.width ?? entry.size.width ?? 0
        const height = object.geometry.height ?? entry.size.height ?? 0
        const local = toLocal(object.geometry, { width, height }, point)
        if (!local || local.x < 0 || local.x > width || local.y < 0 || local.y > height) continue
        if (object.type === 'ink') ink ||= object.id
        else return object.id
      }
      return ink
    },
    // The connect tool's preview over the note: { source, hover, pointer } (ids and a page point), or null for none.
    connectPreview(spec) {
      const rectOf = (id) => entries.get(id)?.rect
      if (spec?.source && rectOf(spec.source)) {
        const from = rectOf(spec.source)
        const target = spec.hover ? rectOf(spec.hover) : null
        const goal = target ?? { left: spec.pointer.x, top: spec.pointer.y, width: 0, height: 0 }
        const ends = connectorEndpoints(from, goal, target ? undefined : 0)
        overlays.showConnect({ outlines: target ? [from, target] : [from], dots: ends.visible ? (target ? [ends.start, ends.end] : [ends.start]) : [], arrow: ends.visible ? ends : null })
      } else if (spec?.hover && rectOf(spec.hover)) {
        const box = rectOf(spec.hover)
        overlays.showConnect({ outlines: [box], dots: [{ x: box.left + box.width / 2, y: box.top + box.height / 2 }], arrow: null })
      } else overlays.showConnect(null)
    },
    // An arrow from one object to another, as one undo step. Returns its id, or null when there is nothing to show (the same object, the pair is
    // already joined, or the two are too close for an arrow).
    createConnector(fromId, toId, color) {
      const object = newConnector(doc.objects, { fromId, toId, color, z: nextZ(doc), rectOf: (target) => boundingRect(target, sizeOf(target)) })
      if (!object) return null
      const ids = editorEntries().map((entry) => entry.id)
      commit({ label: 'Connect', changes: [{ id: object.id, before: null, after: object }] }, { selection: { before: ids, after: ids } })
      addObject(world, doc.objects.find((candidate) => candidate?.id === object.id) ?? object, boxes)
      return object.id
    },
    // The document with every connector brought in line with the objects it joins (a note saved by an older app, or an agent that moved an end).
    followConnectors(next) {
      const changes = followChanges(next.objects, null, (object) => boundingRect(object, sizeOf(object)))
      return changes.length ? applyChanges(next, { changes }) : next
    },
    connectorAt: (point) => connectorAt(doc?.objects ?? [], point, CONNECTOR_HIT / view.scale)?.id ?? null,
    selectedConnector: () => connectorSelected,
    // For checks: what a drag in progress has put on screen.
    dragState: () => ({ active: live.active, lifted: live.lifted.map((item) => item.entry.id), tilt: live.lifted.map((item) => item.entry.node.rotation - item.rotation), ghost: live.ghost ? JSON.parse(live.ghost) : null, shift: { ...live.shift } }),
    gridNow: () => ({ ...pages }),

    // Arrow keys: move the selection by (dx, dy) page pixels. Locked objects stay. Repeated nudges are one undo step.
    nudge(dx, dy) {
      const targets = editorEntries()
      const ids = targets.map((entry) => entry.id)
      const plan = planMove(doc, { ids, dx, dy })
      if (!plan.op.changes.length) return false
      const moved = new Set(plan.op.changes.map((change) => change.id))
      commit(plan.op, { coalesce: 'nudge', selection: { before: ids, after: ids } })
      for (const entry of targets) {
        if (!moved.has(entry.id)) continue
        entry.node.set({ x: entry.node.x + dx, y: entry.node.y + dy })
        refreshBox(entry)
      }
      editing.update()
      return true
    },

    // Delete: locked objects stay, connectors of a deleted object go with it, a page the removal empties folds back; one step.
    deleteSelection() {
      const ids = selectedIds()
      const plan = planRemove(doc, { ids })
      if (!plan.op.changes.length) return false
      const removing = plan.op.changes.map((change) => change.id)
      commit(plan.op, { selection: { before: ids, after: [] } })
      editing.clear()
      selectConnector(null)
      for (const id of removing) { const entry = entries.get(id); if (entry) dropEntry(entry) }
      return true
    },

    reorderSelection(to) {
      const ids = editorEntries().map((entry) => entry.id)
      const plan = planReorder(doc, { ids, to })
      if (!plan.op.changes.length) return false
      commit(plan.op, { selection: { before: ids, after: ids } })
      syncStacking(plan.op.changes.map((change) => change.id))
      editing.update()
      return true
    },

    lockSelection(locked) {
      const ids = editorEntries().map((entry) => entry.id)
      const plan = planLock(doc, { ids, locked })
      if (!plan.op.changes.length) return false
      commit(plan.op, { selection: { before: ids, after: ids } })
      for (const change of plan.op.changes) configure(entries.get(change.id))
      if (ids.length > 1 && locked) editing.clear() // a locked object is only ever selected alone
      else editing.refresh()
      return true
    },

    // ---- ink (F-031): the pen and the eraser put model objects on screen without drawing the note again. ink.js owns the gesture and
    // the live stroke; these are the three things it needs from the scene.
    view: () => ({ ...view }),
    // Draws model objects (a new stroke, the pieces of a split one) as nodes at their place in the stack.
    inkAdd(objects) {
      for (const object of objects) {
        const z = object.z ?? 0
        let at = world.children.length
        for (let index = 0; index < world.children.length; index += 1) {
          if ((entryOfNode.get(world.children[index])?.object.z ?? 0) > z) { at = index; break }
        }
        addObject(world, object, boxes, at)
      }
    },
    inkRemove(ids) { for (const id of ids) { const entry = entries.get(id); if (entry) dropEntry(entry) } },
    // Hands the op to the host as one undo step. The nodes are already on screen (inkAdd / inkRemove).
    inkCommit: (op) => commit(op),
    // Paints now what changed (so the live stroke can go the moment its final version is on screen).
    flush() { leafer.renderer.render() },

    // Where an object is on screen (CSS pixels from the top-left of the Leafer view) and where its box corners are on the page.
    screenBox(id) {
      const node = entries.get(id)?.node
      if (!node) return null
      const { x, y, width, height } = node.getBounds('box', 'world')
      return { x, y, width, height }
    },
    pageCorners(id) {
      const entry = entries.get(id)
      if (!entry) return null
      const { node } = entry
      const w = entry.built.sized ? node.width : entry.size.width ?? 0
      const h = entry.built.sized ? node.height : entry.size.height ?? 0
      return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => {
        const p = node.getWorldPoint({ x, y })
        return { x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale }
      })
    },
    hasNode: (id) => entries.has(id),
    nodeOrder: () => world.children.map((node) => entryOfNode.get(node)?.id).filter(Boolean),

    // Resolves when pictures have decoded and the frame is on screen.
    whenSettled() {
      return new Promise((resolve) => {
        const finish = () => requestAnimationFrame(() => requestAnimationFrame(resolve))
        app.waitViewCompleted(finish)
      })
    },
    destroy() { overlay.cancel(); editing.destroy(); overlays.destroy(); app.destroy() },
  }
  return api
}
