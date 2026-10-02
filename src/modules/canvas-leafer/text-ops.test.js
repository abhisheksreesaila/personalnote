import assert from 'node:assert/strict'
import test from 'node:test'
import { applyChanges } from '../../core/document/operations.js'
import { applyMatrix, placementMatrix } from './placement.js'
import { fitGeometry, newSticky, newText, nextZ, objectAt, planPrettify, planSetContent, planSetStyle, toLocal } from './text-ops.js'

const box = { x: 100, y: 50, width: 240, height: 200, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const doc = () => ({
  schemaVersion: 1, page: { columns: 1, rows: 1 }, extras: {},
  objects: [
    { id: 't', type: 'text', mode: 'box', z: 0, content: 'hello', style: { fontSize: 24 }, geometry: { ...box, height: 30 } },
    { id: 's', type: 'sticky', z: 1, content: 'note', color: '#ffd60a', colorKey: 'c1', style: { fontSize: 34, color: '#292202' }, geometry: { ...box, x: 500 } },
    { id: 'l', type: 'text', mode: 'point', z: 2, content: 'locked', locked: true, geometry: { ...box, y: 600, height: 30 } },
  ],
})

test('a new text is a point text at the click with the default style; a new sticky is centred on it, in its colour and ink', () => {
  const text = newText({ id: 'n', z: 3, point: { x: 10, y: 20 }, style: { fontSize: 24, color: '#000' } })
  assert.equal(text.type, 'text')
  assert.equal(text.mode, 'point')
  assert.equal(text.content, '')
  assert.deepEqual([text.geometry.x, text.geometry.y, text.geometry.rotation, text.geometry.scaleX], [10, 20, 0, 1])
  const sticky = newSticky({ id: 'm', z: 4, point: { x: 400, y: 300 }, fill: '#ffd60a', ink: '#292202', style: { fontFamily: 'Caveat' } })
  assert.equal(sticky.color, '#ffd60a')
  assert.equal(sticky.colorKey, 'c1')
  assert.equal(sticky.style.color, '#292202')
  assert.deepEqual([sticky.geometry.x, sticky.geometry.y, sticky.geometry.width, sticky.geometry.height], [280, 200, 240, 200])
})

test('nextZ puts a new object on top', () => {
  assert.equal(nextZ(doc()), 3)
  assert.equal(nextZ({ objects: [] }), 0)
})

test('setting content is one change that keeps everything else, and a locked object refuses it', () => {
  const plan = planSetContent(doc(), { id: 't', content: 'hello world', geometry: { height: 60 } })
  assert.equal(plan.op.changes.length, 1)
  const next = applyChanges(doc(), plan.op).objects[0]
  assert.equal(next.content, 'hello world')
  assert.equal(next.geometry.height, 60)
  assert.equal(next.geometry.width, 240)
  assert.equal(planSetContent(doc(), { id: 'l', content: 'x' }).op.changes.length, 0)
  assert.equal(planSetContent(doc(), { id: 't', content: 'hello' }).op.changes.length, 0) // nothing changed: nothing to record
})

test('style changes go to text and stickies; the paper colour is a sticky thing and its key follows', () => {
  const plan = planSetStyle(doc(), { ids: ['t', 's', 'l'], style: { fontSize: 40 } })
  assert.deepEqual(plan.op.changes.map((c) => c.id), ['t', 's'])
  const next = applyChanges(doc(), plan.op)
  assert.equal(next.objects[0].style.fontSize, 40)
  assert.equal(next.objects[1].style.fontSize, 40)
  const paper = planSetStyle(doc(), { ids: ['t', 's'], paper: { fill: '#30d158', ink: '#07140b' } })
  assert.deepEqual(paper.op.changes.map((c) => c.id), ['s'])
  const sticky = applyChanges(doc(), paper.op).objects[1]
  assert.deepEqual([sticky.color, sticky.colorKey, sticky.style.color], ['#30d158', 'c2', '#07140b'])
})

test('a content-fitted size keeps the top-left corner where it was, turned or not', () => {
  for (const rotation of [0, 30, -75]) {
    const geometry = { ...box, rotation, height: 30 }
    const corner = applyMatrix(placementMatrix(geometry), { x: 0, y: 0 })
    const fitted = fitGeometry({ type: 'text', mode: 'box', geometry }, { width: 240, height: 90 })
    assert.equal(fitted.height, 90)
    const after = applyMatrix(placementMatrix(fitted), { x: 0, y: 0 })
    assert.ok(Math.abs(after.x - corner.x) < 1e-9 && Math.abs(after.y - corner.y) < 1e-9, `rotation ${rotation}`)
  }
})

test('size rules: a point text is as big as its words, a box text as tall as its lines, a sticky is as tall as its words need, never below its minimum', () => {
  const point = fitGeometry({ type: 'text', mode: 'point', geometry: box }, { width: 77, height: 30 })
  assert.deepEqual([point.width, point.height], [77, 30])
  const wide = fitGeometry({ type: 'text', mode: 'box', geometry: box }, { width: 999, height: 44 })
  assert.deepEqual([wide.width, wide.height], [240, 44])
  assert.equal(fitGeometry({ type: 'sticky', geometry: box }, { width: 196, height: 40 }).height, 200)
  assert.equal(fitGeometry({ type: 'sticky', geometry: box }, { width: 196, height: 300 }).height, 344)
  assert.equal(fitGeometry({ type: 'sticky', geometry: { ...box, height: 500 } }, { width: 196, height: 100 }).height, 200) // it shrinks back, as the Fabric sticky does
})

test('objectAt finds the topmost editable text or sticky under a page point, through a turn', () => {
  const d = doc()
  const sizes = new Map(d.objects.map((o) => [o.id, { width: o.geometry.width, height: o.geometry.height }]))
  assert.equal(objectAt(d, sizes, { x: 120, y: 60 })?.id, 't')
  assert.equal(objectAt(d, sizes, { x: 600, y: 100 })?.id, 's')
  assert.equal(objectAt(d, sizes, { x: 5, y: 5 }), null)
  assert.equal(objectAt(d, sizes, { x: 120, y: 610 }), null, 'a locked text is not edited')
  d.objects[1].geometry = { ...d.objects[1].geometry, rotation: 90 } // centre (620,150): the box is now 200 wide and 240 tall around it
  assert.equal(objectAt(d, sizes, { x: 620, y: 40 })?.id, 's')
  assert.equal(objectAt(d, sizes, { x: 740, y: 150 }), null)
})

test('toLocal is the inverse of the placement, turned or not', () => {
  const g = { ...box, rotation: 30 }
  const p = applyMatrix(placementMatrix(g), { x: 40, y: 25 })
  const local = toLocal(g, { width: g.width, height: g.height }, p)
  assert.ok(Math.abs(local.x - 40) < 1e-9 && Math.abs(local.y - 25) < 1e-9)
})

test('Prettify tidies every unlocked text and sticky in one op, with the geometry the new words need, and records nothing when all is tidy', () => {
  const d = doc()
  d.objects[0].content = '- one   \n\n\n\ntwo'
  d.objects[2].content = '- locked  '
  const plan = planPrettify(d, { fit: (object) => ({ ...object.geometry, height: 99 }) })
  assert.deepEqual(plan.op.changes.map((change) => change.id), ['t'])
  assert.equal(plan.op.changes[0].after.content, '• one\n\ntwo')
  assert.equal(plan.op.changes[0].after.geometry.height, 99)
  const tidy = applyChanges(d, plan.op)
  assert.equal(planPrettify(tidy, { fit: (object) => object.geometry }).op.changes.length, 0)
})
