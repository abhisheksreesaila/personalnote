// Stacking values with gaps (after a delete) must not reorder connectors against nodes on a JSON Canvas round trip.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { fromFabric, fromJsonCanvas, toJsonCanvas } from './index.js'

const fixture = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../tests/fixtures/documents/app-all-tools.json', import.meta.url)), 'utf8'))

test('a note with z gaps keeps its draw order through JSON Canvas', () => {
  const doc = fromFabric(fixture.content, fixture.pageState)
  const first = doc.objects.find((object) => object.type !== 'connector')
  const gapped = { ...doc, objects: doc.objects.filter((object) => object !== first) } // z now starts at 1: a gap
  assert.ok(gapped.objects.some((object, at) => object.z !== at))
  const back = fromJsonCanvas(JSON.parse(JSON.stringify(toJsonCanvas(gapped))))
  assert.deepEqual(back.objects.map((object) => object.id), gapped.objects.map((object) => object.id))
  assert.deepEqual(back.objects.map((object) => object.z), back.objects.map((object, at) => at))
})

test('a gap in the middle too', () => {
  const doc = fromFabric(fixture.content, fixture.pageState)
  const gapped = { ...doc, objects: doc.objects.filter((object, at) => at !== 2 && at !== 5) }
  const back = fromJsonCanvas(JSON.parse(JSON.stringify(toJsonCanvas(gapped))))
  assert.deepEqual(back.objects.map((object) => object.id), gapped.objects.map((object) => object.id))
})
