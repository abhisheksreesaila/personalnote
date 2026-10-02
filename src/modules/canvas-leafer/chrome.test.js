import assert from 'node:assert/strict'
import test from 'node:test'
import { pageChrome } from './chrome.js'

const colors = { paper: '#fbfaf5', label: '#6e6e78', radius: 6, edge: '#2c2c34', shadows: [{ x: 0, y: 8, blur: 24, spread: 0, rgb: 'rgb(0, 0, 0)', peak: 0.2 }] }
const base = { viewW: 1440, viewH: 900, pageW: 860, pageH: 1080, colors }

test('one page: the paper sits at the view offset, scaled, inside a one-pixel edge', () => {
  const plan = pageChrome({ ...base, view: { x: 100, y: 50, scale: 0.5 }, columns: 1, rows: 1 })
  assert.deepEqual(plan.paper, { x: 100, y: 50, width: 430, height: 540, radius: 6, fill: '#fbfaf5' })
  assert.deepEqual([plan.edge.x, plan.edge.y, plan.edge.width, plan.edge.height, plan.edge.radius], [99, 49, 432, 542, 7])
  assert.deepEqual(plan.folds, [])
  assert.equal(plan.shadows.length, 32)
  assert.ok(plan.shadows.every((band) => band.y > 50 - 40 && band.alpha >= 0 && band.alpha <= 0.2))
})

test('fold lines run between pages, at page boundaries, over the whole grid', () => {
  const plan = pageChrome({ ...base, view: { x: 0, y: 0, scale: 1 }, columns: 3, rows: 2 })
  assert.deepEqual(plan.folds, [
    { x1: 860, y1: 0, x2: 860, y2: 2160 },
    { x1: 1720, y1: 0, x2: 1720, y2: 2160 },
    { x1: 0, y1: 1080, x2: 2580, y2: 1080 },
  ])
})

test('labels: bottom-row pages are labelled under the page, upper rows inside their lower corner, off-screen ones are left out', () => {
  const plan = pageChrome({ ...base, viewH: 2400, view: { x: 0, y: 0, scale: 1 }, columns: 2, rows: 2 })
  const byText = Object.fromEntries(plan.labels.map((label) => [label.text, label]))
  assert.deepEqual(byText['Page 1'], { text: 'Page 1', x: 14, y: 1080 - 26 })
  assert.deepEqual(byText['Page 4'], { text: 'Page 4', x: 860, y: 2160 + 11 })
  const scrolled = pageChrome({ ...base, view: { x: -2000, y: 0, scale: 1 }, columns: 2, rows: 2 })
  assert.equal(scrolled.labels.length, 0)
})

test('an empty grid draws nothing', () => {
  const plan = pageChrome({ ...base, view: { x: 0, y: 0, scale: 1 }, columns: 0, rows: 0 })
  assert.equal(plan.paper, null)
})

test('while dictation is on the pages are outlined in the accent colour, 3 px outside the edge; otherwise there is no outline', () => {
  const base = { view: { x: 100, y: 50, scale: 0.5 }, viewW: 1000, viewH: 800, columns: 1, rows: 1, pageW: 860, pageH: 1080, colors: { ...colors, accent: '#4D839C' } }
  assert.equal(pageChrome(base).outline, null)
  const { outline } = pageChrome({ ...base, listening: true })
  assert.deepEqual([outline.x, outline.y, outline.width, outline.height, outline.stroke], [97, 47, 436, 546, '#4D839C'])
})
