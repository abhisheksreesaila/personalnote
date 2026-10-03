import assert from 'node:assert/strict'
import test from 'node:test'
import { MIN_SCALE, planScales } from './tile-plan.js'

const MB = 1024 * 1024
const AREA = 940 * 1160 * 4 // one page's bitmap at scale 1 (a page and its bleed)
const base = { area: AREA, budget: 128 * MB }

test('the pages on screen get the device resolution when they fit', () => {
  const plan = planScales({ ...base, full: 2, strict: 2, near: 2, far: 12 })
  assert.equal(plan.scales[0], 2)
  assert.equal(plan.crisp, true)
})

test('the nearer pages are never sharper than the pages on screen, the far ones never sharper than the near ones', () => {
  const plan = planScales({ ...base, full: 2, strict: 4, near: 5, far: 7 })
  assert.ok(plan.scales[0] >= plan.scales[1] && plan.scales[1] >= plan.scales[2])
})

test('every tier together stays inside the budget', () => {
  for (const full of [0.5, 1, 2, 3, 6]) for (const strict of [1, 2, 4, 6]) {
    const counts = { strict, near: 5, far: 9 }
    const { scales } = planScales({ ...base, full, ...counts })
    const bytes = [counts.strict, counts.near, counts.far].reduce((sum, count, tier) => sum + count * AREA * scales[tier] ** 2, 0)
    // (a tier floors at MIN_SCALE, whatever the budget)
    const floor = (counts.strict + counts.near + counts.far) * AREA * MIN_SCALE ** 2
    assert.ok(bytes <= base.budget + floor, `full ${full}, ${strict} on screen: ${bytes / MB} MB`)
  }
})

test('on a 3420 x 2214 screen at 100% the pages on screen are crisp inside the budget', () => {
  // 1710 x 1107 CSS pixels at 100%: up to 3 x 2 pages on screen at dpr 2
  const plan = planScales({ ...base, full: 2, strict: 6, near: 2, far: 8 })
  assert.equal(plan.crisp, true)
  assert.ok(plan.scales[0] >= 1.5)
})

test('zoomed so far in that the pages cannot be made sharp, the bitmaps are not crisp (the vectors carry the view)', () => {
  const plan = planScales({ ...base, full: 8, strict: 1, near: 3, far: 12 })
  assert.equal(plan.crisp, false)
  assert.equal(planScales({ ...base, full: 8, strict: 4, near: 3, far: 12 }).crisp, false)
})

test('a smaller budget makes the bitmaps coarser, never above the device resolution', () => {
  const tight = planScales({ ...base, budget: 32 * MB, full: 2, strict: 4, near: 4, far: 8 })
  const roomy = planScales({ ...base, full: 2, strict: 4, near: 4, far: 8 })
  assert.ok(tight.scales[0] < roomy.scales[0])
  assert.ok(roomy.scales[0] <= 2)
})

test('with no pages in a tier the others are not held back', () => {
  const plan = planScales({ ...base, full: 1, strict: 1, near: 0, far: 0 })
  assert.deepEqual(plan.scales, [1, 1, 1])
})
