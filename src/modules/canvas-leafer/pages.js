// Page growth and fold-back on the document model (F-032), as pure functions: no Leafer, no DOM, tested in Node. The rules are the Fabric
// path's (reconcilePages and expandPagesDuringTransform in main.js): a page appears as an object crosses ANY edge of the grid, right,
// bottom, up or left, and folds back when it is emptied. A page added on the top or left shifts every object by whole pages (the page
// frame's origin is the first page's top-left corner), and the view follows by the same amount so nothing seems to move.
//
//   settlePages(pages, bounds)        after an edit: the grid the content needs ({ columns, rows, shiftX, shiftY })
//   growForDrag(pages, bounds)        while an object is dragged: grow only, before it reaches the edge
//   growForText(pages, bounds, o)     while words are typed: grow right and bottom only, a margin ahead of the words
//   finalizeOp(doc, op, options)      an edit as one history op: the edit, the connectors that follow it, and the page change it causes
import { PAGE } from '../../core/document/schema.js'
import { applyChanges } from '../../core/document/operations.js'
import { deepEqual } from '../../core/document/history.js'
import { shiftedDocument, shiftedObject } from '../../core/document/frame.js'
import { boundingRect, contentBounds } from './bounds.js'
import { danglingChanges, followChanges, indexById, rectOfObject } from './connectors.js'

export const EDGE_OVERFLOW = 6 // past the edge by more than this, a page is added (after an edit)
export const EDGE_SHRINK = 0 // a page folds back when the content is this far from it
export const TRANSFORM_EDGE_MARGIN = 24 // while dragging, a page appears when the object is this close to the edge
export const GHOST_REACH = 160 // while dragging, the page that would be added is previewed this far from the edge

const moved = (bounds, dx, dy) => ({ left: bounds.left + dx, top: bounds.top + dy, right: bounds.right + dx, bottom: bounds.bottom + dy })

// The grid the content needs. `bounds` is { left, top, right, bottom } of everything (connectors left out) or null for an empty note.
// Returns the new grid and the distance every object must move because pages were added on the top or left (positive) or folded away
// there (negative). Unlike a single reconcile on the former Fabric engine, a note that was emptied by several pages folds back all the way.
export function settlePages(pages, bounds, { pageW = PAGE.width, pageH = PAGE.height } = {}) {
  if (!bounds) return { columns: 1, rows: 1, shiftX: 0, shiftY: 0 }
  let { columns, rows } = pages
  let shiftX = 0
  let shiftY = 0
  let box = bounds
  const prependColumns = box.left < -EDGE_OVERFLOW ? Math.ceil((-EDGE_OVERFLOW - box.left) / pageW) : 0
  const prependRows = box.top < -EDGE_OVERFLOW ? Math.ceil((-EDGE_OVERFLOW - box.top) / pageH) : 0
  if (prependColumns || prependRows) {
    columns += prependColumns
    rows += prependRows
    shiftX += prependColumns * pageW
    shiftY += prependRows * pageH
    box = moved(box, prependColumns * pageW, prependRows * pageH)
  }
  if (box.right > columns * pageW + EDGE_OVERFLOW) columns += Math.ceil((box.right - columns * pageW - EDGE_OVERFLOW) / pageW)
  if (box.bottom > rows * pageH + EDGE_OVERFLOW) rows += Math.ceil((box.bottom - rows * pageH - EDGE_OVERFLOW) / pageH)
  for (;;) {
    if (columns > 1 && box.left > pageW + EDGE_SHRINK) { columns -= 1; shiftX -= pageW; box = moved(box, -pageW, 0) }
    else if (columns > 1 && box.right < (columns - 1) * pageW - EDGE_SHRINK) columns -= 1
    else break
  }
  for (;;) {
    if (rows > 1 && box.top > pageH + EDGE_SHRINK) { rows -= 1; shiftY -= pageH; box = moved(box, 0, -pageH) }
    else if (rows > 1 && box.bottom < (rows - 1) * pageH - EDGE_SHRINK) rows -= 1
    else break
  }
  return { columns, rows, shiftX, shiftY }
}

// While an object is dragged: pages appear before it reaches the edge (a margin, so the new page is under it when it arrives) and never
// fold back until it is dropped.
export function growForDrag(pages, bounds, { pageW = PAGE.width, pageH = PAGE.height } = {}) {
  let { columns, rows } = pages
  const prependColumns = Math.max(0, Math.ceil((TRANSFORM_EDGE_MARGIN - bounds.left) / pageW))
  const prependRows = Math.max(0, Math.ceil((TRANSFORM_EDGE_MARGIN - bounds.top) / pageH))
  columns += prependColumns
  rows += prependRows
  const right = bounds.right + prependColumns * pageW
  const bottom = bounds.bottom + prependRows * pageH
  while (right > columns * pageW - TRANSFORM_EDGE_MARGIN) columns += 1
  while (bottom > rows * pageH - TRANSFORM_EDGE_MARGIN) rows += 1
  return { columns, rows, shiftX: prependColumns * pageW, shiftY: prependRows * pageH, changed: columns !== pages.columns || rows !== pages.rows }
}

