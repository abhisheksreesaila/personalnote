import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampView,
  moveWithCentre,
  parseBoxShadow,
  pageExtents,
  shadowBands,
  shiftExtents,
  viewMargins,
  zoomAtPoint,
} from './viewport.js'

const desktop = { viewW: 1400, viewH: 900, margins: viewMargins(1400) }

test('a page narrower than the window stays between the margins; wherever it sits inside them it is left alone (no re-centring)', () => {
  const size = { ...desktop, contentW: 860, contentH: 1080, scale: 1 }
  assert.equal(clampView({ x: 300, y: 104 }, size).x, 300)
  assert.equal(clampView({ x: 252.5, y: 104 }, size).x, 252.5)
  assert.equal(clampView({ x: -500, y: 92 }, size).x, 140)
  assert.equal(clampView({ x: 9000, y: 92 }, size).x, 1400 - 140 - 860)
})

test('a view that pages added on the top or left left outside the range stays put, may move back toward it, and never further out', () => {
  const size = { ...desktop, contentW: 1720, contentH: 1080, scale: 0.5, previous: { x: -83, y: 104 } }
  assert.equal(clampView({ x: -83, y: 104 }, size).x, -83)
  assert.equal(clampView({ x: -82, y: 104 }, size).x, -82)
  assert.equal(clampView({ x: -90, y: 104 }, size).x, -83)
  assert.equal(clampView({ x: 9000, y: 104 }, size).x, 1400 - 140 - 860)
})

test('a tall grid can be panned from its top margin to its bottom margin and no further', () => {
  const size = { ...desktop, contentW: 860, contentH: 4320, scale: 1 }
  assert.equal(clampView({ x: 0, y: 500 }, size).y, 104)
  assert.equal(clampView({ x: 0, y: -99999 }, size).y, 900 - 180 - 4320)
})

test('a short grid stays pinned to the top margin', () => {
  const view = clampView({ x: 0, y: -40 }, { ...desktop, viewH: 1400, contentW: 860, contentH: 1080, scale: 1 })
  assert.equal(view.y, 104)
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

test('a CSS box-shadow token is parsed into canvas shadow layers', () => {
  assert.deepEqual(
    parseBoxShadow('0 1px 2px rgba(0, 0, 30, .05), 0 16px 40px -16px rgba(0, 0, 60, .22)'),
    [
      { x: 0, y: 1, blur: 2, spread: 0, color: 'rgba(0, 0, 30, .05)' },
      { x: 0, y: 16, blur: 40, spread: -16, color: 'rgba(0, 0, 60, .22)' },
    ],
  )
  assert.deepEqual(parseBoxShadow('none'), [])
  assert.deepEqual(parseBoxShadow(''), [])
})

test('keeping the view leaves it where growth compensation put it', () => {
  const view = clampView({ x: -597, y: 92 }, { ...desktop, contentW: 1720, contentH: 1080, scale: 1, keep: true })
  assert.deepEqual(view, { x: -597, y: 92 })
})

test('shadow bands stack from the outside in and reach the full shadow strength', () => {
  const bands = shadowBands({ blur: 40, spread: -16, alpha: 0.22 })
  for (let i = 1; i < bands.length; i += 1) assert.ok(bands[i].grow < bands[i - 1].grow)
  const composite = 1 - bands.reduce((rest, band) => rest * (1 - band.alpha), 1)
  assert.ok(Math.abs(composite - 0.22) < 0.01, `composite ${composite}`)
  assert.ok(bands.every((band) => band.alpha >= 0 && band.alpha <= 0.22))
})

test('an unblurred shadow is one solid band', () => {
  assert.deepEqual(shadowBands({ blur: 0, spread: 2, alpha: 0.5 }), [{ grow: 2, alpha: 0.5 }])
})

test('when the note area opens a 296px panel on its left, the page stays centred in what is left of it', () => {
  // a 1280px area with the page at x=210 (860 wide, centred); the area becomes 984px wide
  const next = moveWithCentre({ x: 210, y: 40, scale: 1 }, { width: 1280, height: 800 }, { width: 984, height: 800 })
  assert.deepEqual(next, { x: 62, y: 40, scale: 1, owed: 0 })
  assert.equal(62 + 860 + 62, 984)
})

test('closing the panel puts the view back exactly where it was', () => {
  const open = moveWithCentre({ x: 210, y: 40, scale: 1 }, { width: 1280, height: 800 }, { width: 984, height: 800 })
  assert.deepEqual(moveWithCentre(open, { width: 984, height: 800 }, { width: 1280, height: 800 }, undefined, open.owed), { x: 210, y: 40, scale: 1, owed: 0 })
})

test('with the panel open the page gives way to the tool island rather than slide under it, and closing gives it back', () => {
  // centred it would end at 922px; the island strip starts at 984 - 80 = 904
  const page = { right: 860, clear: 80 }
  const open = moveWithCentre({ x: 210, y: 40, scale: 1 }, { width: 1280, height: 800 }, { width: 984, height: 800 }, page)
  assert.deepEqual(open, { x: 44, y: 40, scale: 1, owed: 18 })
  assert.deepEqual(moveWithCentre(open, { width: 984, height: 800 }, { width: 1280, height: 800 }, page, open.owed), { x: 210, y: 40, scale: 1, owed: 0 })
})

test('a page already clear of the island, or scrolled off to the left, is not moved by it', () => {
  const page = { right: 860, clear: 80 }
  assert.equal(moveWithCentre({ x: 100, y: 0, scale: 1 }, { width: 1440, height: 800 }, { width: 1144, height: 800 }, page).x, -48)
  assert.equal(moveWithCentre({ x: 40, y: 0, scale: 1 }, { width: 1280, height: 800 }, { width: 984, height: 800 }, page).x, -108)
})
