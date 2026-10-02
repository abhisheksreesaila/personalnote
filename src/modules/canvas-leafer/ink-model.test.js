import assert from 'node:assert/strict'
import test from 'node:test'
import { createHistory } from '../../core/document/history.js'
import { validateDocument } from '../../core/document/validate.js'
import { createEraser, decimate, drawOp, HIGHLIGHT_ALPHA, inkObject, smoothPath, topZ } from './ink-model.js'

const doc = (objects) => ({ schemaVersion: 1, page: { columns: 1, rows: 1 }, objects, extras: {} })
const line = (from, to, count = 40) => Array.from({ length: count + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / count, y: from.y + ((to.y - from.y) * i) / count }))

test('a drawn stroke is a model ink object in its own box frame, smoothed like the Fabric pen', () => {
  const object = inkObject({ points: [{ x: 100, y: 200 }, { x: 110, y: 205 }, { x: 130, y: 230 }, { x: 160, y: 240 }], tool: 'pen', color: '#1c70a8', width: 3, z: 4 })
  assert.equal(object.type, 'ink')
  assert.equal(object.kind, 'stroke')
  assert.deepEqual([object.tool, object.color, object.width, object.cap, object.join, object.blend], ['pen', '#1c70a8', 3, 'round', 'round', 'source-over'])
  assert.equal(object.alpha, undefined)
  assert.deepEqual(object.path[0], ['M', 0, 0]) // the path starts at the box corner it was measured from
  assert.ok(object.path.some((command) => command[0] === 'Q') && object.path.at(-1)[0] === 'L')
  assert.equal(object.geometry.x, 100)
  assert.ok(object.geometry.y > 190 && object.geometry.y <= 200)
  assert.equal(object.points[0].x, 0)
  assert.equal(validateDocument(doc([object]), { requireIds: true, strict: true }).ok, true)
})

test('the highlighter keeps the colour and a third of the opacity, a tap is a dot', () => {
  const stroke = inkObject({ points: line({ x: 0, y: 0 }, { x: 50, y: 0 }, 10), tool: 'highlight', color: '#df8437', width: 20, z: 0 })
  assert.equal(stroke.color, '#df8437')
  assert.equal(stroke.alpha, HIGHLIGHT_ALPHA)
  const dot = inkObject({ points: [{ x: 300, y: 300 }, { x: 300, y: 300 }], tool: 'highlight', color: '#df8437', width: 20, z: 1 })
  assert.deepEqual([dot.kind, dot.radius, dot.geometry.x, dot.geometry.y, dot.geometry.width], ['dot', 10, 290, 290, 20])
  assert.equal(dot.alpha, HIGHLIGHT_ALPHA)
})

test('decimation drops points closer than the distance and keeps the ends; the distance follows the zoom', () => {
  const dense = line({ x: 0, y: 0 }, { x: 10, y: 0 }, 100) // 0.1 apart
  const kept = decimate(dense, 0.8)
  assert.deepEqual([kept[0], kept.at(-1)], [dense[0], dense.at(-1)])
  assert.ok(kept.length < 20)
  const zoomed = inkObject({ points: dense, tool: 'pen', color: '#000000', width: 1, z: 0, scale: 4 })
  const normal = inkObject({ points: dense, tool: 'pen', color: '#000000', width: 1, z: 0, scale: 1 })
  assert.ok(zoomed.points.length > normal.points.length)
  assert.deepEqual(smoothPath([{ x: 0, y: 0 }, { x: 4, y: 0 }]), [['M', 0, 0], ['Q', 0, 0, 2, 0], ['L', 4, 0]])
})

test('erasing through the middle of a stroke leaves two fragments, as one undoable step', () => {
  const base = inkObject({ points: line({ x: 100, y: 100 }, { x: 400, y: 100 }), tool: 'pen', color: '#20201e', width: 3, z: 0, id: 'a' })
  const other = inkObject({ points: line({ x: 100, y: 300 }, { x: 400, y: 300 }), tool: 'pen', color: '#20201e', width: 3, z: 1, id: 'b' })
  const document = doc([base, other])
  const eraser = createEraser(document)
  const change = eraser.between({ x: 250, y: 60 }, { x: 250, y: 140 })
  assert.deepEqual(change.removed, ['a'])
  assert.equal(change.added.length, 2)
  const [left, right] = change.added
  assert.ok(left.geometry.x + left.geometry.width < 250 && right.geometry.x > 250)
  assert.ok(left.z >= 0 && right.z > left.z && right.z < 1, 'the pieces keep the stroke place in the stack')
  assert.equal(left.width, 3)
  assert.equal(eraser.between({ x: 250, y: 60 }, { x: 250, y: 140 }), null, 'the second pass finds nothing more')

  const history = createHistory({ doc: document })
  history.record(eraser.plan())
  assert.deepEqual(history.doc.objects.map((object) => object.id).filter((id) => id === 'a' || id === 'b'), ['b'])
  assert.equal(history.doc.objects.length, 3)
  assert.equal(validateDocument(history.doc, { requireIds: true, strict: true }).ok, true)
  history.undo()
  assert.deepEqual(history.doc.objects.map((object) => object.id), ['a', 'b'])
  history.redo()
  assert.equal(history.doc.objects.length, 3)
  assert.equal(history.canUndo, true)
})

