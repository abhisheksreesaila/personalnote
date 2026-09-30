import assert from 'node:assert/strict'
import test from 'node:test'
import { nextPageGhost } from './edge-ghost.js'

const grid = { columns: 1, rows: 1, pageW: 860, pageH: 1080, reach: 160 }

test('an object well inside the page shows no ghost', () => {
  assert.equal(nextPageGhost({ left: 300, top: 300, right: 500, bottom: 400 }, grid), null)
})

test('an object near the right edge previews a page to the right, numbered after the existing ones', () => {
  const ghost = nextPageGhost({ left: 640, top: 300, right: 780, bottom: 400 }, grid)
  assert.deepEqual(ghost.rect, { left: 860, top: 0, width: 860, height: 1080 })
  assert.equal(ghost.pageNumber, 2)
})

test('an object near the bottom edge previews a page below', () => {
  const ghost = nextPageGhost({ left: 300, top: 900, right: 500, bottom: 1010 }, grid)
  assert.deepEqual(ghost.rect, { left: 0, top: 1080, width: 860, height: 1080 })
  assert.equal(ghost.pageNumber, 2)
})

test('an object crossing the left or top edge previews a page before the first', () => {
  const left = nextPageGhost({ left: 20, top: 300, right: 160, bottom: 400 }, grid)
  assert.deepEqual(left.rect, { left: -860, top: 0, width: 860, height: 1080 })
  const top = nextPageGhost({ left: 300, top: -30, right: 500, bottom: 100 }, grid)
  assert.deepEqual(top.rect, { left: 0, top: -1080, width: 860, height: 1080 })
})

test('in a larger grid the ghost sits in the row or column the object is in', () => {
  const big = { ...grid, columns: 2, rows: 2 }
  const ghost = nextPageGhost({ left: 1500, top: 1300, right: 1700, bottom: 1400 }, big)
  assert.deepEqual(ghost.rect, { left: 1720, top: 1080, width: 860, height: 1080 })
  assert.equal(ghost.pageNumber, 5)
})
