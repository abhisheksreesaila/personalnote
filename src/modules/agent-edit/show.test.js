import assert from 'node:assert/strict'
import test from 'node:test'
import { changedBoxes, onScreen, viewForBoxes } from './show.js'

const window1 = { width: 1000, height: 800, base: 1 }

test('the boxes are the changed objects only, with the engine-measured size when the model has none', () => {
  const objects = [
    { id: 'a', geometry: { x: 10, y: 20, width: 100, height: 50, scaleX: 2, scaleY: 1 } },
    { id: 'b', geometry: { x: 0, y: 0, width: 5, height: 5 } },
    { id: 'c', geometry: { x: 300, y: 400 } },
  ]
  assert.deepEqual(changedBoxes(objects, ['c', 'a']), [{ x: 10, y: 20, width: 200, height: 50 }, { x: 300, y: 400, width: 240, height: 64 }])
  assert.deepEqual(changedBoxes(objects, ['gone']), [])
})

test('what is further out than 100% is zoomed in to read it, and centred', () => {
  const view = viewForBoxes([{ x: 400, y: 1000, width: 200, height: 100 }], { ...window1, scale: 0.3 })
  assert.equal(view.scale, 1)
  assert.equal(500 * view.scale + view.x, 500) // the box's centre is the window's centre across
  assert.equal(1050 * view.scale + view.y, 72 + (800 - 72 - 88) / 2) // and between the island and the tools down
})

test('a box bigger than the window is zoomed out until it fits; a view already closer in stays', () => {
  const big = viewForBoxes([{ x: 0, y: 0, width: 2400, height: 1000 }], { ...window1, scale: 1 })
  assert.equal(big.scale, 0.35)
  assert.equal(viewForBoxes([{ x: 0, y: 0, width: 40000, height: 1000 }], { ...window1, scale: 1 }).scale, 0.25) // (never further out than the canvas allows)
  const closer = viewForBoxes([{ x: 0, y: 0, width: 100, height: 100 }], { ...window1, scale: 2 })
  assert.equal(closer.scale, 2)
})

test('several boxes are framed together', () => {
  const view = viewForBoxes([{ x: 0, y: 0, width: 100, height: 100 }, { x: 900, y: 0, width: 100, height: 100 }], { ...window1, scale: 1 })
  assert.equal(view.scale, 0.84)
  assert.equal(500 * view.scale + view.x, 500)
})

test('a box lands on the window where the view puts it', () => {
  assert.deepEqual(onScreen({ x: 100, y: 200, width: 50, height: 20 }, { left: 10, top: 5 }, { x: -40, y: 30, scale: 2 }), { left: 170, top: 435, width: 100, height: 40 })
})
