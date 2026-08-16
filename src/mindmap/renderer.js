import { descendantsOf, getDepth, nodeById, visibleNodes } from './model.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const createSvg = (name, attributes = {}) => {
  const element = document.createElementNS(SVG_NS, name)
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value))
  return element
}

function branchWidths(depth) {
  return {
    start: Math.max(5, 34 / Math.pow(depth, 0.82)),
    end: Math.max(3, 8 / Math.pow(depth, 0.88)),
  }
}

function estimateTextWidth(node) {
  return Math.max(58, node.text.length * (node.fontSize || 20) * (node.font === 'clean' ? 0.53 : 0.49))
}

function nodePresentation(node) {
  return node.parentId === null || node.presentation !== 'branch' ? 'box' : 'branch'
}

function nodeFrame(node) {
  const width = node.parentId === null ? Math.max(180, estimateTextWidth(node) + 50) : estimateTextWidth(node) + 26
  const height = node.parentId === null ? 76 : (node.fontSize || 20) + 20
  return { width, height, left: -width / 2 }
}

const PORT_VECTORS = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

function pointOnFrame(node, side, gap = 0) {
  if (nodePresentation(node) === 'branch') return { x: node.x, y: node.y + 5 }
  const frame = nodeFrame(node)
  const vector = PORT_VECTORS[side]
  return {
    x: node.x + vector.x * (frame.width / 2 + gap),
    y: node.y + vector.y * (frame.height / 2 + gap),
  }
}

function branchEndpoints(parent, child) {
  const right = child.x >= parent.x
  const sourcePort = child.branchPorts?.source || (right ? 'right' : 'left')
  const targetPort = child.branchPorts?.target || (right ? 'left' : 'right')
  const source = pointOnFrame(parent, sourcePort)
  const target = pointOnFrame(child, targetPort)
  return {
    sx: source.x,
    sy: source.y,
    ex: target.x,
    ey: target.y,
    right,
    sourcePort,
    targetPort,
  }
}

function resolveAnchor(anchor, sx, sy, ex, ey) {
  const dx = ex - sx
  const dy = ey - sy
  return { x: sx + dx * anchor.t - dy * anchor.n, y: sy + dy * anchor.t + dx * anchor.n }
}

function branchGeometry(parent, child, depth) {
  const { sx, sy, ex, ey, sourcePort, targetPort } = branchEndpoints(parent, child)
  const dx = ex - sx
  const dy = ey - sy
  const curve = (child.curve ?? 78) / 100
  const bend = Math.max(35, Math.hypot(dx, dy) * (0.25 + curve * 0.27))
  const wobble = Math.sin((child.x + child.y) * 0.013) * 9 * curve
  const sourceVector = PORT_VECTORS[sourcePort]
  const targetVector = PORT_VECTORS[targetPort]
  const defaults = [
    { x: sx + sourceVector.x * bend - sourceVector.y * wobble, y: sy + sourceVector.y * bend + sourceVector.x * wobble },
    { x: ex + targetVector.x * bend * 0.72 + targetVector.y * wobble, y: ey + targetVector.y * bend * 0.72 - targetVector.x * wobble },
  ]
  const controls = child.branchAnchors?.length === 2
    ? child.branchAnchors.map((anchor) => resolveAnchor(anchor, sx, sy, ex, ey))
    : defaults
  return { sx, sy, ex, ey, controls, widths: branchWidths(depth), sourceVector, targetVector }
}

function ribbonPath(geometry) {
  const { sx, sy, ex, ey, controls: [first, second], widths: { start, end } } = geometry
  return `M ${sx} ${sy - start / 2} C ${first.x} ${first.y - start / 2}, ${second.x} ${second.y - end / 2}, ${ex} ${ey - end / 2} L ${ex} ${ey + end / 2} C ${second.x} ${second.y + end / 2}, ${first.x} ${first.y + start / 2}, ${sx} ${sy + start / 2} Z`
}

function centerLine({ sx, sy, ex, ey, controls: [first, second] }) {
  return `M ${sx} ${sy} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${ex} ${ey}`
}