// While words are typed: a page is added before the text reaches the right or bottom edge, by the same margin as a drag, and one line ahead
// at the bottom (the next line is what would cross it). Typing grows a text right and down, so nothing is prepended and no object moves
// (a turned text can need room on the left or the top as well: that is left to the settle when the typing is committed, which prepends then).
// It never folds back mid-typing (that is settled when the session ends). `lineHeight` is the height of one line.
export function growForText(pages, bounds, { lineHeight = 0, pageW = PAGE.width, pageH = PAGE.height } = {}) {
  let { columns, rows } = pages
  while (bounds.right > columns * pageW - TRANSFORM_EDGE_MARGIN) columns += 1
  while (bounds.bottom + lineHeight > rows * pageH - TRANSFORM_EDGE_MARGIN) rows += 1
  return { columns, rows, changed: columns !== pages.columns || rows !== pages.rows }
}

export { shiftedDocument, shiftedObject }

// The document with the changes applied, new objects (before: null) included.
function withChanges(doc, changes) {
  const base = applyChanges(doc, { changes })
  const known = new Set(doc.objects.map((object) => object?.id))
  const added = changes.filter((change) => change.after && !known.has(change.id)).map((change) => change.after)
  return added.length ? { ...base, objects: [...base.objects, ...added] } : base
}

const mergeInto = (changes, byId, id, before, after) => {
  const known = byId.get(id)
  if (known) known.after = after
  else { const change = { id, before, after }; changes.push(change); byId.set(id, change) }
}

// An edit that can change where things are (an add, a removal, a move, a resize, new words), as opposed to a re-stack or a lock.
function mayChangeBounds(changes) {
  return changes.some(({ before, after }) => {
    if (!before || !after) return true
    if (before === after) return false
    if (!before.geometry || !after.geometry) return false
    return !deepEqual(before.geometry, after.geometry) || before.strokeWidth !== after.strokeWidth || before.width !== after.width || before.radius !== after.radius || before.strokeUniform !== after.strokeUniform
  })
}

// An edit as one history op. `doc` is the document before the edit, `op` the edit ({ label, changes, selection?, page? }). Returns
//   { op, shift }  `op` is the edit plus the connectors that follow what moved, the connectors left without an end, and the page change
//                  the edit causes (`op.page = { before, after, shift }`); `shift` is the distance the page frame moved when pages were added
//                  or folded on the top or left. The objects the op names are given in the NEW frame; every other object is moved by the
//                  history, as a frame operation, whenever the step is applied, undone or redone (core/document/history.js), so an object
//                  that arrived since (an agent's) is moved back with the rest.
// options.sizeOf(object): the measured { width, height } of an object the model gives no size for (text laid out by the engine).
// options.floor: { columns, rows } the grid may not fold below (while words are being typed).
export function finalizeOp(doc, op, { sizeOf = () => ({}), floor = null } = {}) {
  const changes = op.changes.map((change) => ({ ...change }))
  const byId = new Map(changes.map((change) => [change.id, change]))
  const original = indexById(doc.objects)
  const rectOf = (object) => rectOfObject(object, sizeOf)
  const objectsNow = () => withChanges(doc, changes).objects

  // connectors follow what moved; none is left without an end
  const named = op.changes.filter((change) => change.after && change.after.type !== 'connector').map((change) => change.id)
  if (named.length) {
    for (const change of followChanges(objectsNow(), named, rectOf)) mergeInto(changes, byId, change.id, original.get(change.id) ?? change.before, change.after)
  }
  for (const change of danglingChanges(objectsNow())) mergeInto(changes, byId, change.id, original.get(change.id) ?? change.before, null)
  for (const change of [...changes]) if (change.before === null && change.after === null) { changes.splice(changes.indexOf(change), 1); byId.delete(change.id) }

  const before = op.page?.before ?? doc.page
  const start = op.page?.after ?? doc.page
  let shiftX = 0
  let shiftY = 0
  let after = { columns: start.columns, rows: start.rows }
  if (op.page || mayChangeBounds(op.changes)) {
    const settled = settlePages(start, contentBounds(objectsNow(), (object) => sizeOf(object)))
    after = { columns: settled.columns, rows: settled.rows }
    shiftX = settled.shiftX
    shiftY = settled.shiftY
    // a typing session that grew the grid ahead of its words: the grid does not fold back below it until the session ends (the caller passes no floor then)
    if (floor && !shiftX) after.columns = Math.max(after.columns, floor.columns)
    if (floor && !shiftY) after.rows = Math.max(after.rows, floor.rows)
    if (shiftX || shiftY) for (const change of changes) if (change.after) change.after = shiftedObject(change.after, shiftX, shiftY)
  }
  const result = { ...op, changes: changes.filter((change) => !(change.before && change.after && (change.before === change.after || deepEqual(change.before, change.after)))) }
  delete result.page
  if (after.columns !== before.columns || after.rows !== before.rows || shiftX || shiftY) result.page = { before, after: { ...before, columns: after.columns, rows: after.rows }, shift: { x: shiftX, y: shiftY } }
  return { op: result, shift: { x: shiftX, y: shiftY } }
}

export { boundingRect }
