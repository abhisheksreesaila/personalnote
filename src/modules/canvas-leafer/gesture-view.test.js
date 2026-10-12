import assert from 'node:assert/strict'
import test from 'node:test'
import { covers, createGestureView, drawGap, mapPoint, marginFor, transformFor } from './gesture-view.js'

const SIZE = { width: 1000, height: 800 }

test('the margin is a fraction of the window and stays inside the pixel budget', () => {
  assert.equal(marginFor(SIZE, { fraction: 0.25 }), 200)
  assert.equal(marginFor(SIZE, { fraction: 0 }), 0)
  const margin = marginFor({ width: 1440, height: 900 }, { fraction: 0.5, pixelRatio: 2, budget: 16e6 })
  assert.ok(margin > 0 && margin < 450)
  assert.ok(2 * (1440 + 2 * margin) * (900 + 2 * margin) * 4 <= 16e6)
})

test('a pan moves the canvas by the pan, a zoom scales it about the zoom point (the matrix the draw will have)', () => {
  const rendered = { x: 100, y: 50, scale: 1 }
  assert.deepEqual(transformFor(rendered, rendered, 200), { k: 1, tx: 0, ty: 0 })
  assert.deepEqual(transformFor(rendered, { x: 130, y: 20, scale: 1 }, 200), { k: 1, tx: 30, ty: -30 })
  // any point of the picture lands where the new view puts the same page point
  const view = { x: 40, y: -10, scale: 1.5 }
  const margin = 120
  const t = transformFor(rendered, view, margin)
  for (const page of [{ x: 0, y: 0 }, { x: 300, y: 210 }]) {
    const onCanvas = { x: margin + rendered.x + rendered.scale * page.x, y: margin + rendered.y + rendered.scale * page.y }
    const shown = mapPoint(t, margin, onCanvas)
    assert.ok(Math.abs(shown.x - (view.x + view.scale * page.x)) < 1e-9)
    assert.ok(Math.abs(shown.y - (view.y + view.scale * page.y)) < 1e-9)
  }
})

test('the moved canvas covers the window until the pan outruns the margin', () => {
  assert.equal(covers({ k: 1, tx: 150, ty: 0 }, SIZE, 200), true)
  assert.equal(covers({ k: 1, tx: 199, ty: 0 }, SIZE, 200), false) // inside the slack: draw before an edge shows
  assert.equal(covers({ k: 1, tx: -260, ty: 0 }, SIZE, 200), false)
  assert.equal(covers({ k: 0.9, tx: 60, ty: 40 }, SIZE, 200), true)
  assert.equal(covers({ k: 0.55, tx: 0, ty: 0 }, SIZE, 200), false)
})

function rig({ margin = 200, drawMs = 5 } = {}) {
  const el = { style: {} }
  const log = []
  let timer = null
  let clock = 1000
  const gesture = createGestureView({
    elements: () => [el], size: () => SIZE, margin: () => margin, quiet: 120,
    commit: (view) => { log.push({ ...view, transformAtDraw: el.style.transform }); clock += drawMs },
    schedule: (fn) => { timer = fn; return 1 }, cancel: () => { timer = null }, now: () => clock,
  })
  return { el, log, gesture, fire: () => { const fn = timer; timer = null; fn?.() }, wait: (ms) => { clock += ms } }
}

test('the first view is drawn at once; later steps only move the canvas, and one draw follows when they stop', () => {
  const { el, log, gesture, fire } = rig()
  gesture.setView({ x: 0, y: 0, scale: 1 })
  assert.equal(log.length, 1)
  gesture.setView({ x: 20, y: 5, scale: 1 })
  gesture.setView({ x: 60, y: 9, scale: 1 })
  assert.equal(log.length, 1)
  assert.equal(el.style.transform, 'translate(60px, 9px) scale(1)')
  assert.equal(gesture.pending, true)
  fire()
  assert.equal(log.length, 2)
  assert.deepEqual({ x: log[1].x, y: log[1].y, scale: log[1].scale }, { x: 60, y: 9, scale: 1 })
  assert.equal(el.style.transform, '') // the transform comes off in the same task as the draw
  assert.equal(gesture.pending, false)
})

test('a pan past the margin, or a zoom too far, draws again at once and goes on from there', () => {
  const { el, log, gesture, wait } = rig()
  gesture.setView({ x: 0, y: 0, scale: 1 })
  wait(200)
  gesture.setView({ x: -250, y: 0, scale: 1 })
  assert.equal(log.length, 2)
  assert.equal(el.style.transform, '')
  gesture.setView({ x: -300, y: 0, scale: 1 }) // 50 further: a move again, from the new picture
  assert.equal(log.length, 2)
  assert.equal(el.style.transform, 'translate(-50px, 0px) scale(1)')
  wait(200)
  gesture.setView({ x: -300, y: 0, scale: 3 })
  assert.equal(log.length, 3)
})

test('draws come no faster than a slow draw allows: in between, the canvas goes on moving (even past its edge)', () => {
  assert.equal(drawGap(5), 120)
  assert.equal(drawGap(300), 900)
  assert.equal(drawGap(5000), 1000)
  const { el, log, gesture, wait } = rig({ drawMs: 400 }) // a draw takes 400 ms here
  gesture.setView({ x: 0, y: 0, scale: 1 })
  wait(50)
  gesture.setView({ x: -250, y: 0, scale: 1 }) // past the margin, but the last draw ended 50 ms ago: held
  assert.equal(log.length, 1)
  assert.equal(el.style.transform, 'translate(-250px, 0px) scale(1)')
  wait(1200)
  gesture.setView({ x: -260, y: 0, scale: 1 }) // the gap (1.2 s) has passed
  assert.equal(log.length, 2)
})

test('settle draws only when something moved; redraw draws regardless', () => {
  const { log, gesture } = rig()
  gesture.setView({ x: 0, y: 0, scale: 1 })
  assert.equal(gesture.settle(), false)
  gesture.redraw()
  assert.equal(log.length, 2)
})
