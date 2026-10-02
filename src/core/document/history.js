// Undo/redo over the engine-independent document model (F-030, slice P-06). Pure JS: no Leafer, no Fabric, no DOM.
//
// The history owns the current document value. Every edit is recorded as a small patch (an operation) and never as a snapshot:
//
//   op = { label?, changes: [{ id, before, after }], page?: { before, after }, selection?: { before, after } }
//
//   change.before === null   the object was added          change.after === null   the object was removed
//   both present             the object was replaced by a new value (objects are immutable values: edit by copying)
//   page                     the page grid { columns, rows, ... } changed
//   selection                object ids selected before and after the edit (optional; see undo())
//
// Documents are immutable and structurally shared: a step keeps references to the (few) object values it changed, and the
// objects it did not touch are the very same references as in the document, so a step on a 600-object note costs the changed
// objects only (about 1 KiB for a moved object), not a copy of the note.
//
// A remote or agent merge is NOT an edit. mergeRemote(doc) replaces the base the history works on and leaves both stacks alone.
// Undo and redo are three-way merges against the CURRENT document: for each changed object, a field (geometry, content, ...) is
// reverted only if it still holds the value the step wrote. A field someone else changed since (an agent rewrote the text of a
// sticky the user moved) keeps the newer value; objects the step never touched are never visited. So undo cannot revert a write
// it did not make, and a merge cannot corrupt the stacks. A step with nothing left to revert is dropped and undo continues to
// the next one.

const DEFAULT_MAX_STEPS = 200
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024

export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let index = 0; index < a.length; index++) if (!deepEqual(a[index], b[index])) return false
    return true
  }
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) if (!(key in b) || !deepEqual(a[key], b[key])) return false
  return true
}

// Rough retained size of an immutable value, in bytes (strings count their length: an inline picture is a long data URL).
const sizes = new WeakMap()
export function sizeOf(value) {
  if (typeof value === 'string') return 16 + value.length * 2
  if (typeof value !== 'object' || value === null) return 8
  const known = sizes.get(value)
  if (known !== undefined) return known
  let total = 24
  if (Array.isArray(value)) for (const item of value) total += sizeOf(item)
  else for (const key of Object.keys(value)) total += 16 + key.length * 2 + sizeOf(value[key])
  sizes.set(value, total)
  return total
}

// Equality that ignores what a JSON Canvas round trip (an agent merge) rewrites without the object changing: stacking values are
// renumbered 0..n and an empty `extras` appears.
const plain = (object) => { const { z, extras, ...rest } = object; return extras && Object.keys(extras).length ? { ...rest, extras } : rest }
const sameIgnoringZ = (a, b) => a === b || Boolean(a && b && deepEqual(plain(a), plain(b)))

const idsOf = (doc) => new Map(doc.objects.filter((object) => object && object.id !== undefined).map((object, index) => [object.id, object]))

// The changes that turn document a into document b (by id; reference equality first, then structural equality).
export function diffDocuments(a, b) {
  const before = idsOf(a)
  const after = idsOf(b)
  const changes = []
  for (const [id, object] of before) {
    const next = after.get(id)
    if (next === undefined) changes.push({ id, before: object, after: null })
    else if (next !== object && !deepEqual(next, object)) changes.push({ id, before: object, after: next })
  }
  for (const [id, object] of after) if (!before.has(id)) changes.push({ id, before: null, after: object })
  const op = { changes }
  if (!deepEqual(a.page, b.page)) op.page = { before: a.page, after: b.page }
  return op
}

// Three-way merge of one value: start from what is there now, and move each field from `expected` (what the step left) to
// `target` (what undo/redo wants) unless someone else changed that field since.
function mergeFields(current, expected, target) {
  if (current === expected) return { value: target, skipped: 0 }
  const merged = { ...current }
  let skipped = 0
  for (const key of new Set([...Object.keys(expected), ...Object.keys(target)])) {
    if (deepEqual(expected[key], target[key])) continue
    if (!deepEqual(current[key], expected[key])) { skipped++; continue }
    if (target[key] === undefined) delete merged[key]
    else merged[key] = target[key]
  }
  return { value: deepEqual(merged, current) ? current : merged, skipped }
}

