import assert from 'node:assert/strict'
import test from 'node:test'

import { planGridLayout, planObstacleAwareLayout } from './layout-cleanup.js'


test('orders loose text into a stable grid without overlap', () => {
  const plan = planGridLayout([
    { id: 'third', left: 390, top: 260, width: 120, height: 40 },
    { id: 'first', left: 90, top: 80, width: 150, height: 34 },
    { id: 'second', left: 430, top: 95, width: 100, height: 44 },
    { id: 'fourth', left: 70, top: 330, width: 130, height: 38 },
    { id: 'fifth', left: 510, top: 390, width: 90, height: 36 },
  ], { maxWidth: 760 })

  assert.deepEqual(plan.map(item => item.id), ['first', 'second', 'third', 'fourth', 'fifth'])
  assert.equal(plan[0].left, 70)
  assert.equal(plan[1].left, 248)
  assert.ok(plan[2].top > plan[0].top)
})

test('does nothing when there is not a meaningful layout group', () => {
  assert.deepEqual(planGridLayout([{ id: 'only', left: 10, top: 10, width: 40, height: 20 }]), [])
})

test('places text around reserved ink bounds', () => {
  const plan = planObstacleAwareLayout([
    { id: 'first', left: 90, top: 90, width: 150, height: 34 },
    { id: 'second', left: 410, top: 170, width: 130, height: 40 },
    { id: 'third', left: 520, top: 280, width: 120, height: 36 },
  ], {
    maxWidth: 760,
    maxHeight: 900,
    obstacles: [{ left: 70, top: 70, width: 570, height: 250 }],
  })

  assert.ok(plan.every(item => item.top >= 338))
  assert.deepEqual(plan.map(item => item.id), ['first', 'second', 'third'])
})