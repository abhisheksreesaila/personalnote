import assert from 'node:assert/strict'
import test from 'node:test'

import { layoutNode, wrapText } from './layout.js'

// A measuring stand-in: every character is 0.5 of the font size wide.
const measure = (text, font) => text.length * Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]) * 0.5
const node = (extra) => ({ id: 'n', parentId: 'r', text: 'Call the bank', fontSize: 20, font: 'hand', ...extra })

test('a short label stays on one line and the box is the measured text plus padding', () => {
  const box = layoutNode(node(), measure)
  assert.deepEqual(box.lines, ['Call the bank'])
  assert.equal(box.width, 13 * 10 + 26)
  assert.equal(box.height, 40)
})

test('a bigger font makes a bigger box', () => {
  assert.equal(layoutNode(node({ fontSize: 20 }), measure).width, 13 * 10 + 26)
  assert.equal(layoutNode(node({ fontSize: 32 }), measure).width, 13 * 16 + 26)
})

test('a long label wraps at word breaks, 28 characters at most per line, and the box grows taller', () => {
  const text = 'Renew the passport and then book the flights for the family trip'
  const box = layoutNode(node({ text }), measure)
  assert.deepEqual(box.lines, ['Renew the passport and then', 'book the flights for the', 'family trip'])
  assert.equal(box.height, 40 + 2 * 24)
  assert.equal(box.width, 'Renew the passport and then'.length * 10 + 26)
})

test('a word longer than a line is cut rather than left to overflow', () => {
  assert.deepEqual(wrapText('x'.repeat(30)), ['x'.repeat(28), 'xx'])
})

test('the root keeps its minimum size and grows with wrapped text', () => {
  const root = layoutNode(node({ parentId: null, text: 'Plan', fontSize: 28 }), measure)
  assert.equal(root.width, 180)
  assert.equal(root.height, 76)
  const long = layoutNode(node({ parentId: null, text: 'Week plan for the move to the new apartment', fontSize: 28 }), measure)
  assert.deepEqual(long.lines, ['Week plan for the move to', 'the new apartment'])
  assert.equal(long.height, 76 + 34)
})

test('a branch label is measured in capitals, as it is drawn', () => {
  const wide = (text) => text.length + (text === text.toUpperCase() ? 100 : 0)
  assert.equal(layoutNode(node({ presentation: 'branch' }), wide).width, 13 + 100 + 26)
})
