import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeDiagramStroke, diagramGuidePath } from './diagram-assist.js'


function ellipsePoints(centerX, centerY, radiusX, radiusY, count = 48) {
  return Array.from({ length: count + 1 }, (_, index) => {
    const angle = Math.PI * 2 * index / count
    return { x: centerX + Math.cos(angle) * radiusX, y: centerY + Math.sin(angle) * radiusY }
  })
}

test('recognizes a rough closed box and generates a soft guide', () => {
  const points = [
    { x: 10, y: 12 }, { x: 55, y: 9 }, { x: 112, y: 13 },
    { x: 110, y: 48 }, { x: 108, y: 82 }, { x: 54, y: 80 },
    { x: 8, y: 84 }, { x: 11, y: 48 }, { x: 10, y: 12 },
  ]
  const result = analyzeDiagramStroke(points)

  assert.equal(result.kind, 'rounded-box')
  assert.match(diagramGuidePath(result), /^M .+ C .+ Z$/)
})

test('recognizes an ellipse and an open connector', () => {
  assert.equal(analyzeDiagramStroke(ellipsePoints(80, 70, 52, 38)).kind, 'ellipse')

  const connector = analyzeDiagramStroke([
    { x: 10, y: 20 }, { x: 35, y: 21 }, { x: 62, y: 22 },
    { x: 90, y: 23 }, { x: 120, y: 24 },
  ])
  assert.equal(connector.kind, 'connector')
  assert.match(diagramGuidePath(connector), /^M .+ Q .+$/)
})

test('recognizes an arrow without turning a plain connector into one', () => {
  const arrow = analyzeDiagramStroke([
    { x: 10, y: 50 }, { x: 38, y: 49 }, { x: 68, y: 50 },
    { x: 100, y: 50 }, { x: 82, y: 38 }, { x: 100, y: 50 },
    { x: 82, y: 62 },
  ])
  assert.equal(arrow.kind, 'arrow')
  assert.match(diagramGuidePath(arrow), /^M .+ Q .+ M .+ L .+ L .+$/)

  const connector = analyzeDiagramStroke([
    { x: 10, y: 20 }, { x: 40, y: 20 }, { x: 75, y: 21 }, { x: 110, y: 22 }, { x: 140, y: 22 },
  ])
  assert.equal(connector.kind, 'connector')
})

test('stays quiet for a small scribble', () => {
  const scribble = [
    { x: 10, y: 10 }, { x: 20, y: 18 }, { x: 12, y: 22 },
    { x: 22, y: 11 }, { x: 14, y: 15 },
  ]
  assert.equal(analyzeDiagramStroke(scribble), null)
})