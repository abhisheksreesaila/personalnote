// The Leafer adapter (F-027, F-028): draws a document-model note and edits it. Everything about WHERE an object goes comes from the
// documented model rules (placement.js: the one matrix per object, and its inverse; schema.js: frames, ink frame, group frames); this
// file only knows how to make each model type look like the Fabric render. Leafer is imported here and in editing.js (the
// selection and transform layer) and nowhere else. An edit is a document-model operation (operations.js); the nodes follow the model.
import { App, Box, Group, Ellipse, Image, MatrixHelper, Path, Rect, Text } from 'leafer-ui'
import { PAGE } from '../../core/document/index.js'
import { applyChanges, isLocked, planLock, planMove, planRemove, planReorder, planSetGeometry, stacking } from '../../core/document/operations.js'
import { arrowHeadPoints, endpointsFromBox } from '../editor/connectors.js'
import { STICKY_PADDING } from '../editor/objects.js'
import { FOLD_COLOR, FOLD_DASH, FOLD_WIDTH, LABEL_FONT_FAMILY, LABEL_FONT_SIZE, pageChrome } from './chrome.js'
import { createEditing, EDITOR_CONFIG } from './editing.js'
import { applyMatrix, geometryFromMatrix, placementMatrix } from './placement.js'
import { bakedStickyShadow, STICKY_CORNERS } from './sticky-shadow.js'
import { canvasFamily, fabricLineMetrics, withAlpha } from './style.js'

