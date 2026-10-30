import { branchGeometry as computeBranch, cubicAt, PORT_VECTORS, ribbonPath } from './geometry.js'
import { ghostNodes } from './jam.js'
import { ICON_PATHS } from './icons.js'
import { pencilPath, seedOf, strikePoints } from './pencil.js'
import { layoutNode } from './layout.js'
import { BRANCH_COLORS, descendantsOf, getDepth, nodeById, visibleNodes } from './model.js'

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

function nodePresentation(node) {
  return node.parentId === null || node.presentation !== 'branch' ? 'box' : 'branch'
}

const nodeFrame = (node) => layoutNode(node)

// The label's lines as tspans, the block centred on `middle` (a branch label rests its last line on the branch instead: `bottom`).
function setLines(label, lines, step, x, { middle = 0, bottom } = {}) {
  lines.forEach((line, index) => {
    const y = bottom === undefined ? middle + (index - (lines.length - 1) / 2) * step : bottom - (lines.length - 1 - index) * step
    const row = createSvg('tspan', { x, y })
    row.textContent = line
    label.append(row)
  })
}

// The icons before the words, in `color`, level with the first line; the block of icons and words is centred on `cx`.
function renderIcons(group, frame, cx, firstY, color, node) {
  frame.icons.forEach((name, index) => {
    const icon = createSvg('g', { class: 'map-node-icon', 'data-icon': name, ...(node.done && name === 'done' ? { 'data-done-toggle': node.id, role: 'button', 'aria-label': 'Done: tap to undo' } : {}), transform: `translate(${cx - (frame.lead + frame.textWidth) / 2 + index * (frame.iconSize + 4)} ${firstY - frame.iconSize / 2}) scale(${frame.iconSize / 24})`, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
    icon.append(createSvg('path', { d: ICON_PATHS[name] }))
    group.append(icon)
  })
}

const frameOf = (node) => ({ x: node.x, y: node.y, hw: nodeFrame(node).width / 2, hh: nodeFrame(node).height / 2, pin: nodePresentation(node) === 'branch' })

function branchGeometry(parent, child, depth) {
  const geometry = computeBranch(frameOf(parent), frameOf(child), {
    curve: child.curve ?? 78,
    anchors: child.branchAnchors,
    sourcePort: child.branchPorts?.source,
    targetPort: child.branchPorts?.target,
  })
  return { ...geometry, widths: branchWidths(depth) }
}

function centerLine({ sx, sy, ex, ey, controls: [first, second] }) {
  return `M ${sx} ${sy} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${ex} ${ey}`
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
    const ghosts = ghostNodes(documentValue).filter((ghost) => ids.has(ghost.parentId))
    ghosts.forEach((ghost) => this.renderGhostBranch(ghost))
    visible.forEach((node) => this.renderNode(node))
    ghosts.forEach((ghost) => this.renderGhost(ghost))
  }

  // A suggestion waiting beside the map (F-092): the branch it would grow, faint and dashed.
  renderGhostBranch(ghost) {
    const geometry = branchGeometry(nodeById(this.document, ghost.parentId), ghost, getDepth(this.document, ghost.parentId) + 1)
    this.branchLayer.append(createSvg('path', { class: 'map-ghost-branch', d: centerLine(geometry), fill: 'none', stroke: ghost.color, 'stroke-width': 3, 'stroke-dasharray': '8 8', 'stroke-linecap': 'round', opacity: 0.55, 'pointer-events': 'none' }))
  }

  // The ghost's box with a Yes and a No beside it. The pills keep one size on screen whatever the zoom (48px high on a phone).
  renderGhost(ghost) {
    const frame = nodeFrame(ghost)
    const compact = Boolean(globalThis.matchMedia?.('(max-width: 800px)').matches)
    const unit = 1 / this.transform.scale
    const [height, width, size] = (compact ? [48, 76, 15] : [28, 56, 13]).map((n) => n * unit)
    const group = createSvg('g', { class: 'map-ghost', transform: `translate(${ghost.x} ${ghost.y})`, 'data-ghost-id': ghost.id })
    const title = createSvg('title')
    title.textContent = ghost.why
    const label = createSvg('text', { class: 'map-node-label', 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': ghost.fontSize, 'font-weight': '500' })
    setLines(label, frame.lines, frame.lineStep, 0, { middle: 1 })
    group.append(
      title,
      createSvg('rect', { x: frame.left, y: -frame.height / 2, width: frame.width, height: frame.height, rx: 6, fill: '#fffefa', 'fill-opacity': 0.6, stroke: ghost.color, 'stroke-width': 2, 'stroke-dasharray': '6 5', opacity: 0.75 }),
      label,
    )
    ;[['yes', 'Yes', -1], ['no', 'No', 1]].forEach(([action, words, side]) => {
      const pill = createSvg('g', { 'data-ghost-id': ghost.id, 'data-ghost-action': action, transform: `translate(${side * (width / 2 + 4 * unit)} ${frame.height / 2 + 6 * unit + height / 2})`, role: 'button', tabindex: 0, 'aria-label': `${words}, ${action === 'yes' ? 'add' : 'drop'} ${ghost.text}`, style: 'cursor:pointer' })
      const caption = createSvg('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: action === 'yes' ? '#fff' : BRANCH_COLORS[7], style: `font:700 ${size}px "IBM Plex Sans",sans-serif` })
      caption.textContent = words
      pill.append(createSvg('rect', { x: -width / 2, y: -height / 2, width, height, rx: height / 2, fill: action === 'yes' ? ghost.color : '#fffefa', stroke: action === 'yes' ? ghost.color : BRANCH_COLORS[7], 'stroke-width': 1.5 * unit }), caption)
      group.append(pill)
    })
    this.nodeLayer.append(group)
  }

  // 👍 or 👎 on a branch; hovering shows why (the tooltip), a tap shows it too (the editor toasts data-reason).
  renderVote(group, node, x, y) {
    const badge = createSvg('g', { class: 'map-vote', 'data-vote': node.vote, 'data-reason': node.reason, transform: `translate(${x} ${y})`, role: 'img', 'aria-label': `${node.vote === 'up' ? 'Thumbs up' : 'Thumbs down'}: ${node.reason}`, style: 'cursor:help' })
    const title = createSvg('title')
    title.textContent = node.reason
    const thumb = createSvg('text', { x: 0, y: 1, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 15 })
    thumb.textContent = node.vote === 'up' ? '👍' : '👎'
    badge.append(title, createSvg('circle', { r: 13, fill: '#fffefa', stroke: node.color, 'stroke-width': 2 }), thumb)
    group.append(badge)
  }

  renderBranch(node) {
    const parent = nodeById(this.document, node.parentId)
    const geometry = branchGeometry(parent, node, getDepth(this.document, node.id))
    this.branchLayer.append(
      createSvg('path', { class: 'map-branch-ribbon', d: ribbonPath(geometry, geometry.widths), fill: node.color }),
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
    ;[1 / 3, 2 / 3].map((t) => cubicAt(geometry, t)).forEach((point, index) => {
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
    const { frame, firstY, rows } = this.labelPlace(node)
    const { width, height, lines, lineStep } = frame
    const label = createSvg('text', { class: `map-root-label${node.done ? ' done' : ''}`, 'font-size': node.fontSize || 28, 'font-style': node.italic ? 'italic' : 'normal' })
    setLines(label, lines, lineStep, frame.lead / 2, { middle: 1 })
    const icons = createSvg('g')
    renderIcons(icons, frame, 0, firstY, '#fff', node)
    this.renderLabelMarks(icons, node, rows)
    group.append(
      createSvg('rect', { class: 'map-root-card', x: -width / 2, y: -height / 2, width, height, rx: 20, fill: node.color }),
      createSvg('path', { d: `M ${-width / 2 + 18} ${height / 2 - 14} Q 0 ${height / 2 - 4} ${width / 2 - 18} ${height / 2 - 18}`, fill: 'none', stroke: 'rgba(255,255,255,.23)', 'stroke-width': 5, 'stroke-linecap': 'round' }),
      createSvg('rect', { class: 'map-node-selection', x: -width / 2 - 7, y: -height / 2 - 7, width: width + 14, height: height + 14, rx: 24 }),
      label,
      icons,
    )
    if (node.vote) this.renderVote(group, node, width / 2 - 4, -height / 2)
  }

  // Where a node's words sit, relative to the node: the centre of the block of icons and words, the baseline of a branch label (or null in a box),
  // and each line's span and middle (what the pencil strike crosses).
  labelPlace(node) {
    const frame = nodeFrame(node)
    const midpoint = node.parentId !== null && nodePresentation(node) === 'branch'
      ? cubicAt(branchGeometry(nodeById(this.document, node.parentId), node, getDepth(this.document, node.id)), 0.5)
      : null
    const cx = midpoint ? midpoint.x - node.x : 0
    const labelY = midpoint ? midpoint.y - node.y - 5 : 1
    const size = node.fontSize || (node.parentId === null ? 28 : 20)
    const firstY = midpoint ? labelY - (frame.lines.length - 1) * frame.lineStep - size * 0.32 : 1 - (frame.lines.length - 1) * frame.lineStep / 2
    const rows = frame.lines.map((_, index) => ({ x0: cx + frame.lead / 2 - frame.lineWidths[index] / 2, x1: cx + frame.lead / 2 + frame.lineWidths[index] / 2, y: firstY + index * frame.lineStep }))
    return { frame, midpoint, cx, labelY, firstY, rows }
  }

  // The label's touch target (a swipe on it strikes it out) and, for a done node, the pencil lines through its words.
  renderLabelMarks(group, node, rows) {
    const { x0, x1 } = rows.reduce((box, row) => ({ x0: Math.min(box.x0, row.x0), x1: Math.max(box.x1, row.x1) }), { x0: Infinity, x1: -Infinity })
    const step = rows.length > 1 ? rows[1].y - rows[0].y : (node.fontSize || 20) * 1.2
    group.append(createSvg('rect', { class: 'map-label-hit', 'data-label-hit': node.id, x: x0 - 6, y: rows[0].y - step / 2, width: x1 - x0 + 12, height: step * rows.length, fill: 'transparent' }))
    if (node.done) rows.forEach((row, index) => group.append(createSvg('path', { class: 'map-strike', d: pencilPath(strikePoints(row.x0 - 4, row.x1 + 4, row.y), seedOf(`${node.id}${index}`)), fill: '#4a4d52' })))
  }

  renderLabel(group, node) {
    const { frame, midpoint, cx: labelX, labelY, firstY, rows } = this.labelPlace(node)
    const label = createSvg('text', {
      class: `map-node-label${node.font === 'clean' ? ' clean' : ''}${node.done ? ' done' : ''}`,
      'text-anchor': 'middle',
      'font-size': node.fontSize || 20,
      'font-weight': node.bold ? '700' : '500',
      'font-style': node.italic ? 'italic' : 'normal',
    })
    setLines(label, frame.lines, frame.lineStep, labelX + frame.lead / 2, midpoint ? { bottom: labelY } : { middle: 1 })
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
    renderIcons(group, frame, labelX, firstY, node.color, node)
    this.renderLabelMarks(group, node, rows)
    if (node.vote) this.renderVote(group, node, labelX + frame.width / 2, midpoint ? labelY - frame.height / 2 : -frame.height / 2)
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

  bounds(shown = visibleNodes(this.document, this.focusId)) {
    const ids = new Set(shown.map((node) => node.id))
    const nodes = [...shown, ...ghostNodes(this.document).filter((ghost) => ids.has(ghost.parentId))] // (the suggestions waiting count: the view must show them)
    if (!nodes.length) return { minX: -100, minY: -100, maxX: 100, maxY: 100 }
    return nodes.reduce((box, node) => {
      const frame = nodeFrame(node)
      const reachX = Math.max(120, frame.width / 2 + 40)
      const reachY = Math.max(120, frame.height / 2 + 40)
      return {
        minX: Math.min(box.minX, node.x - reachX),
        minY: Math.min(box.minY, node.y - reachY),
        maxX: Math.max(box.maxX, node.x + reachX),
        maxY: Math.max(box.maxY, node.y + reachY),
      }
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
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