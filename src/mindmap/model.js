export const BRANCH_COLORS = ['#ef684b', '#efad28', '#65ae4f', '#2d9c91', '#3d8fe8', '#8c67cf', '#d85da8', '#5e6570']
const BRANCH_PORTS = new Set(['top', 'right', 'bottom', 'left'])

function normalizeBranchPorts(value) {
  if (!BRANCH_PORTS.has(value?.source) || !BRANCH_PORTS.has(value?.target)) return null
  return { source: value.source, target: value.target }
}

export function normalizeDocument(value) {
  if (!value || !Array.isArray(value.nodes) || !value.nodes.length) {
    throw new Error('This file does not contain a mind map.')
  }
  const nodes = value.nodes.map((node, index) => ({
    id: String(node.id || `node-${index}`),
    parentId: node.parentId == null ? null : String(node.parentId),
    text: String(node.text || 'New idea'),
    x: Number(node.x) || 0,
    y: Number(node.y) || 0,
    color: node.color || BRANCH_COLORS[index % BRANCH_COLORS.length],
    fontSize: Number(node.fontSize) || 20,
    bold: Boolean(node.bold),
    italic: Boolean(node.italic),
    font: node.font === 'clean' ? 'clean' : 'hand',
    presentation: node.presentation === 'branch' ? 'branch' : 'box',
    curve: Number.isFinite(Number(node.curve)) ? Number(node.curve) : 78,
    branchAnchors: Array.isArray(node.branchAnchors)
      ? node.branchAnchors.slice(0, 2).map((anchor) => ({
          t: Number.isFinite(Number(anchor?.t)) ? Number(anchor.t) : 0.5,
          n: Number.isFinite(Number(anchor?.n)) ? Number(anchor.n) : 0,
        }))
      : null,
    branchPorts: normalizeBranchPorts(node.branchPorts),
    collapsed: Boolean(node.collapsed),
    image: node.image || null,
  }))
  const root = nodes.find((node) => node.parentId === null) || nodes[0]
  root.parentId = null
  return {
    version: 1,
    title: String(value.title || 'Untitled map'),
    rootId: root.id,
    defaultPresentation: value.defaultPresentation === 'branch' ? 'branch' : 'box',
    nodes,
    updatedAt: value.updatedAt || new Date().toISOString(),
  }
}

export function nodeById(documentValue, id) {
  return documentValue.nodes.find((node) => node.id === id)
}

export function childrenOf(documentValue, id) {
  return documentValue.nodes.filter((node) => node.parentId === id)
}

export function getDepth(documentValue, id) {
  let depth = 0
  let node = nodeById(documentValue, id)
  const seen = new Set()
  while (node?.parentId && !seen.has(node.id)) {
    seen.add(node.id)
    depth += 1
    node = nodeById(documentValue, node.parentId)
  }
  return depth
}

export function descendantsOf(documentValue, id) {
  const result = []
  const queue = childrenOf(documentValue, id)
  while (queue.length) {
    const node = queue.shift()
    result.push(node)
    queue.push(...childrenOf(documentValue, node.id))
  }
  return result
}

export function visibleNodes(documentValue, focusId = null) {
  const hidden = new Set()
  documentValue.nodes.forEach((node) => {
    if (node.collapsed) descendantsOf(documentValue, node.id).forEach((child) => hidden.add(child.id))
  })
  if (!focusId) return documentValue.nodes.filter((node) => !hidden.has(node.id))

  const allowed = new Set([focusId, ...descendantsOf(documentValue, focusId).map((node) => node.id)])
  let cursor = nodeById(documentValue, focusId)
  while (cursor?.parentId) {
    allowed.add(cursor.parentId)
    cursor = nodeById(documentValue, cursor.parentId)
  }
  return documentValue.nodes.filter((node) => allowed.has(node.id) && !hidden.has(node.id))
}

export function cleanLayout(documentValue) {
  const root = nodeById(documentValue, documentValue.rootId)
  if (!root) return
  const rowGap = 105
  const firstColumn = 300
  const columnGap = 250
  const sortedChildren = (id) => childrenOf(documentValue, id).sort((first, second) => first.y - second.y)
  const leafCounts = new Map()
  const countLeaves = (id, ancestors = new Set()) => {
    if (ancestors.has(id)) return 1
    const children = sortedChildren(id)
    if (!children.length) return 1
    const nextAncestors = new Set(ancestors).add(id)
    const count = children.reduce((total, child) => total + countLeaves(child.id, nextAncestors), 0)
    leafCounts.set(id, count)
    return count
  }
  countLeaves(root.id)

  const arrange = (node, side, depth, top) => {
    const leaves = leafCounts.get(node.id) || 1
    node.x = root.x + side * (firstColumn + (depth - 1) * columnGap)
    node.y = top + (leaves - 1) * rowGap / 2
    node.branchAnchors = null
    let childTop = top
    sortedChildren(node.id).forEach((child) => {
      arrange(child, side, depth + 1, childTop)
      childTop += (leafCounts.get(child.id) || 1) * rowGap
    })
  }

  const rootChildren = sortedChildren(root.id)
  ;[-1, 1].forEach((side) => {
    const branches = rootChildren.filter((node) => (node.x < root.x ? -1 : 1) === side)
    const totalLeaves = branches.reduce((total, node) => total + (leafCounts.get(node.id) || 1), 0)
    let top = root.y - (totalLeaves - 1) * rowGap / 2
    branches.forEach((node) => {
      arrange(node, side, 1, top)
      top += (leafCounts.get(node.id) || 1) * rowGap
    })
  })
}

export function makeNode(documentValue, parent, sibling = false) {
  const parentNode = sibling && parent.parentId ? nodeById(documentValue, parent.parentId) : parent
  if (!parentNode) return null
  const siblings = childrenOf(documentValue, parentNode.id)
  const side = parentNode.id === documentValue.rootId ? (siblings.length % 2 ? -1 : 1) : Math.sign(parentNode.x || 1)
  const depth = getDepth(documentValue, parentNode.id) + 1
  const position = siblings.length - (siblings.length - 1) / 2
  return {
    id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    parentId: parentNode.id,
    text: 'New idea',
    x: parentNode.x + side * Math.max(190, 330 - depth * 55),
    y: parentNode.y + position * 76,
    color: parentNode.id === documentValue.rootId
      ? BRANCH_COLORS[siblings.length % BRANCH_COLORS.length]
      : parentNode.color,
    fontSize: Math.max(15, 25 - depth * 3),
    bold: depth === 1,
    font: parentNode.font || 'hand',
    presentation: documentValue.defaultPresentation === 'branch' ? 'branch' : 'box',
    curve: parentNode.curve ?? 78,
  }
}