const MAX_IDEAS = 4
const MAX_TITLE_LENGTH = 54
const MAX_IDEA_LENGTH = 82

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1).trimEnd()}…`
}

function splitConcepts(segments) {
  return segments
    .flatMap(segment => String(segment || '').split(/(?:\r?\n|[.!?;]+|\s+(?:->|→)\s+)/))
    .map(cleanText)
    .filter(value => value.length >= 3)
}

function uniqueConcepts(concepts) {
  const seen = new Set()
  return concepts.filter((concept) => {
    const key = concept.toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function node(id, text, left, top, width, height, role = 'idea') {
  return { id, text, left, top, width, height, role }
}

export function proposeConceptDiagram(segments) {
  if (!Array.isArray(segments)) return null
  const concepts = uniqueConcepts(splitConcepts(segments))
  if (concepts.length < 2) return null

  const title = truncate(concepts[0], MAX_TITLE_LENGTH)
  const ideas = concepts.slice(1, MAX_IDEAS + 1).map(value => truncate(value, MAX_IDEA_LENGTH))
  if (!ideas.length) return null

  const width = 620
  const centerWidth = 220
  const ideaWidth = 170
  const center = node('topic', title, (width - centerWidth) / 2, 124, centerWidth, 96, 'topic')
  const positions = [
    { left: 8, top: 12 },
    { left: width - ideaWidth - 8, top: 12 },
    { left: 8, top: 252 },
    { left: width - ideaWidth - 8, top: 252 },
  ]
  const ideaNodes = ideas.map((text, index) => node(
    `idea-${index + 1}`,
    text,
    positions[index].left,
    positions[index].top,
    ideaWidth,
    88,
  ))

  return {
    kind: 'concept-map',
    title,
    summary: `Turn “${title}” into an editable concept map with ${ideaNodes.length} connected idea${ideaNodes.length === 1 ? '' : 's'}.`,
    width,
    height: 352,
    nodes: [center, ...ideaNodes],
    edges: ideaNodes.map(idea => ({ from: center.id, to: idea.id })),
  }
}

export function conceptDiagramBounds(plan, origin = { left: 0, top: 0 }) {
  return {
    left: origin.left,
    top: origin.top,
    width: plan.width,
    height: plan.height,
    right: origin.left + plan.width,
    bottom: origin.top + plan.height,
  }
}

export function conceptNodePath(node, origin = { left: 0, top: 0 }) {
  const left = origin.left + node.left
  const top = origin.top + node.top
  const right = left + node.width
  const bottom = top + node.height
  const radius = Math.min(18, node.width * 0.1, node.height * 0.2)
  const sway = node.role === 'topic' ? 3 : 2
  return [
    `M ${left + radius} ${top + sway}`,
    `C ${left + node.width * 0.35} ${top - sway} ${left + node.width * 0.68} ${top + sway} ${right - radius} ${top}`,
    `Q ${right + sway} ${top} ${right} ${top + radius}`,
    `C ${right - sway} ${top + node.height * 0.42} ${right + sway} ${top + node.height * 0.72} ${right} ${bottom - radius}`,
    `Q ${right} ${bottom + sway} ${right - radius} ${bottom}`,
    `C ${left + node.width * 0.66} ${bottom - sway} ${left + node.width * 0.34} ${bottom + sway} ${left + radius} ${bottom}`,
    `Q ${left - sway} ${bottom} ${left} ${bottom - radius}`,
    `C ${left + sway} ${top + node.height * 0.7} ${left - sway} ${top + node.height * 0.35} ${left} ${top + radius}`,
    `Q ${left} ${top} ${left + radius} ${top + sway} Z`,
  ].join(' ')
}

export function conceptEdgePath(plan, edge, origin = { left: 0, top: 0 }) {
  const from = plan.nodes.find(item => item.id === edge.from)
  const to = plan.nodes.find(item => item.id === edge.to)
  if (!from || !to) throw new Error('Concept edge references an unknown node')
  const start = {
    x: origin.left + from.left + from.width / 2,
    y: origin.top + from.top + from.height / 2,
  }
  const end = {
    x: origin.left + to.left + to.width / 2,
    y: origin.top + to.top + to.height / 2,
  }
  const midpointX = (start.x + end.x) / 2
  const midpointY = (start.y + end.y) / 2
  const bend = end.x < start.x ? -16 : 16
  return `M ${start.x} ${start.y} Q ${midpointX + bend} ${midpointY} ${end.x} ${end.y}`
}

export function wrapConceptLabel(value, maxCharacters = 21) {
  const words = cleanText(value).split(' ')
  const lines = []
  words.forEach((word) => {
    const current = lines.at(-1)
    if (!current || `${current} ${word}`.length > maxCharacters) lines.push(word)
    else lines[lines.length - 1] = `${current} ${word}`
  })
  return lines.slice(0, 4).join('\n')
}