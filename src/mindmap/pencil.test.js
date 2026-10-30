import assert from 'node:assert/strict'
import test from 'node:test'

import { pencilOutline, pencilPath, seedOf, settle, strikePoints, strikeProgress } from './pencil.js'

const line = strikePoints(0, 120, 10)

test('a strike line is sampled across the label from left to right', () => {
  assert.equal(line[0].x, 0)
  assert.equal(line.at(-1).x, 120)
  assert.ok(line.every((point) => point.y === 10))
  assert.ok(line.length > 10)
})

test('the pencil line wobbles around the points and its width changes with pressure', () => {
  const { widths, outline } = pencilOutline(line, 3)
  assert.ok(Math.max(...widths) - Math.min(...widths) > 1)
  assert.ok(Math.min(...widths) > 0.5 && Math.max(...widths) < 5)
  const ys = outline.slice(0, line.length).map((point) => point.y)
  assert.ok(Math.max(...ys) - Math.min(...ys) > 1.5)
  assert.ok(Math.max(...ys) < 10 + 5 && Math.min(...ys) > 10 - 5)
})

test('the line is the same every time for the same seed, and a different hand for another', () => {
  assert.equal(pencilPath(line, seedOf('node-a0')), pencilPath(line, seedOf('node-a0')))
  assert.notEqual(pencilPath(line, seedOf('node-a0')), pencilPath(line, seedOf('node-b0')))
  assert.match(pencilPath(line, 1), /^M [-\d. ]+( L [-\d. ]+)+ Z$/)
})

test('progress is how much of the label the stroke has crossed, whichever way it went', () => {
  const row = { x0: 100, x1: 200, y: 0 }
  assert.equal(strikeProgress([{ x: 120, y: 0 }, { x: 150, y: 3 }], row), 0.3)
  assert.equal(strikeProgress([{ x: 190, y: 0 }, { x: 110, y: 0 }], row), 0.8)
  assert.equal(strikeProgress([{ x: 50, y: 0 }, { x: 400, y: 0 }], row), 1)
})

test('the settle spring starts at rest, overshoots a little and ends at 1', () => {
  assert.equal(settle(0), 0)
  assert.ok(Math.abs(settle(1) - 1) < 0.01)
  const peak = Math.max(...Array.from({ length: 101 }, (_, i) => settle(i / 100)))
  assert.ok(peak > 1.02 && peak < 1.2)
})