function cubicPoint({ sx, sy, ex, ey, controls: [first, second] }, t) {
  const inverse = 1 - t
  const startWeight = inverse ** 3
  const firstWeight = 3 * inverse ** 2 * t
  const secondWeight = 3 * inverse * t ** 2
  const endWeight = t ** 3
  return {
    x: startWeight * sx + firstWeight * first.x + secondWeight * second.x + endWeight * ex,
    y: startWeight * sy + firstWeight * first.y + secondWeight * second.y + endWeight * ey,
  }
}

function branchMidpoint({ sx, sy, ex, ey, controls: [first, second] }) {
  return { x: (sx + 3 * first.x + 3 * second.x + ex) / 8, y: (sy + 3 * first.y + 3 * second.y + ey) / 8 }
}

export class MindMapRenderer {
  constructor(svg) {
    this.svg = svg
    this.viewport = svg.querySelector('[data-map-viewport]')
    this.branchLayer = svg.querySelector('[data-map-branches]')
    this.nodeLayer = svg.querySelector('[data-map-nodes]')
    this.transform = { x: 0, y: 0, scale: 1 }
    this.document = null
    this.selectedId = null
    this.focusId = null
  }

  setTransform(transform) {
    this.transform = { ...transform }
    this.viewport.setAttribute('transform', `translate(${transform.x} ${transform.y}) scale(${transform.scale})`)
  }

