import assert from 'node:assert/strict'
import test from 'node:test'
import { PAGE } from '../../core/document/index.js'
import { noteRegion, pictureScale, renderNotePicture, renderSheet, sheetCells, sheetRegion } from './export.js'

test('print sheets go row by row, left to right, one per page of the grid', () => {
  assert.deepEqual(sheetCells({ columns: 2, rows: 2 }).map(({ column, row, index }) => [column, row, index]), [[0, 0, 0], [1, 0, 1], [0, 1, 2], [1, 1, 3]])
  assert.equal(sheetCells({ columns: 1, rows: 1 }).length, 1)
})

test('a sheet is exactly one page of the grid; the note picture is the whole grid', () => {
  assert.deepEqual(sheetRegion({ column: 1, row: 2 }), { x: PAGE.width, y: 2 * PAGE.height, width: PAGE.width, height: PAGE.height })
  assert.deepEqual(noteRegion({ columns: 3, rows: 2 }), { x: 0, y: 0, width: 3 * PAGE.width, height: 2 * PAGE.height })
})

test('sheets are drawn at twice the page size; a grid too big for one canvas is drawn smaller', () => {
  assert.equal(pictureScale({ columns: 1, rows: 1 }), 2)
  const big = pictureScale({ columns: 6, rows: 6 })
  assert.ok(big < 2 && 6 * PAGE.width * big * 6 * PAGE.height * big <= 16_000_001)
})

test('the scene is asked for white-paper PNG regions at those scales', async () => {
  const asked = []
  const scene = { renderRegion: async (region, options) => { asked.push([region, options]); return 'blob' } }
  assert.equal(await renderSheet(scene, { column: 1, row: 0 }), 'blob')
  assert.equal(await renderNotePicture(scene, { columns: 2, rows: 1 }), 'blob')
  assert.deepEqual(asked[0], [sheetRegion({ column: 1, row: 0 }), { pixelRatio: 2, type: 'image/png' }])
  assert.deepEqual(asked[1][0], noteRegion({ columns: 2, rows: 1 }))
})