// Applies one direction of an op to a document. `force` is for recording (the caller's own edit: nothing to reconcile).
function applyOp(doc, op, direction, force = false) {
  const index = idsOf(doc)
  const removed = new Set()
  const replaced = new Map()
  const added = []
  const changed = []
  let skipped = 0
  for (const change of op.changes) {
    const expected = direction === 'undo' ? change.after : change.before
    const target = direction === 'undo' ? change.before : change.after
    const current = index.get(change.id) ?? null
    if (expected === null && target === null) continue
    if (force) {
      if (target === null) removed.add(change.id)
      else if (current) replaced.set(change.id, target)
      else added.push({ object: target, anchor: change.anchor })
      changed.push(change.id)
      continue
    }
    if (target === null) { // revert an add (or redo a remove): remove it, unless someone changed it since
      if (!current) continue
      if (!sameIgnoringZ(current, expected)) { skipped++; continue }
      removed.add(change.id)
    } else if (expected === null) { // revert a remove (or redo an add): bring it back, unless it is back already
      if (current) { skipped++; continue }
      added.push({ object: target, anchor: change.anchor })
    } else { // revert a replace
      if (!current) { skipped++; continue }
      const merged = mergeFields(current, expected, target)
      skipped += merged.skipped
      if (merged.value === current) continue
      replaced.set(change.id, merged.value)
    }
    changed.push(change.id)
  }
  if (!force) {
    // No dangling connectors, and never lose an agent's content: a connector only comes back when both ends exist, and an object
    // someone connected to since is kept.
    const present = new Set(index.keys())
    for (const id of removed) present.delete(id)
    for (const { object } of added) present.add(object.id)
    for (let at = added.length - 1; at >= 0; at--) {
      const { object } = added[at]
      if (object.type === 'connector' && (!present.has(object.fromId) || !present.has(object.toId))) {
        added.splice(at, 1)
        changed.splice(changed.indexOf(object.id), 1)
        skipped++
        present.delete(object.id)
      }
    }
    for (const object of doc.objects) {
      if (object?.type !== 'connector' || removed.has(object.id)) continue
      for (const end of [object.fromId, object.toId]) {
        // Edge case: a connector that belongs to this very step but whose own removal was skipped (the agent changed it) is still in the
        // document, so it blocks the removal of the object it points at, exactly like a connector the agent added.
        if (removed.has(end)) { removed.delete(end); changed.splice(changed.indexOf(end), 1); skipped++ }
      }
    }
  }
  let page = doc.page
  let pageChanged = false
  if (op.page) {
    const expected = direction === 'undo' ? op.page.after : op.page.before
    const target = direction === 'undo' ? op.page.before : op.page.after
    const merged = force ? { value: target, skipped: 0 } : mergeFields(page, expected, target)
    skipped += merged.skipped
    if (merged.value !== page && !deepEqual(merged.value, page)) { page = merged.value; pageChanged = true }
  }
  if (!changed.length && !pageChanged) return { doc, changed: [], page: false, skipped }
  let objects = doc.objects
  if (removed.size || replaced.size) {
    objects = []
    for (const object of doc.objects) {
      const id = object?.id
      if (removed.has(id)) continue
      objects.push(replaced.has(id) ? replaced.get(id) : object)
    }
  } else if (added.length) objects = doc.objects.slice()
  // Bring objects back next to the neighbour they had (ids survive a merge; `z` may be renumbered), else by their stacking value.
  for (const { object, anchor } of [...added].sort((a, b) => (a.object.z ?? 0) - (b.object.z ?? 0))) {
    let at = -1
    const prev = anchor?.prev == null ? -1 : objects.findIndex((candidate) => candidate?.id === anchor.prev)
    if (prev >= 0) at = prev + 1
    else {
      const next = anchor?.next == null ? -1 : objects.findIndex((candidate) => candidate?.id === anchor.next)
      if (next >= 0) at = next
    }
    if (at < 0) {
      at = objects.length
      for (let position = 0; position < objects.length; position++) if ((objects[position]?.z ?? 0) > (object.z ?? 0)) { at = position; break }
    }
    objects.splice(at, 0, object)
  }
  // Stacking values must stay unique and in array order: renumber only when an insertion broke that.
  if (added.length && objects.some((object, position) => position > 0 && !((objects[position - 1]?.z ?? 0) < (object?.z ?? 0)))) {
    objects = objects.map((object, position) => (object && object.z !== position ? { ...object, z: position } : object))
  }
  const shift = op.page?.shift
  const signed = (value) => (value ? (direction === 'undo' ? -value : value) : 0)
  const pageShift = shift && (shift.x || shift.y) ? { x: signed(shift.x), y: signed(shift.y) } : null
  return { doc: { ...doc, objects, page }, changed, page: pageChanged, skipped, pageShift }
}