  animateTransform(transform, duration = 220) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.setTransform(transform)
      return
    }
    const start = { ...this.transform }
    const startedAt = performance.now()
    const frame = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = progress * progress * (3 - 2 * progress)
      this.setTransform({
        scale: start.scale + (transform.scale - start.scale) * eased,
        x: start.x + (transform.x - start.x) * eased,
        y: start.y + (transform.y - start.y) * eased,
      })
      if (progress < 1) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  screenToWorld(clientX, clientY) {
    const rect = this.svg.getBoundingClientRect()
    return {
      x: (clientX - rect.left - this.transform.x) / this.transform.scale,
      y: (clientY - rect.top - this.transform.y) / this.transform.scale,
    }
  }

  render(documentValue, selectedId, focusId = null) {
    this.document = documentValue
    this.selectedId = selectedId
    this.focusId = focusId
    this.branchLayer.replaceChildren()
    this.nodeLayer.replaceChildren()
    const visible = visibleNodes(documentValue, focusId)
    const ids = new Set(visible.map((node) => node.id))
    visible.filter((node) => node.parentId && ids.has(node.parentId)).forEach((node) => this.renderBranch(node))
    const selected = nodeById(documentValue, selectedId)
    if (selected?.parentId && ids.has(selected.id) && ids.has(selected.parentId)) this.renderBranchControls(selected)
    visible.forEach((node) => this.renderNode(node))
  }

  renderBranch(node) {
    const parent = nodeById(this.document, node.parentId)
    const geometry = branchGeometry(parent, node, getDepth(this.document, node.id))
    this.branchLayer.append(
      createSvg('path', { class: 'map-branch-ribbon', d: ribbonPath(geometry), fill: node.color }),
      createSvg('path', { class: 'map-branch-hit', d: centerLine(geometry), 'data-node-id': node.id }),
    )
  }

  renderBranchControls(node) {
    const parent = nodeById(this.document, node.parentId)
    const geometry = branchGeometry(parent, node, getDepth(this.document, node.id))
    const group = createSvg('g', { class: 'map-branch-controls' })
    group.append(createSvg('path', {
      class: 'map-branch-control-guide',
      d: centerLine(geometry),
    }))
    ;[1 / 3, 2 / 3].map((t) => cubicPoint(geometry, t)).forEach((point, index) => {
      group.append(
        createSvg('circle', { class: 'map-branch-control-hit', cx: point.x, cy: point.y, r: 18, 'data-branch-anchor-id': node.id, 'data-anchor-index': index }),
        createSvg('circle', { class: 'map-branch-control-anchor', cx: point.x, cy: point.y, r: 6, fill: node.color, 'data-branch-anchor-id': node.id, 'data-anchor-index': index }),
      )
    })
    this.branchLayer.append(group)
  }

  branchAnchorFromWorld(node, point, index = 0) {
    const parent = nodeById(this.document, node.parentId)
    const { sx, sy, ex, ey, controls } = branchGeometry(parent, node, getDepth(this.document, node.id))
    const dx = ex - sx
    const dy = ey - sy
    const lengthSquared = Math.max(1, dx * dx + dy * dy)
    const encode = (value) => ({
      t: ((value.x - sx) * dx + (value.y - sy) * dy) / lengthSquared,
      n: ((value.y - sy) * dx - (value.x - sx) * dy) / lengthSquared,
    })
    const curveT = index === 0 ? 1 / 3 : 2 / 3
    const inverse = 1 - curveT
    const weights = [inverse ** 3, 3 * inverse ** 2 * curveT, 3 * inverse * curveT ** 2, curveT ** 3]
    const fixedControl = controls[index === 0 ? 1 : 0]
    const adjustableWeight = weights[index + 1]
    const fixedWeight = weights[index === 0 ? 2 : 1]
    const control = {
      x: (point.x - weights[0] * sx - fixedWeight * fixedControl.x - weights[3] * ex) / adjustableWeight,
      y: (point.y - weights[0] * sy - fixedWeight * fixedControl.y - weights[3] * ey) / adjustableWeight,
    }
    return { anchor: encode(control), defaults: controls.map(encode) }
  }

  renderNode(node) {
    const isRoot = node.id === this.document.rootId
    const group = createSvg('g', {
      class: `map-node ${nodePresentation(node) === 'box' ? 'boxed' : 'branch-title'}${node.id === this.selectedId ? ' selected' : ''}`,
      transform: `translate(${node.x} ${node.y})`,
      'data-node-id': node.id,
      role: 'treeitem',
      'aria-label': node.text,
      tabindex: node.id === this.selectedId ? '0' : '-1',
    })
    if (isRoot) this.renderRoot(group, node)
    else this.renderLabel(group, node)
    if (node.image) this.renderImage(group, node, isRoot)
    const hiddenCount = node.collapsed ? descendantsOf(this.document, node.id).length : 0
    if (hiddenCount) this.renderCollapseBadge(group, node, hiddenCount)
    if (node.id === this.selectedId) this.renderAddHandles(group, node, isRoot)
    this.nodeLayer.append(group)
  }

  renderRoot(group, node) {
    const width = Math.max(180, estimateTextWidth(node) + 50)
    const height = 76
    const label = createSvg('text', { class: 'map-root-label', x: 0, y: 1, 'font-size': node.fontSize || 28, 'font-style': node.italic ? 'italic' : 'normal' })
    label.textContent = node.text
    group.append(
      createSvg('rect', { class: 'map-root-card', x: -width / 2, y: -height / 2, width, height, rx: 20, fill: node.color }),
      createSvg('path', { d: `M ${-width / 2 + 18} 24 Q 0 34 ${width / 2 - 18} 20`, fill: 'none', stroke: 'rgba(255,255,255,.23)', 'stroke-width': 5, 'stroke-linecap': 'round' }),
      createSvg('rect', { class: 'map-node-selection', x: -width / 2 - 7, y: -height / 2 - 7, width: width + 14, height: height + 14, rx: 24 }),
      label,
    )
  }

  renderLabel(group, node) {
    const frame = nodeFrame(node)
    const parent = nodeById(this.document, node.parentId)
    const midpoint = nodePresentation(node) === 'branch'
      ? branchMidpoint(branchGeometry(parent, node, getDepth(this.document, node.id)))
      : null
    const labelX = midpoint ? midpoint.x - node.x : 0
    const labelY = midpoint ? midpoint.y - node.y - 5 : 1
    const label = createSvg('text', {
      class: `map-node-label${node.font === 'clean' ? ' clean' : ''}`,
      x: labelX,
      y: labelY,
      'text-anchor': 'middle',
      'font-size': node.fontSize || 20,
      'font-weight': node.bold ? '700' : '500',
      'font-style': node.italic ? 'italic' : 'normal',
    })
    label.textContent = midpoint ? node.text.toUpperCase() : node.text
    if (!midpoint) {
      label.setAttribute('dominant-baseline', 'middle')
      group.append(
        createSvg('rect', { class: 'map-idea-card', x: frame.left, y: -frame.height / 2, width: frame.width, height: frame.height, rx: 6, fill: '#fffefa', stroke: node.color }),
        createSvg('rect', { class: 'map-node-selection', x: frame.left - 5, y: -frame.height / 2 - 5, width: frame.width + 10, height: frame.height + 10, rx: 9 }),
        label,
      )
    } else {
      group.append(createSvg('rect', { class: 'map-node-selection', x: labelX - frame.width / 2, y: labelY - frame.height + 5, width: frame.width, height: frame.height, rx: 5 }), label)
    }
  }

  renderAddHandles(group, node, isRoot) {
    const frame = nodeFrame(node)
    const right = isRoot || node.x >= (nodeById(this.document, node.parentId)?.x ?? 0)
    const sides = nodePresentation(node) === 'box' ? ['top', 'right', 'bottom', 'left'] : [right ? 'right' : 'left']
    sides.forEach((side) => {
      const vector = PORT_VECTORS[side]
      const x = vector.x * (nodePresentation(node) === 'box' ? frame.width / 2 + 18 : 22)
      const y = nodePresentation(node) === 'branch' ? 5 : vector.y * (frame.height / 2 + 18)
      const handle = createSvg('g', {
        class: 'map-add-handle',
        transform: `translate(${x} ${y})`,
        'data-add-child-id': node.id,
        'data-source-port': side,
        'aria-label': `Add branch from ${side}`,
      })
      handle.append(
        createSvg('circle', { class: 'map-add-hit', r: 17 }),
        createSvg('circle', { class: 'map-add-circle', r: 7, fill: node.color }),
        createSvg('circle', { class: 'map-add-dot', r: 2 }),
      )
      group.append(handle)
    })
  }

  renderImage(group, node, isRoot) {
    group.prepend(
      createSvg('image', { class: 'map-node-image', href: node.image, x: isRoot ? -45 : (node.x >= 0 ? -2 : -88), y: isRoot ? -132 : -102, width: 88, height: 68, preserveAspectRatio: 'xMidYMid slice' }),
      createSvg('rect', { x: isRoot ? -47 : (node.x >= 0 ? -4 : -90), y: isRoot ? -134 : -104, width: 92, height: 72, rx: 4, fill: 'none', stroke: '#fff', 'stroke-width': 4 }),
    )
  }

  renderCollapseBadge(group, node, count) {
    const x = node.id === this.document.rootId ? 0 : (node.x >= 0 ? 10 : -10)
    const text = createSvg('text', { class: 'map-collapse-count', x, y: 18, fill: node.color })
    text.textContent = count
    group.append(createSvg('circle', { class: 'map-collapse-badge', cx: x, cy: 18, r: 11, stroke: node.color }), text)
  }

  bounds(nodes = visibleNodes(this.document, this.focusId)) {
    if (!nodes.length) return { minX: -100, minY: -100, maxX: 100, maxY: 100 }
    return nodes.reduce((box, node) => ({
      minX: Math.min(box.minX, node.x - 120),
      minY: Math.min(box.minY, node.y - 120),
      maxX: Math.max(box.maxX, node.x + 120),
      maxY: Math.max(box.maxY, node.y + 120),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
  }

  fit(padding = 80, animate = false) {
    const rect = this.svg.getBoundingClientRect()
    const box = this.bounds()
    const scale = Math.min(1.35, Math.max(0.45, Math.min(
      (rect.width - padding * 2) / (box.maxX - box.minX),
      (rect.height - padding * 2) / (box.maxY - box.minY),
    )))
    const transform = {
      scale,
      x: rect.width / 2 - ((box.minX + box.maxX) / 2) * scale,
      y: rect.height / 2 - ((box.minY + box.maxY) / 2) * scale,
    }
    if (animate) this.animateTransform(transform)
    else this.setTransform(transform)
    return this.transform
  }
}