import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { fromFabric } from './fabric.js'
import { readJsonCanvas, writeJsonCanvas } from './jsoncanvas.js'
import { applyChanges, compactStacking, planOperation, stacking } from './operations.js'

const fixture = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../tests/fixtures/documents/app-all-tools.json', import.meta.url)), 'utf8'))
const viaJson = (value) => JSON.parse(JSON.stringify(value))

test('an edited document saves as JSON Canvas and reads back the same: geometry, order, locks and removals', () => {
  let doc = fromFabric(fixture.content, fixture.pageState)
  const movable = doc.objects.filter((object) => object.type !== 'connector' && object.type !== 'unknown')
  assert.ok(movable.length >= 4, 'fixture has objects to edit')
  const [first, second, third] = movable
  const run = (operation) => { doc = applyChanges(doc, planOperation(doc, operation).op) }
  run({ type: 'move', ids: [first.id], dx: 33, dy: -12 })
  run({ type: 'setGeometry', id: second.id, geometry: { rotation: 30, width: second.geometry.width + 20 } })
  run({ type: 'lock', ids: [second.id], locked: true })
  run({ type: 'reorder', ids: [first.id], to: 'front' })
  run({ type: 'remove', ids: [third.id] })

  const saved = viaJson(writeJsonCanvas(compactStacking(doc), { derived: 'omit' }))
  const back = readJsonCanvas(saved)
  const find = (d, id) => d.objects.find((object) => object.id === id)
  assert.equal(find(back, third.id), undefined)
  assert.equal(find(back, second.id).locked, true)
  assert.equal(find(back, second.id).geometry.rotation, 30)
  assert.equal(find(back, first.id).geometry.x, find(doc, first.id).geometry.x)
  assert.deepEqual(back.objects.map((object) => object.id), stacking(doc).map((object) => object.id))
})