// A page change may carry `shift: { x, y }`, the distance every object moved because pages were added or folded on the top or left (the
// page frame's origin moved); the view follows it, and undo and redo report it (negated for undo) as `pageShift`.
const sumShift = (a, b) => (a || b ? { x: (a?.x ?? 0) + (b?.x ?? 0), y: (a?.y ?? 0) + (b?.y ?? 0) } : undefined)

// Folds a later op into an earlier one (a drag is many moves, one step): the first `before` and the last `after` survive.
function combine(first, second) {
  const byId = new Map(first.changes.map((change) => [change.id, change]))
  for (const change of second.changes) {
    const earlier = byId.get(change.id)
    if (!earlier) byId.set(change.id, { ...change })
    else byId.set(change.id, { id: change.id, before: earlier.before, after: change.after, anchor: change.anchor ?? earlier.anchor })
  }
  const changes = [...byId.values()].filter((change) => !(change.before === null && change.after === null) && change.before !== change.after && !(change.before && change.after && deepEqual(change.before, change.after)))
  const merged = { label: first.label ?? second.label, changes }
  const page = first.page && second.page ? { before: first.page.before, after: second.page.after, shift: sumShift(first.page.shift, second.page.shift) } : first.page || second.page
  if (page && (!deepEqual(page.before, page.after) || page.shift?.x || page.shift?.y)) merged.page = page
  const selection = first.selection || second.selection
    ? { before: first.selection?.before ?? second.selection?.before, after: second.selection?.after ?? first.selection?.after }
    : null
  if (selection) merged.selection = selection
  return merged
}

const weightOf = (op) => {
  let total = 64
  for (const change of op.changes) {
    if (change.before) total += sizeOf(change.before)
    if (change.after) total += sizeOf(change.after)
  }
  if (op.page) total += sizeOf(op.page.before) + sizeOf(op.page.after)
  return total
}

