// Edit operations on the engine-neutral document model (F-028). Each operation is a plain description
//   { type: 'move', ids, dx, dy } | { type: 'setGeometry', id, geometry } | { type: 'remove', ids }
//   | { type: 'reorder', ids, to: 'forward' | 'backward' | 'front' | 'back' } | { type: 'lock', ids, locked }
// applied in place by applyOperation, which returns a record of what happened:
//   { operation, changes: [{ id, before, after }], removed: [{ object, index }], skipped: [ids refused because they are locked] }
// The record holds enough to reverse the edit, so undo (F-030) can hook in here; this file does not know about undo, Leafer or Fabric.
// A locked object refuses move, setGeometry and remove; it can still be reordered and unlocked.
// Only top-level objects are addressed (group children are edited through their group).

const clone = (value) => structuredClone(value)
const GEOMETRY_KEYS = ['x', 'y', 'width', 'height', 'rotation', 'scaleX', 'scaleY', 'flipX', 'flipY', 'skewX', 'skewY']
const pick = (geometry, keys) => Object.fromEntries(keys.filter((key) => geometry && Object.hasOwn(geometry, key)).map((key) => [key, geometry[key]]))

export const NUDGE_STEP = 1
export const NUDGE_STEP_FAST = 10
export const nudgeDistance = ({ shiftKey } = {}) => (shiftKey ? NUDGE_STEP_FAST : NUDGE_STEP)

export const lockedIds = (doc) => new Set(doc.objects.filter((object) => object.locked === true && object.id !== undefined).map((object) => object.id))
export const isLocked = (object) => object?.locked === true

const byId = (doc, id) => doc.objects.find((object) => object.id === id)
const isConnector = (object) => object.type === 'connector'

function stacking(doc) {
  return doc.objects.map((object, index) => [object, index]).sort(([a, i], [b, j]) => ((a.z ?? i) - (b.z ?? j)) || (i - j)).map(([object]) => object)
}

function renumber(list) {
  list.forEach((object, index) => { object.z = index })
}

function record(operation) {
  return { operation, changes: [], removed: [], skipped: [] }
}

function move(doc, operation) {
  const result = record(operation)
  for (const id of operation.ids) {
    const object = byId(doc, id)
    if (!object?.geometry) continue
    if (isLocked(object)) { result.skipped.push(id); continue }
    const before = pick(object.geometry, ['x', 'y'])
    object.geometry.x = (object.geometry.x ?? 0) + operation.dx
    object.geometry.y = (object.geometry.y ?? 0) + operation.dy
    result.changes.push({ id, before, after: pick(object.geometry, ['x', 'y']) })
  }
  return result
}

function setGeometry(doc, operation) {
  const result = record(operation)
  const object = byId(doc, operation.id)
  if (!object?.geometry) return result
  if (isLocked(object)) { result.skipped.push(operation.id); return result }
  const keys = Object.keys(operation.geometry).filter((key) => GEOMETRY_KEYS.includes(key))
  const before = pick(object.geometry, GEOMETRY_KEYS)
  Object.assign(object.geometry, pick(operation.geometry, keys))
  result.changes.push({ id: operation.id, before, after: pick(object.geometry, GEOMETRY_KEYS) })
  return result
}

function remove(doc, operation) {
  const result = record(operation)
  const gone = new Set()
  for (const id of operation.ids) {
    const object = byId(doc, id)
    if (!object) continue
    if (isLocked(object)) result.skipped.push(id)
    else gone.add(id)
  }
  const order = stacking(doc)
  const kept = []
  order.forEach((object, index) => {
    // A connector goes with either end.
    const dies = gone.has(object.id) || (isConnector(object) && (gone.has(object.fromId) || gone.has(object.toId)))
    if (dies) result.removed.push({ object: clone(object), index })
    else kept.push(object)
  })
  doc.objects.splice(0, doc.objects.length, ...kept)
  renumber(doc.objects)
  return result
}

function reorder(doc, operation) {
  const result = record(operation)
  const chosen = new Set(operation.ids)
  const list = stacking(doc)
  const before = new Map(list.map((object, index) => [object.id ?? object, index]))
  const key = (object) => object.id ?? object
  const solid = (object) => !isConnector(object) && !chosen.has(object.id)
  let next = list
  if (operation.to === 'front' || operation.to === 'back') {
    const picked = list.filter((object) => chosen.has(object.id))
    const rest = list.filter((object) => !chosen.has(object.id))
    if (operation.to === 'front') {
      const lastSolid = rest.findLastIndex((object) => !isConnector(object))
      next = [...rest.slice(0, lastSolid + 1), ...picked, ...rest.slice(lastSolid + 1)]
    } else {
      const firstSolid = rest.findIndex((object) => !isConnector(object))
      const at = firstSolid === -1 ? rest.length : firstSolid
      next = [...rest.slice(0, at), ...picked, ...rest.slice(at)]
    }
  } else if (operation.to === 'forward' || operation.to === 'backward') {
    next = [...list]
    const forward = operation.to === 'forward'
    const indices = next.map((object, index) => (chosen.has(object.id) ? index : -1)).filter((index) => index !== -1)
    if (forward) indices.reverse()
    for (const start of indices) {
      const object = next[start]
      let target = start
      do target += forward ? 1 : -1
      while (target >= 0 && target < next.length && !solid(next[target]))
      if (target < 0 || target >= next.length) continue
      next.splice(start, 1)
      next.splice(target, 0, object) // lands past the neighbour it passed
    }
  } else throw new Error(`unknown reorder target ${operation.to}`)
  next.forEach((object, index) => {
    const was = before.get(key(object))
    if (was !== index) result.changes.push({ id: object.id, before: { z: object.z ?? was }, after: { z: index } })
  })
  renumber(next)
  doc.objects.splice(0, doc.objects.length, ...next)
  return result
}

function lock(doc, operation) {
  const result = record(operation)
  for (const id of operation.ids) {
    const object = byId(doc, id)
    if (!object) continue
    const was = isLocked(object)
    if (was === operation.locked) continue
    if (operation.locked) object.locked = true
    else delete object.locked
    result.changes.push({ id, before: { locked: was }, after: { locked: operation.locked } })
  }
  return result
}

const OPERATIONS = { move, setGeometry, remove, reorder, lock }

export function applyOperation(doc, operation) {
  const apply = OPERATIONS[operation?.type]
  if (!apply) throw new Error(`unknown operation ${JSON.stringify(operation?.type)}`)
  return apply(doc, operation)
}
