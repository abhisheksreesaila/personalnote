// The Leafer adapter (F-027): draws a document-model note read-only. Everything about WHERE an object goes comes from the
// documented model rules (placement.js: the one matrix per object; schema.js: frames, ink frame, group frames); this file only
// knows how to make each model type look like the Fabric render. Leafer is imported here and nowhere else, so the whole
// engine lands in one lazy chunk that loads only when the switch is on.
import { Group, Ellipse, Image, Leafer, MatrixHelper, Path, Rect, Text } from 'leafer-ui'
import { PAGE } from '../../core/document/index.js'
import { arrowHeadPoints, endpointsFromBox } from '../editor/connectors.js'
import { STICKY_PADDING } from '../editor/objects.js'
import { FOLD_COLOR, FOLD_DASH, FOLD_WIDTH, LABEL_FONT_FAMILY, LABEL_FONT_SIZE, pageChrome } from './chrome.js'
import { applyMatrix, placementMatrix } from './placement.js'
import { bakedStickyShadow, STICKY_CORNERS } from './sticky-shadow.js'
import { fabricLineMetrics, withAlpha } from './style.js'

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
    fontFamily: !style.fontFamily ? TEXT_DEFAULTS.fontFamily : style.fontFamily === 'Georgia' ? 'Source Serif 4' : style.fontFamily, // the Fabric path renames the legacy Georgia
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

export function createScene({ host, width, height }) {
  const leafer = new Leafer({ view: host, width, height, hittable: false, pixelRatio: Math.min(2, globalThis.devicePixelRatio || 1) })
  const chrome = new Group({ hittable: false })
  const world = new Group({ hittable: false })
  leafer.add(chrome)
  leafer.add(world)

  let view = { x: 0, y: 0, scale: 1 }
  let size = { width, height }
  let pages = { columns: 1, rows: 1 }
  let colors = { paper: '#fbfaf5', label: '#6e6e78', radius: 6, edge: '#2c2c34', shadows: [] }
  let boxes = []
  let stats = { objects: 0, unknown: 0, images: 0 }
  const textNodes = []
  let resolveMedia = null

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
    const props = { hittable: false }
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
        const holder = new Group(base)
        holder.add(text)
        return { node: holder, size: measured ? { width: g.width ?? measured.width, height: g.height ?? measured.height } : {} }
      }
      case 'sticky': {
        const w = g.width ?? 240
        const h = g.height ?? 200
        const holder = new Group(base)
        const shadow = bakedStickyShadow(w, h)
        holder.add(new Image({ url: shadow.url, x: -shadow.margin, y: -shadow.margin, width: shadow.width, height: shadow.height, hittable: false }))
        holder.add(new Rect({ width: w, height: h, fill: isColor(object.color) ? object.color : '#ffd60a', cornerRadius: STICKY_CORNERS, hittable: false }))
        const text = new Text(textProps(object, { width: w - STICKY_PADDING * 2, padding: STICKY_PADDING }))
        textNodes.push(text)
        holder.add(text)
        return { node: holder, size: {} }
      }
      case 'shape': {
        const fill = isColor(object.fill) ? object.fill : SHAPE_DEFAULT_FILL
        const strokes = strokeProps(object.stroke, object.strokeWidth ?? 1, object.strokeUniform, undefined, 'miter')
        if (object.kind === 'circle') return { node: new Ellipse({ ...base, width: g.width, height: g.height, fill, ...strokes }), size: {} }
        const rx = object.cornerRadius ?? 0
        const ry = object.cornerRadiusY ?? rx
        if (rx !== ry && rx > 0 && ry > 0) return { node: new Path({ ...base, path: roundedRectPath(g.width, g.height, rx, ry), fill, ...strokes }), size: {} }
        return { node: new Rect({ ...base, width: g.width, height: g.height, fill, cornerRadius: rx || undefined, ...strokes }), size: {} }
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
        return { node: new Image({ ...base, url, width: g.width, height: g.height }), size: {} }
      }
      case 'connector': {
        const { start, end } = endpointsFromBox({ left: 0, top: 0, width: g.width, height: g.height, reverseX: object.reverseX ?? false, reverseY: object.reverseY ?? false })
        const length = Math.hypot(end.x - start.x, end.y - start.y)
        const [tip, wingA, wingB] = arrowHeadPoints(start, end, Math.min(CONNECTOR_HEAD, length * 0.6))
        const tail = { x: (wingA.x + wingB.x) / 2, y: (wingA.y + wingB.y) / 2 }
        const color = isColor(object.color) ? object.color : CONNECTOR_DEFAULTS.color
        const path = `M ${start.x} ${start.y} L ${tail.x} ${tail.y} M ${tip.x} ${tip.y} L ${wingA.x} ${wingA.y} L ${wingB.x} ${wingB.y} Z`
        return { node: new Path({ ...base, path, fill: color, ...strokeProps(color, object.lineWidth ?? CONNECTOR_DEFAULTS.lineWidth, false, 'round', 'round') }), size: {} }
      }
      case 'group': {
        const group = new Group(base)
        for (const child of [...object.children].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))) addObject(group, child, null)
        return { node: group, size: {} }
      }
      default:
        return null
    }
  }

  function addObject(parent, object, boxList) {
    if (object.type === 'unknown') { stats.unknown += 1; return }
    stats.objects += 1
    const built = build(object)
    if (!built) return
    const g = object.geometry
    const matrix = placementMatrix(g, built.size)
    place(built.node, matrix)
    parent.add(built.node)
    if (boxList && object.type !== 'connector') {
      const w = built.size.width ?? g.width ?? 0
      const h = built.size.height ?? g.height ?? 0
      const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => applyMatrix(matrix, { x, y }))
      const xs = corners.map((p) => p.x)
      const ys = corners.map((p) => p.y)
      boxList.push({ left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) })
    }
  }

  function applyView() {
    world.set({ x: view.x, y: view.y, scaleX: view.scale, scaleY: view.scale })
    drawChrome()
  }

  const api = {
    leafer,
    // Draws a note. `doc` is a document model (fromFabric output); `options.resolveMedia` turns a media-library picture into a URL.
    load(doc, options = {}) {
      resolveMedia = options.resolveMedia ?? null
      world.clear()
      textNodes.length = 0
      boxes = []
      stats = { objects: 0, unknown: 0, images: 0 }
      const ordered = [...doc.objects].map((object, index) => [object, index]).sort(([a, i], [b, j]) => ((a.z ?? i) - (b.z ?? j)) || (i - j)).map(([object]) => object)
      for (const object of ordered) addObject(world, object, boxes)
      pages = { columns: doc.page?.columns ?? 1, rows: doc.page?.rows ?? 1 }
      drawChrome()
    },
    setPages(next) { pages = { ...next }; drawChrome() },
    setColors(next) { colors = next; drawChrome() },
    setView(next) { view = { ...next }; applyView() },
    resize(nextWidth, nextHeight) {
      size = { width: nextWidth, height: nextHeight }
      leafer.resize({ width: nextWidth, height: nextHeight })
      drawChrome()
    },
    // Text layout is cached per element; call after web fonts finish loading.
    refreshText() { textNodes.forEach((node) => node.forceUpdate?.()) },
    boxes: () => boxes,
    stats: () => ({ ...stats }),
    // Resolves when pictures have decoded and the frame is on screen.
    whenSettled() {
      return new Promise((resolve) => {
        const finish = () => requestAnimationFrame(() => requestAnimationFrame(resolve))
        leafer.waitViewCompleted(finish)
      })
    },
    destroy() { leafer.destroy() },
  }
  return api
}
