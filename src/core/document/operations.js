// Edit operations on the engine-neutral document model (F-028), as pure planners. Each takes the current document (never changed
// by it) and what the user asked for, and returns
//   { op: { label, changes: [{ id, before, after }] }, skipped: [ids refused because they are locked] }
// where `op` is exactly what the undo history (F-030, core/document/history.js: `record(op)`) takes: objects are immutable values,
// `before` is the object as it was and `after` the object that replaces it (null: removed). So a planner is the whole editing logic,
// the history and the engine only apply it. A locked object refuses move, setGeometry and remove; it can still be reordered and
// unlocked. Only top-level objects are addressed (group children are edited through their group).

const GEOMETRY_KEYS = ['x', 'y', 'width', 'height', 'rotation', 'scaleX', 'scaleY', 'flipX', 'flipY', 'skewX', 'skewY']

export const NUDGE_STEP = 1
export const NUDGE_STEP_FAST = 10
export const nudgeDistance = ({ shiftKey } = {}) => (shiftKey ? NUDGE_STEP_FAST : NUDGE_STEP)

export const isLocked = (object) => object?.locked === true
export const lockedIds = (doc) => new Set(doc.objects.filter((object) => isLocked(object) && object.id !== undefined).map((object) => object.id))

const byId = (doc, id) => doc.objects.find((object) => object?.id === id)
const isConnector = (object) => object?.type === 'connector'
const result = (label, changes, skipped = []) => ({ op: { label, changes }, skipped })

export function stacking(doc) {
  return doc.objects.map((object, index) => [object, index]).sort(([a, i], [b, j]) => ((a.z ?? i) - (b.z ?? j)) || (i - j)).map(([object]) => object)
}

export function planMove(doc, { ids, dx, dy }) {
  const changes = []
  const skipped = []
  for (const id of ids) {
    const object = byId(doc, id)
    if (!object?.geometry) continue
    if (isLocked(object)) { skipped.push(id); continue }
    changes.push({ id, before: object, after: { ...object, geometry: { ...object.geometry, x: (object.geometry.x ?? 0) + dx, y: (object.geometry.y ?? 0) + dy } } })
  }
  return result('Move', changes, skipped)
}

export function planSetGeometry(doc, { id, geometry }) {
  const object = byId(doc, id)
  if (!object?.geometry) return result('Transform', [])
  if (isLocked(object)) return result('Transform', [], [id])
  const patch = Object.fromEntries(Object.entries(geometry).filter(([key]) => GEOMETRY_KEYS.includes(key)))
  return result('Transform', [{ id, before: object, after: { ...object, geometry: { ...object.geometry, ...patch } } }])
}

// The ids that may be removed (not locked) and the connectors that go with them (a connector goes with either end).
export function planRemove(doc, { ids }) {
  const skipped = []
  const gone = new Set()
  for (const id of ids) {
    const object = byId(doc, id)
    if (!object) continue
    if (isLocked(object)) skipped.push(id)
    else gone.add(id)
  }
  const changes = doc.objects
    .filter((object) => object && (gone.has(object.id) || (isConnector(object) && (gone.has(object.fromId) || gone.has(object.toId)))))
    .map((object) => ({ id: object.id, before: object, after: null }))
  return result('Delete', changes, skipped)
}

// to: 'forward' | 'backward' (past the next object that is not a connector and not selected), 'front' | 'back' (past all of them).
// The objects that change place swap the z values among themselves, so the others (and any gaps in z) are left alone.
export function planReorder(doc, { ids, to }) {
  const chosen = new Set(ids)
  const list = stacking(doc).filter((object) => object?.id !== undefined)
  const solid = (object) => !isConnector(object) && !chosen.has(object.id)
  let next = [...list]
  if (to === 'front' || to === 'back') {
    const picked = list.filter((object) => chosen.has(object.id))
    const rest = list.filter((object) => !chosen.has(object.id))
    if (to === 'front') {
      const lastSolid = rest.findLastIndex((object) => !isConnector(object))
      next = [...rest.slice(0, lastSolid + 1), ...picked, ...rest.slice(lastSolid + 1)]
    } else {
      const firstSolid = rest.findIndex((object) => !isConnector(object))
      const at = firstSolid === -1 ? rest.length : firstSolid
      next = [...rest.slice(0, at), ...picked, ...rest.slice(at)]
    }
  } else if (to === 'forward' || to === 'backward') {
    const forward = to === 'forward'
    const starts = next.map((object, index) => (chosen.has(object.id) ? index : -1)).filter((index) => index !== -1)
    if (forward) starts.reverse()
    for (const start of starts) {
      const object = next[start]
      let target = start
      do target += forward ? 1 : -1
      while (target >= 0 && target < next.length && !solid(next[target]))
      if (target < 0 || target >= next.length) continue
      next.splice(start, 1)
      next.splice(target, 0, object)
    }
  } else throw new Error(`unknown reorder target ${JSON.stringify(to)}`)
  const slots = list.map((object, index) => object.z ?? index).sort((a, b) => a - b)
  const changes = []
  next.forEach((object, index) => { if ((object.z ?? list.indexOf(object)) !== slots[index]) changes.push({ id: object.id, before: object, after: { ...object, z: slots[index] } }) })
  return result('Reorder', changes)
}

export function planLock(doc, { ids, locked }) {
  const changes = []
  for (const id of ids) {
    const object = byId(doc, id)
    if (!object || isLocked(object) === locked) continue
    const after = { ...object }
    if (locked) after.locked = true
    else delete after.locked
    changes.push({ id, before: object, after })
  }
  return result(locked ? 'Lock' : 'Unlock', changes)
}

const PLANNERS = { move: planMove, setGeometry: planSetGeometry, remove: planRemove, reorder: planReorder, lock: planLock }

export function planOperation(doc, operation) {
  const plan = PLANNERS[operation?.type]
  if (!plan) throw new Error(`unknown operation ${JSON.stringify(operation?.type)}`)
  return plan(doc, operation)
}

// Applies an op to a document and returns the new one (the history does this too; this is for hosts and tests without one).
export function applyChanges(doc, op) {
  const replaced = new Map(op.changes.filter((change) => change.after).map((change) => [change.id, change.after]))
  const removed = new Set(op.changes.filter((change) => !change.after).map((change) => change.id))
  const objects = doc.objects.filter((object) => !removed.has(object?.id)).map((object) => (replaced.has(object?.id) ? replaced.get(object.id) : object))
  return { ...doc, objects }
}

// The same document with z = position, so saved stacking has no gaps (a connector is saved at its place among the nodes).
export function compactStacking(doc) {
  const objects = stacking(doc).map((object, index) => (object.z === index ? object : { ...object, z: index }))
  return { ...doc, objects }
}
