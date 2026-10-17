// Jam sessions on a mind map (F-092): what a brain turn does to the map. Pure functions on the map document.
// Claude only adds and reacts: new branches, a thumb with a reason on an existing branch, and ghosts (suggestions that wait beside the map
// until the person says yes or no). Nothing here removes, renames or moves a branch of the person's.
import { BRANCH_COLORS, childrenOf, makeNode, nodeById } from './model.js'

export const MAX_GHOSTS = 3
const ROOM = { x: 150, y: 56 } // two branches closer than this overlap on screen

// Where a new child of `parent` goes: makeNode's spot, moved down until it sits on nothing (the other branches stay where they are).
// `waiting` are the ghosts already placed, which count as siblings and as obstacles.
function place(documentValue, parent, waiting = []) {
  const view = { ...documentValue, nodes: [...documentValue.nodes, ...waiting] }
  const node = makeNode(view, parent)
  if (parent.id === documentValue.rootId) {
    const used = new Set(childrenOf(view, parent.id).map((child) => child.color))
    node.color = BRANCH_COLORS.find((color) => !used.has(color)) ?? node.color
  }
  while (view.nodes.some((other) => Math.abs(other.x - node.x) < ROOM.x && Math.abs(other.y - node.y) < ROOM.y)) node.y += 62
  return node
}

const sameWords = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function ghostNodes(documentValue) {
  const placed = []
  for (const ghost of documentValue.ghosts ?? []) {
    const parent = nodeById(documentValue, ghost.parentId)
    if (!parent) continue
    placed.push({ ...place(documentValue, parent, placed), id: ghost.id, text: ghost.text, why: ghost.why, ghost: true })
  }
  return placed
}

// Apply one brain answer (the route's edits). The caller takes one undo step first, so a turn is one step.
export function applyJamEdits(documentValue, edits) {
  const handles = new Map() // the brain's own ids for branches it adds in this answer -> the map's ids
  const resolve = (id) => handles.get(id) ?? id
  const stamp = Date.now().toString(36)
  edits.forEach((edit, index) => {
    if (edit.op === 'add_branch') {
      const parent = nodeById(documentValue, resolve(edit.parentId))
      if (!parent) return
      const node = place(documentValue, parent)
      Object.assign(node, { text: edit.text, ...(edit.emoji ? { emoji: edit.emoji } : {}) })
      documentValue.nodes.push(node)
      if (edit.id) handles.set(edit.id, node.id)
    } else if (edit.op === 'react') {
      const node = nodeById(documentValue, resolve(edit.nodeId))
      if (node) Object.assign(node, { vote: edit.vote, reason: edit.reason })
    } else if (edit.op === 'ghost') {
      const parent = nodeById(documentValue, resolve(edit.parentId))
      const repeats = documentValue.nodes.some((node) => sameWords(node.text, edit.text)) || (documentValue.ghosts ?? []).some((ghost) => sameWords(ghost.text, edit.text))
      if (!parent || repeats) return
      documentValue.ghosts = [...(documentValue.ghosts ?? []), { id: `ghost-${stamp}-${index}`, parentId: parent.id, text: edit.text, why: edit.why }].slice(-MAX_GHOSTS)
    }
  })
  return documentValue
}

const withoutGhost = (documentValue, id) => {
  const rest = (documentValue.ghosts ?? []).filter((ghost) => ghost.id !== id)
  if (rest.length) documentValue.ghosts = rest
  else delete documentValue.ghosts
}

// Yes: the ghost becomes a real branch where it was waiting.
export function acceptGhost(documentValue, id) {
  const ghost = ghostNodes(documentValue).find((item) => item.id === id)
  if (!ghost) return null
  const { why, ghost: _flag, ...real } = ghost
  withoutGhost(documentValue, id)
  documentValue.nodes.push(real)
  return real
}

// No: it goes, and nothing is added.
export function dismissGhost(documentValue, id) {
  withoutGhost(documentValue, id)
}
