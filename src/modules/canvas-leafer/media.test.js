import assert from 'node:assert/strict'
import test from 'node:test'
import { createHistory } from '../../core/document/history.js'
import { MAX_MEGAPIXELS, MEDIA_PLACE_SIDE, imageStorage, readImageSize, newImage, pictureFiles, storedEncoding } from './media.js'

test('a small picture in a kept format is stored as it came; a big or animated one is re-encoded', () => {
  assert.deepEqual(imageStorage({ width: 800, height: 600, bytes: 90_000, type: 'image/png' }), { keep: true, target: { width: 800, height: 600 } })
  assert.equal(imageStorage({ width: 800, height: 600, bytes: 900_000, type: 'image/png' }).keep, false) // over the size a note should carry
  assert.equal(imageStorage({ width: 800, height: 600, bytes: 9_000, type: 'image/gif' }).keep, false) // a gif is frozen to one frame, as before
})

test('a 12-megapixel photo is shrunk to 1400 on the long side, keeping its shape', () => {
  const plan = imageStorage({ width: 4000, height: 3000, bytes: 6_000_000, type: 'image/jpeg' })
  assert.deepEqual(plan, { keep: false, target: { width: 1400, height: 1050 } })
})

test('transparency stays lossless (PNG, which every web view can write); anything else becomes a JPEG', () => {
  assert.deepEqual(storedEncoding({ hasAlpha: true }), { type: 'image/png' })
  assert.deepEqual(storedEncoding({ hasAlpha: false }), { type: 'image/jpeg', quality: 0.85 })
})

test('only picture files are taken, from a drop, a paste or the picker', () => {
  const files = [{ type: 'image/png', name: 'a' }, { type: 'application/pdf', name: 'b' }, { type: 'image/svg+xml', name: 'c' }, { type: 'image/webp', name: 'd' }]
  assert.deepEqual(pictureFiles(files).map((file) => file.name), ['a', 'd'])
})

test('a new picture is placed like the Fabric path: at most 520 on the long side, centred on the point, each further one offset', () => {
  const a = newImage({ id: 'i1', z: 4, mediaId: 'h.png', width: 1400, height: 1050, point: { x: 430, y: 540 }, index: 0 })
  assert.equal(a.type, 'image')
  assert.deepEqual(a.mediaRef, { kind: 'media', id: 'h.png' })
  const scale = MEDIA_PLACE_SIDE / 1400
  assert.equal(a.geometry.width, 1400)
  assert.ok(Math.abs(a.geometry.scaleX - scale) < 1e-9 && a.geometry.scaleX === a.geometry.scaleY)
  // the box turns and scales about its centre (schema.js), so the centre of the unscaled box is the drop point
  assert.ok(Math.abs(a.geometry.x + 1400 / 2 - 430) < 1e-6 && Math.abs(a.geometry.y + 1050 / 2 - 540) < 1e-6)
  const b = newImage({ id: 'i2', z: 5, mediaId: 'h.png', width: 1400, height: 1050, point: { x: 430, y: 540 }, index: 1 })
  assert.ok(Math.abs(b.geometry.x - a.geometry.x - 28) < 1e-6 && Math.abs(b.geometry.y - a.geometry.y - 28) < 1e-6)
  const small = newImage({ id: 'i3', z: 6, mediaId: 'h.png', width: 100, height: 50, point: { x: 100, y: 100 }, index: 0 })
  assert.equal(small.geometry.scaleX, 1) // a small picture is not enlarged
})

test('adding a picture is one undoable step that undo takes out and redo brings back, media reference intact', () => {
  const history = createHistory({ doc: { schemaVersion: 1, page: { columns: 1, rows: 1 }, objects: [], extras: {} } })
  const image = newImage({ id: 'i1', z: 0, mediaId: 'h.png', width: 10, height: 10, point: { x: 0, y: 0 }, index: 0 })
  history.record({ label: 'Add picture', changes: [{ id: 'i1', before: null, after: image }] })
  assert.deepEqual(history.doc.objects[0].mediaRef, { kind: 'media', id: 'h.png' })
  history.undo()
  assert.equal(history.doc.objects.length, 0)
  history.redo()
  assert.deepEqual(history.doc.objects[0], image)
})

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const png = (w, h) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0])
const jpeg = (w, h) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc4, 0, 3, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0])
const gif = (w, h) => Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0])
const webpX = (w, h) => Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, (w - 1) >> 16, (h - 1) & 255, ((h - 1) >> 8) & 255, (h - 1) >> 16, 0])

test('the size is read from the file header, before anything is decoded', () => {
  assert.deepEqual(readImageSize(png(4000, 3000)), { width: 4000, height: 3000 })
  assert.deepEqual(readImageSize(jpeg(5000, 4000)), { width: 5000, height: 4000 }) // past an unrelated segment
  assert.deepEqual(readImageSize(gif(320, 200)), { width: 320, height: 200 })
  assert.deepEqual(readImageSize(webpX(1234, 777)), { width: 1234, height: 777 })
  assert.equal(readImageSize(Uint8Array.from([1, 2, 3])), null)
})

test('a picture over 100 megapixels is refused up front', () => {
  assert.equal(MAX_MEGAPIXELS, 100)
  assert.equal(imageStorage({ width: 10000, height: 10001, bytes: 1, type: 'image/png' }).tooBig, true)
  assert.equal(imageStorage({ width: 4000, height: 3000, bytes: 1, type: 'image/png' }).tooBig, undefined)
})