// What Fabric assumes for a text field a saved note leaves out (the model is sparse and does not write defaults).
const TEXT_DEFAULTS = { fontFamily: 'Times New Roman', fontSize: 40, fontWeight: 'normal', fontStyle: 'normal', lineHeight: 1.16, textAlign: 'left', color: 'rgb(0,0,0)' }
const SHAPE_DEFAULT_FILL = 'rgb(0,0,0)'
const CONNECTOR_HEAD = 15
const CONNECTOR_DEFAULTS = { lineWidth: 2.6, color: '#20201e' }

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
export function createScene({ host, width, height, onOperation = () => null }) {
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
  let doc = null // the document model on screen: edits change it, the nodes follow
  const entries = new Map() // object id -> { id, node, built }: every top-level object that has a node
  const entryOfNode = new WeakMap()

  // ---- page furniture (screen space), stacked: shadow bands, edge, paper, fold lines, labels
  const shadowGroup = new Group({ hittable: false })
  const labelGroup = new Group({ hittable: false })
  const edgeNode = new Rect({ hittable: false })
  const paperNode = new Rect({ hittable: false })
  const foldNode = new Path({ hittable: false, stroke: FOLD_COLOR, strokeWidth: FOLD_WIDTH, dashPattern: FOLD_DASH, strokeAlign: 'center', path: 'M 0 0' })
  for (const node of [shadowGroup, edgeNode, paperNode, foldNode, labelGroup]) chrome.add(node)
  const pool = { shadows: [], labels: [] }

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
        return { node: holder, size: { width: w, height: h }, sized: true, relayout }
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
        return { node: new Path({ ...base, ...blend, path: pathString(object.path), fill: undefined, ...strokeProps(color, object.width ?? 1, object.strokeUniform, object.cap, object.join) }), size: {} }
      }
      case 'image': {
        const ref = object.mediaRef
        const url = ref?.kind === 'inline' ? ref.dataUrl : resolveMedia?.(ref)
        if (typeof url !== 'string') return null
        stats.images += 1
        return { node: new Image({ ...base, url, width: g.width, height: g.height }), size: {}, sized: true }
      }
      case 'connector': {
        const { start, end } = endpointsFromBox({ left: 0, top: 0, width: g.width, height: g.height, reverseX: object.reverseX ?? false, reverseY: object.reverseY ?? false })
        const length = Math.hypot(end.x - start.x, end.y - start.y)
        const [tip, wingA, wingB] = arrowHeadPoints(start, end, Math.min(CONNECTOR_HEAD, length * 0.6))
        const tail = { x: (wingA.x + wingB.x) / 2, y: (wingA.y + wingB.y) / 2 }
        const color = isColor(object.color) ? object.color : CONNECTOR_DEFAULTS.color
        const path = `M ${start.x} ${start.y} L ${tail.x} ${tail.y} M ${tip.x} ${tip.y} L ${wingA.x} ${wingA.y} L ${wingB.x} ${wingB.y} Z`
        return { node: new Path({ ...base, hittable: false, path, fill: color, ...strokeProps(color, object.lineWidth ?? CONNECTOR_DEFAULTS.lineWidth, false, 'round', 'round') }), size: {} }
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
    world.set({ x: view.x, y: view.y, scaleX: view.scale, scaleY: view.scale })
    for (const entry of uniformStrokes) entry.node.strokeWidth = entry.width * view.scale
    drawChrome()
  }

  // ---- editing: the nodes of the note's own objects, and the model operations that change them

  // Which nodes can be picked, and how they may be edited. A locked object can be picked (to unlock it) but has no handles and does
  // not move; paths, groups and point text scale as a whole, boxes (text, sticky, shapes, pictures) are resized.
  function register(object, built, box) {
    const entry = { id: object.id, object, built, node: built.node, box, size: built.size.width !== undefined ? { ...built.size } : { width: object.geometry.width, height: object.geometry.height } }
    entries.set(object.id, entry)
    entryOfNode.set(built.node, entry)
    configure(entry)
    return entry
  }

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

  const newId = () => `res_${globalThis.crypto.randomUUID().replaceAll('-', '')}`
  const selectionListeners = new Set()

  function refreshBox(entry) {
    const g = entry.object.geometry
    if (!entry.box) return
    Object.assign(entry.box, boxOf(placementMatrix(g, entry.size), entry.size.width ?? g.width ?? 0, entry.size.height ?? g.height ?? 0))
  }

  // A resize (or a multi-object scale) changed the size of the model object: make the node from the model again, in the same place.
  function rebuild(entry) {
    const { object } = entry
    const index = world.children.indexOf(entry.node)
    const wasSelected = editing.nodes().includes(entry.node)
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
    const fresh = entries.get(object.id)
    if (fresh && wasSelected) editing.select([fresh.node])
  }

  // ---- edits. The document is an immutable value the host owns (and the undo history keeps): an edit is an `op` of { id, before, after }
  // changes planned by core/document/operations.js, handed to `onOperation`, which returns the new document.

  const objectsById = (document) => new Map(document.objects.filter((object) => object?.id !== undefined).map((object) => [object.id, object]))

  // Hands an op to the host, takes the document it returns, and points the entries at the new objects.
  function commit(op, { coalesce, selection } = {}) {
    if (!op.changes.length) return false
    const withSelection = selection ? { ...op, selection } : op
    doc = onOperation(withSelection, { coalesce }) ?? applyChanges(doc, op)
    const latest = objectsById(doc)
    for (const change of op.changes) {
      const entry = entries.get(change.id)
      if (entry && change.after) entry.object = latest.get(change.id) ?? change.after
    }
    return true
  }

  const selectedEntries = () => editing.nodes().map((node) => entryOfNode.get(node)).filter(Boolean)
  const selectedIds = () => selectedEntries().map((entry) => entry.id)

  // The editor has finished a gesture: read where each selected node ended up and commit it as one step.
  function flushGesture() {
    const changes = []
    const rebuilds = []
    const ids = selectedIds()
    for (const entry of selectedEntries()) {
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
    if (!changes.length) return
    commit({ label: 'Transform', changes }, { selection: { before: ids, after: ids } })
    for (const entry of rebuilds) { refreshBox(entry); rebuild(entry) }
    for (const entry of selectedEntries()) refreshBox(entry)
  }

  const editing = createEditing({
    app,
    onResize(node) { entryOfNode.get(node)?.built.relayout?.() },
    onGestureEnd: flushGesture,
    onSelect(nodes) { const ids = nodes.map((node) => entryOfNode.get(node)?.id).filter(Boolean); for (const listener of selectionListeners) listener(ids) },
  })

  // After a reorder (or an undo of one): put the nodes whose place in the stack changed where the document says.
  function syncStacking(ids) {
    const nodes = stacking(doc).map((object) => entries.get(object.id)?.node).filter(Boolean)
    const changed = new Set(ids)
    nodes.forEach((node, position) => { if (changed.has(entryOfNode.get(node)?.id) && world.children[position] !== node) world.addAt(node, position) })
  }

  function dropEntry(entry) {
    entries.delete(entry.id)
    const stroke = uniformStrokes.findIndex((item) => item.node === entry.node)
    if (stroke !== -1) uniformStrokes.splice(stroke, 1)
    const at = boxes.indexOf(entry.box)
    if (at !== -1) boxes.splice(at, 1)
    const slot = measuredText.findIndex((item) => item.object === entry.object)
    if (slot !== -1) measuredText.splice(slot, 1)
    entry.node.remove()
  }

  const api = {
    leafer,
    // Draws a note. `next` is a document model (fromFabric output); `options.resolveMedia` turns a media-library picture into a URL.
    load(next, options = {}) {
      resolveMedia = options.resolveMedia ?? null
      doc = next
      editing.clear()
      world.clear()
      entries.clear()
      textNodes.length = 0
      measuredText.length = 0
      uniformStrokes.length = 0
      boxes = []
      stats = { drawn: 0, skipped: 0, unknown: 0, images: 0 }
      for (const object of stacking(doc)) addObject(world, object, boxes)
      pages = { columns: doc.page?.columns ?? 1, rows: doc.page?.rows ?? 1 }
      drawChrome()
    },
    // A new document that differs from the one on screen in `ids` only (an undo, a redo): the nodes of those objects are made again,
    // taken away or added, and the rest of the scene is left alone.
    sync(next, ids) {
      doc = next
      const latest = objectsById(doc)
      for (const id of ids) {
        const object = latest.get(id)
        const entry = entries.get(id)
        if (entry && !object) { dropEntry(entry); continue }
        if (!object) continue
        if (entry) { entry.object = object; rebuild(entry) } else addObject(world, object, boxes)
      }
      pages = { columns: doc.page?.columns ?? 1, rows: doc.page?.rows ?? 1 }
      syncStacking(ids)
      editing.update()
      drawChrome()
    },
    document: () => doc,
    // The same document, held by the history now (a new open, an agent's merge): the objects are equal, so only the references change.
    adopt(next) {
      doc = next
      const latest = objectsById(doc)
      for (const entry of entries.values()) entry.object = latest.get(entry.id) ?? entry.object
    },
    setPages(next) { pages = { ...next }; drawChrome() },
    setColors(next) { colors = next; drawChrome() },
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
    stats: () => ({ ...stats }),

    // ---- selection and edits (F-028)
    onSelection(listener) { selectionListeners.add(listener); return () => selectionListeners.delete(listener) },
    selection: selectedIds,
    select(ids) { editing.select(ids.map((id) => entries.get(id)?.node).filter(Boolean)) },
    clearSelection() { editing.clear() },
    selectAll() { editing.select([...entries.values()].filter((entry) => entry.object.type !== 'connector' && !isLocked(entry.object)).map((entry) => entry.node)) },
    isLocked: (id) => isLocked(entries.get(id)?.object),

    // Arrow keys: move the selection by (dx, dy) page pixels. Locked objects stay. Repeated nudges are one undo step.
    nudge(dx, dy) {
      const targets = selectedEntries()
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

    // Delete: locked objects stay, connectors of a deleted object go with it.
    deleteSelection() {
      const ids = selectedIds()
      const plan = planRemove(doc, { ids })
      if (!plan.op.changes.length) return false
      commit(plan.op, { selection: { before: ids, after: [] } })
      editing.clear()
      for (const change of plan.op.changes) { const entry = entries.get(change.id); if (entry) dropEntry(entry) }
      return true
    },

    reorderSelection(to) {
      const ids = selectedIds()
      const plan = planReorder(doc, { ids, to })
      if (!plan.op.changes.length) return false
      commit(plan.op, { selection: { before: ids, after: ids } })
      syncStacking(plan.op.changes.map((change) => change.id))
      editing.update()
      return true
    },

    lockSelection(locked) {
      const ids = selectedIds()
      const plan = planLock(doc, { ids, locked })
      if (!plan.op.changes.length) return false
      commit(plan.op, { selection: { before: ids, after: ids } })
      for (const change of plan.op.changes) configure(entries.get(change.id))
      if (ids.length > 1 && locked) editing.clear() // a locked object is only ever selected alone
      else editing.refresh()
      return true
    },

    // Where an object is on screen (CSS pixels from the top-left of the Leafer view) and where its box corners are on the page.
    screenBox(id) {
      const node = entries.get(id)?.node
      if (!node) return null
      const { x, y, width, height } = node.getWorldBounds('box')
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
    destroy() { editing.destroy(); app.destroy() },
  }
  return api
}
