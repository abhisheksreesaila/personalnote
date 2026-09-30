import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fitView,
  objectsInView,
  chooseOpeningView,
  openingView,
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

const desk = { viewW: 1212, viewH: 900, margins: { left: 140, right: 140, top: 92, bottom: 180 } }

test('opening a one-page note shows the whole page zoomed out, centred on the desk', () => {
  const view = openingView({ ...desk, contentW: 860, contentH: 1080, min: 0.4, max: 1 })
  assert.ok(view.scale < 0.7 && view.scale > 0.5, `scale ${view.scale}`)
  assert.ok(Math.abs(view.x - (1212 - 860 * view.scale) / 2) < 1e-9)
  assert.ok(view.y >= desk.margins.top)
})

test('opening a two-page note fits both pages side by side', () => {
  const view = openingView({ ...desk, contentW: 1720, contentH: 1080, min: 0.4, max: 1 })
  assert.ok(view.scale >= 0.5 && view.scale <= 0.56, `scale ${view.scale}`)
  assert.ok(view.x >= desk.margins.left - 1e-9)
})

test('a tiny note is never magnified past the maximum', () => {
  const view = openingView({ viewW: 4000, viewH: 3000, margins: { left: 0, right: 0, top: 0, bottom: 0 }, contentW: 860, contentH: 1080, min: 0.4, max: 1 })
  assert.equal(view.scale, 1)
})

test('a huge page grid stops at the floor and starts at the first page instead of shrinking to dots', () => {
  const view = openingView({ ...desk, contentW: 860 * 8, contentH: 1080 * 4, min: 0.4, max: 1 })
  assert.equal(view.scale, 0.4)
  assert.equal(view.x, desk.margins.left)
  assert.equal(view.y, desk.margins.top)
})

const box = (left, top) => ({ left, top, width: 100, height: 100 })

test('objects in view are counted by whether their box touches the window', () => {
  const view = { x: 0, y: 0, scale: 0.5 }
  const boxes = [box(0, 0), box(1000, 100), box(3000, 100), box(100, 3000)]
  assert.equal(objectsInView(view, 1212, 900, boxes), 2)
})

test('a light note keeps the zoomed-out opening view', () => {
  const far = { x: 0, y: 0, scale: 0.4 }
  const near = { x: 0, y: 0, scale: 1 }
  const boxes = Array.from({ length: 20 }, (_, i) => box(i * 50, 10))
  assert.equal(chooseOpeningView([far, near], 1212, 900, boxes, 150), far)
})

test('a dense note opens at the first candidate that keeps the visible object count under the limit', () => {
  const all = { x: 0, y: 0, scale: 0.4 }
  const page = { x: 0, y: 0, scale: 0.56 }
  const actual = { x: 0, y: 0, scale: 1 }
  const boxes = Array.from({ length: 400 }, (_, i) => box((i % 40) * 60, Math.floor(i / 40) * 200))
  assert.ok(objectsInView(all, 1212, 900, boxes) > 150)
  assert.equal(chooseOpeningView([all, page, actual], 1212, 900, boxes, 150), actual)
  assert.equal(chooseOpeningView([all, page, actual], 1212, 900, boxes, 10000), all)
})

test('the average load while panning counts too, not only what is on screen at the start', () => {
  const page = { x: 0, y: 0, scale: 0.56 }
  const actual = { x: 0, y: 0, scale: 1 }
  // 300 objects spread over a 3 x 4 grid, but the ones near the start happen to be few.
  const boxes = Array.from({ length: 300 }, (_, i) => box(1000 + (i % 30) * 70, 2000 + Math.floor(i / 30) * 200))
  const content = { width: 2580, height: 4320 }
  assert.equal(chooseOpeningView([page, actual], 1212, 900, boxes, 50, content), actual)
  assert.equal(chooseOpeningView([page, actual], 1212, 900, boxes, 50), page)
})
