import assert from 'node:assert/strict'
import test from 'node:test'
import { createLiftEffect, liftAmount } from './lift.js'

function fakeContext() {
  const calls = []
  return {
    calls,
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: (...a) => calls.push(['translate', ...a]),
    rotate: (angle) => calls.push(['rotate', angle]),
    set shadowColor(v) { calls.push(['shadowColor', v]) },
    set shadowBlur(v) { calls.push(['shadowBlur', v]) },
    set shadowOffsetY(v) { calls.push(['shadowOffsetY', v]) },
  }
}

class FakeObject {
  angle = 0
  drawn = 0
  getCenterPoint() { return { x: 100, y: 50 } }
  render(ctx) { this.drawn += 1; this.lastCtx = ctx }
}
const fakeObject = () => new FakeObject()

test('liftAmount eases from 0 to 1 and back', () => {
  assert.equal(liftAmount(0), 0)
  assert.equal(liftAmount(1), 1)
  assert.ok(liftAmount(0.5) > 0.4 && liftAmount(0.5) < 0.6)
})

test('a lifted object draws tilted with a shadow, but its saved angle never changes', () => {
  const frames = []
  const effect = createLiftEffect({ requestRender: () => frames.push('render'), reducedMotion: () => true, pixelRatio: () => 2 })
  const object = fakeObject()
  effect.begin(object)
  const ctx = fakeContext()
  object.render(ctx)
  assert.equal(object.drawn, 1)
  assert.equal(object.angle, 0)
  assert.ok(ctx.calls.some(([name, value]) => name === 'rotate' && value > 0))
  assert.ok(ctx.calls.some(([name, value]) => name === 'shadowBlur' && value > 0))
  assert.equal(ctx.calls.filter(([n]) => n === 'save').length, ctx.calls.filter(([n]) => n === 'restore').length)
})

test('ending the lift restores the original draw and removes the override', () => {
  const effect = createLiftEffect({ requestRender: () => {}, reducedMotion: () => true, pixelRatio: () => 1 })
  const object = fakeObject()
  effect.begin(object)
  assert.ok(Object.prototype.hasOwnProperty.call(object, 'render'))
  effect.end()
  assert.equal(Object.prototype.hasOwnProperty.call(object, 'render'), false)
  assert.equal(effect.active(), false)
})

test('beginning again on the same object does not stack overrides', () => {
  const effect = createLiftEffect({ requestRender: () => {}, reducedMotion: () => true, pixelRatio: () => 1 })
  const object = fakeObject()
  effect.begin(object)
  effect.begin(object)
  effect.end()
  object.render(fakeContext())
  assert.equal(object.drawn, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(object, 'render'), false)
})