test('a pass given up puts back what it took, and plans nothing', () => {
  const base = inkObject({ points: line({ x: 0, y: 100 }, { x: 300, y: 100 }), tool: 'pen', color: '#20201e', width: 3, z: 0, id: 'a' })
  const eraser = createEraser(doc([base]))
  const change = eraser.at({ x: 150, y: 100 })
  const back = eraser.revert()
  assert.deepEqual(back.removed.sort(), change.added.map((object) => object.id).sort())
  assert.deepEqual(back.added, [base])
  assert.equal(eraser.plan(), null)
  assert.equal(eraser.changed, false)
})

test('one sweep that erases fragments it made earlier changes the original only', () => {
  const base = inkObject({ points: line({ x: 0, y: 100 }, { x: 300, y: 100 }), tool: 'pen', color: '#20201e', width: 3, z: 0, id: 'a' })
  const eraser = createEraser(doc([base]))
  eraser.at({ x: 150, y: 100 })
  eraser.at({ x: 60, y: 100 })
  eraser.at({ x: 240, y: 100 })
  const op = eraser.plan()
  assert.deepEqual(op.changes.filter((change) => change.after === null).map((change) => change.id), ['a'])
  assert.equal(op.changes.filter((change) => change.before === null).length, 4)
  assert.deepEqual(op.selection, { before: [], after: [] })
})

test('a dot goes whole, a locked stroke and an untouched one stay, nothing erased is no step', () => {
  const dot = inkObject({ points: [{ x: 50, y: 50 }], tool: 'pen', color: '#000000', width: 6, z: 0, id: 'dot' })
  const locked = { ...inkObject({ points: line({ x: 0, y: 0 }, { x: 100, y: 0 }), tool: 'pen', color: '#000000', width: 3, z: 1, id: 'locked' }), locked: true }
  const far = inkObject({ points: line({ x: 500, y: 500 }, { x: 600, y: 500 }), tool: 'pen', color: '#000000', width: 3, z: 2, id: 'far' })
  const eraser = createEraser(doc([dot, locked, far]))
  assert.equal(eraser.at({ x: 400, y: 700 }), null)
  assert.equal(eraser.plan(), null)
  assert.deepEqual(eraser.at({ x: 50, y: 50 }).removed, ['dot'])
  assert.equal(eraser.at({ x: 50, y: 0 }), null)
  assert.deepEqual(eraser.plan().changes.map((change) => change.id), ['dot'])
})

test('a moved and scaled stroke is erased where it is on the page, and its pieces are placed there', () => {
  const stroke = inkObject({ points: line({ x: 0, y: 0 }, { x: 100, y: 0 }), tool: 'pen', color: '#000000', width: 2, z: 0, id: 's' })
  const placed = { ...stroke, geometry: { ...stroke.geometry, x: 200, y: 300, scaleX: 2, scaleY: 2 } } // 200 wide on the page, from x 200 to 400
  const eraser = createEraser(doc([placed]))
  assert.equal(eraser.at({ x: 50, y: 0 }), null, 'where it was drawn is empty now')
  const change = eraser.at({ x: 300, y: 300 })
  assert.equal(change.added.length, 2)
  assert.ok(Math.abs(change.added[0].width - 4) < 1e-9, 'a scaled stroke gets a scaled width')
  assert.ok(change.added[1].geometry.x > 300)
})

test('a new stroke is one step on top, with the page grid when it grew', () => {
  const base = doc([{ ...inkObject({ points: line({ x: 0, y: 0 }, { x: 10, y: 0 }), tool: 'pen', color: '#000000', width: 1, z: 7, id: 'x' }) }])
  assert.equal(topZ(base), 8)
  const object = inkObject({ points: line({ x: 0, y: 0 }, { x: 900, y: 0 }), tool: 'pen', color: '#000000', width: 1, z: topZ(base) })
  const history = createHistory({ doc: base })
  history.record(drawOp(object, { before: { columns: 1, rows: 1 }, after: { columns: 2, rows: 1 } }))
  assert.equal(history.doc.page.columns, 2)
  assert.equal(history.doc.objects.length, 2)
  const result = history.undo()
  assert.equal(result.page, true)
  assert.equal(history.doc.objects.length, 1)
  assert.equal(history.doc.page.columns, 1)
})