export function createHistory({ doc, maxSteps = DEFAULT_MAX_STEPS, maxBytes = DEFAULT_MAX_BYTES, coalesceMs = 600, now = () => Date.now() } = {}) {
  let current = doc
  let undoStack = []
  let redoStack = []
  let group = null
  let depth = 0
  let last = null // the entry that a coalescing record may extend: { entry, key, at }
  let bytes = 0
  const listeners = new Set()

  const push = (entry) => { entry.weight = weightOf(entry); bytes += entry.weight; undoStack.push(entry) }
  const dropRedo = () => { redoStack = [] }
  function trim() {
    while (undoStack.length > 1 && (undoStack.length > maxSteps || bytes > maxBytes)) bytes -= undoStack.shift().weight
    if (last && !undoStack.includes(last.entry)) last = null
  }
  const emit = (event) => { for (const listener of listeners) listener(event) }
  const isEmpty = (op) => !op.changes.length && !op.page

  function commit(op, key) {
    if (isEmpty(op)) return
    dropRedo()
    const at = now()
    if (key !== undefined && last && last.key === key && at - last.at <= coalesceMs && undoStack.at(-1) === last.entry) {
      const merged = combine(last.entry, op)
      bytes -= last.entry.weight
      undoStack.pop()
      if (!isEmpty(merged)) { push(merged); last = { entry: merged, key, at } } else last = null
    } else {
      const entry = { ...op, changes: op.changes.map((change) => ({ ...change })) }
      push(entry)
      last = { entry, key, at }
    }
    trim()
  }

  function record(given, { coalesce } = {}) {
    // Work on copies: the caller's change objects are never modified (anchors are ours).
    const op = { ...given, changes: given.changes.map((change) => {
      if (change.after !== null || change.before === null || change.anchor) return { ...change }
      const at = current.objects.findIndex((object) => object?.id === change.id)
      return { ...change, anchor: { prev: current.objects[at - 1]?.id ?? null, next: current.objects[at + 1]?.id ?? null } }
    }) }
    const applied = applyOp(current, op, 'redo', true)
    current = applied.doc
    if (group) { group.op = group.op ? combine(group.op, op) : combine({ changes: [] }, op); if (op.label && !group.op.label) group.op.label = op.label }
    else commit(op, coalesce)
    emit({ type: 'record', changed: applied.changed })
    return current
  }

  function recordDocument(next, { label, selection, coalesce } = {}) {
    const op = diffDocuments(current, next)
    if (label) op.label = label
    if (selection) op.selection = selection
    if (isEmpty(op)) return current
    return record(op, { coalesce })
  }

  function begin(label) {
    if (!depth++) group = { label, op: null }
  }

  function end({ cancel = false } = {}) {
    if (!depth) return null
    if (--depth) return null
    const finished = group
    group = null
    if (cancel && finished.op) { // undo what the group did, without a step
      const applied = applyOp(current, finished.op, 'undo')
      current = applied.doc
      emit({ type: 'cancel', changed: applied.changed })
      return null
    }
    if (finished.op) { if (finished.label) finished.op.label = finished.label; commit(finished.op) }
    return finished.op
  }

  function step(from, to, direction) {
    while (depth) end()
    last = null
    while (from.length) {
      const entry = from.pop()
      if (from === undoStack) bytes -= entry.weight
      const applied = applyOp(current, entry, direction)
      if (!applied.changed.length && !applied.page) continue // nothing left of it to revert (someone else rewrote it all): drop it
      current = applied.doc
      if (to === undoStack) push(entry)
      else to.push(entry)
      if (to === undoStack) trim()
      const wanted = entry.selection?.[direction === 'undo' ? 'before' : 'after']
      const present = idsOf(current)
      const selection = (wanted ?? applied.changed).filter((id) => present.has(id))
      const result = { doc: current, label: entry.label, changed: applied.changed, page: applied.page, selection, skipped: applied.skipped, pageShift: applied.pageShift }
      emit({ type: direction, ...result })
      return result
    }
    return null
  }

  return {
    get doc() { return current },
    get canUndo() { return undoStack.length > 0 },
    get canRedo() { return redoStack.length > 0 },
    record,
    recordDocument,
    begin,
    end,
    undo: () => step(undoStack, redoStack, 'undo'),
    redo: () => step(redoStack, undoStack, 'redo'),
    // A different note (or a reload): a new base and an empty history.
    reset(next) { current = next; undoStack = []; redoStack = []; group = null; depth = 0; last = null; bytes = 0; emit({ type: 'reset' }) },
    // An agent or sync merge: a new base, not an edit. Both stacks stay as they are. Objects equal to the old ones keep their
    // references, so later steps and diffs stay cheap and untouched objects stay identical.
    mergeRemote(next) {
      // A step never spans a merge: what was recorded before it is closed as its own step, and nothing coalesces across it.
      last = null
      if (group?.op) { group.op.label ??= group.label; commit(group.op); group.op = null }
      const known = idsOf(current)
      const objects = next.objects.map((object) => { const old = object && known.get(object.id); return old && deepEqual(old, object) ? old : object })
      current = { ...next, objects, page: deepEqual(next.page, current.page) ? current.page : next.page }
      emit({ type: 'remote' })
      return current
    },
    stats: () => ({ undoSteps: undoStack.length, redoSteps: redoStack.length, bytes }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}
