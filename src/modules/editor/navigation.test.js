import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fitView,
  pageLabel,
  scrollThumbs,
  stepZoom,
  viewForPage,
  visiblePages,
  zoomPercent,
} from './navigation.js'

const page = { pageW: 860, pageH: 1080 }

test('the page summary reads "N pages · C × R" and singularises one page', () => {
  assert.equal(pageLabel(3, 1), '3 pages · 3 × 1')
  assert.equal(pageLabel(1, 1), '1 page · 1 × 1')
  assert.equal(pageLabel(2, 3), '6 pages · 2 × 3')
})

test('zoom shows the real scale as a whole percentage', () => {
  assert.equal(zoomPercent(1), 100)
  assert.equal(zoomPercent(0.564), 56)
})

test('zoom steps multiply by a fixed ratio and stop at the limits', () => {
  assert.ok(Math.abs(stepZoom(1, 1, { min: 0.25, max: 4 }) - 1.25) < 1e-9)
  assert.ok(Math.abs(stepZoom(1, -1, { min: 0.25, max: 4 }) - 0.8) < 1e-9)
  assert.equal(stepZoom(3.9, 1, { min: 0.25, max: 4 }), 4)
  assert.equal(stepZoom(0.26, -1, { min: 0.25, max: 4 }), 0.25)
})

test('fit scales the whole grid into the free area and centres it there', () => {
  const view = fitView({
    viewW: 1200, viewH: 800, contentW: 1720, contentH: 1080,
    margins: { left: 20, right: 20, top: 80, bottom: 100 }, min: 0.25, max: 1,
  })
  const scale = Math.min(1160 / 1720, 620 / 1080)
  assert.ok(Math.abs(view.scale - scale) < 1e-9)
  assert.ok(Math.abs(view.x - (1200 - 1720 * scale) / 2) < 1e-9)
  assert.ok(Math.abs(view.y - (80 + (620 - 1080 * scale) / 2)) < 1e-9)
})

test('fit never zooms in past the maximum', () => {
  const view = fitView({
    viewW: 3000, viewH: 3000, contentW: 860, contentH: 1080,
    margins: { left: 0, right: 0, top: 0, bottom: 0 }, min: 0.25, max: 1,
  })
  assert.equal(view.scale, 1)
})

test('visiblePages lists the pages that intersect the window, row by row', () => {
  const visible = visiblePages({
    view: { x: 0, y: 0, scale: 1 }, viewW: 900, viewH: 700, columns: 3, rows: 2, ...page,
  })
  assert.deepEqual([...visible].sort(), [0, 1])
  const scrolled = visiblePages({
    view: { x: -860, y: -1000, scale: 1 }, viewW: 900, viewH: 700, columns: 3, rows: 2, ...page,
  })
  assert.deepEqual([...scrolled].sort(), [1, 2, 4, 5])
})

test('viewForPage centres a page in the window at the current scale', () => {
  const view = viewForPage({ column: 1, row: 0, scale: 0.5, viewW: 1000, viewH: 800, ...page })
  assert.equal(view.x, 500 - 860 * 1.5 * 0.5)
  assert.equal(view.y, 400 - 1080 * 0.5 * 0.5)
})

test('scroll thumbs describe the visible share of the pannable range', () => {
  const margins = { left: 140, right: 140, top: 92, bottom: 180 }
  const thumbs = scrollThumbs({
    view: { x: 170, y: 92, scale: 1 }, viewW: 1200, viewH: 800, contentW: 860, contentH: 4320, margins,
  })
  assert.equal(thumbs.x, null)
  assert.equal(thumbs.y.start, 0)
  assert.ok(thumbs.y.length > 0.1 && thumbs.y.length < 0.25)
  const end = scrollThumbs({
    view: { x: 170, y: 800 - 180 - 4320, scale: 1 }, viewW: 1200, viewH: 800, contentW: 860, contentH: 4320, margins,
  })
  assert.ok(Math.abs(end.y.start + end.y.length - 1) < 1e-9)
})
