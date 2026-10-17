import assert from 'node:assert/strict'
import test from 'node:test'
import { plainText, readJsonCanvas, toJsonCanvas, validateDocument, validateJsonCanvas, writeJsonCanvas } from './index.js'

const REF = `res_${'a'.repeat(32)}`
const card = { id: 'card-1', type: 'notelink', z: 0, geometry: { x: 40, y: 60, width: 280, height: 92, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }, noteRef: REF, title: 'Lisbon trip', extras: {} }
const doc = { schemaVersion: 1, page: { columns: 1, rows: 1 }, objects: [card], extras: {} }

test('a note link card is a valid document object', () => {
  assert.deepEqual(validateDocument(doc), { ok: true, errors: [] })
  assert.deepEqual(validateDocument({ ...doc, objects: [{ ...card, noteRef: '' }] }).errors.map((error) => error.path), ['objects[0].noteRef'])
})

test('a card is written as a JSON Canvas link node whose url is the address, and reads back as the same card', () => {
  const canvas = toJsonCanvas(doc)
  const [node] = canvas.nodes
  assert.deepEqual([node.type, node.url, node.x, node.y, node.width, node.height], ['link', `personal-note://note/${REF}`, 40, 60, 280, 92])
  assert.equal(node.pn.noteRef, undefined)
  assert.deepEqual(validateJsonCanvas(canvas), { ok: true, errors: [] })
  assert.deepEqual(readJsonCanvas(JSON.parse(JSON.stringify(writeJsonCanvas(doc)))).objects, [card])
})

test('another app changing the address makes it an ordinary web link', () => {
  const canvas = JSON.parse(JSON.stringify(toJsonCanvas(doc)))
  canvas.nodes[0].url = 'https://example.com/'
  const [object] = readJsonCanvas(canvas).objects
  assert.notEqual(object?.type, 'notelink')
})

test('only the title is read as the words of a card', () => {
  assert.equal(plainText(doc), 'Lisbon trip')
})
