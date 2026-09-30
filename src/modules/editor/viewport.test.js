import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampView,
  lerpExtents,
  pageExtents,
  shiftExtents,
  viewMargins,
  zoomAtPoint,
} from './viewport.js'

const desktop = { viewW: 1400, viewH: 900, margins: viewMargins(1400) }

test('a page narrower than the window is centred and cannot be panned sideways', () => {
  const view = clampView({ x: -500, y: 92 }, { ...desktop, contentW: 860, contentH: 1080, scale: 1 })
  assert.equal(view.x, (1400 - 860) / 2)
})

test('a tall grid can be panned from its top margin to its bottom margin and no further', () => {
  const size = { ...desktop, contentW: 860, contentH: 4320, scale: 1 }
  assert.equal(clampView({ x: 0, y: 500 }, size).y, 92)
  assert.equal(clampView({ x: 0, y: -99999 }, size).y, 900 - 180 - 4320)
})

test('a short grid stays pinned to the top margin', () => {
  const view = clampView({ x: 0, y: -40 }, { ...desktop, viewH: 1400, contentW: 860, contentH: 1080, scale: 1 })
  assert.equal(view.y, 92)
})

test('a wide grid pans within side margins', () => {
  const size = { ...desktop, contentW: 2580, contentH: 1080, scale: 1 }
  assert.equal(clampView({ x: 900, y: 92 }, size).x, 140)
  assert.equal(clampView({ x: -9999, y: 92 }, size).x, 1400 - 140 - 2580)
})

test('zooming keeps the world point under the cursor fixed', () => {
  const view = { x: 120, y: 60, scale: 1 }
  const point = { x: 400, y: 300 }
  const world = { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale }
  const next = zoomAtPoint(view, 2.5, point)
  assert.equal((point.x - next.x) / 2.5, world.x)
  assert.equal((point.y - next.y) / 2.5, world.y)
})

test('page growth changes extents by whole pages only', () => {
  assert.deepEqual(pageExtents(3, 4, 860, 1080), { left: 0, top: 0, right: 2580, bottom: 4320 })
})

test('prepending a page shifts the old extents by exactly that page', () => {
  const old = pageExtents(1, 1, 860, 1080)
  assert.deepEqual(shiftExtents(old, 860, 0), { left: 860, top: 0, right: 1720, bottom: 1080 })
})

test('extent animation interpolates both edges and lands exactly on the target', () => {
  const from = { left: 860, top: 0, right: 1720, bottom: 1080 }
  const to = pageExtents(2, 1, 860, 1080)
  assert.deepEqual(lerpExtents(from, to, 0), from)
  assert.deepEqual(lerpExtents(from, to, 1), to)
  assert.equal(lerpExtents(from, to, 0.5).left, 430)
})
