import test from 'node:test'
import assert from 'node:assert/strict'
import { anchorStroke, mapMarks, placeMarks } from './text-marks.js'

// Words as the layout measured them: "The harbour walk" on one line, 20 px tall.
const SOURCE = 'The harbour walk'
// The points of an ellipse drawn around a box.
const ring = (box) => Array.from({ length: 25 }, (_, i) => ({ x: box.x + box.width / 2 + Math.cos((i / 24) * Math.PI * 2) * box.width / 2, y: box.y + box.height / 2 + Math.sin((i / 24) * Math.PI * 2) * box.height / 2 }))
const WORDS = [
  { from: 0, to: 3, x: 0, y: 0, width: 36, height: 20 },
  { from: 4, to: 11, x: 44, y: 0, width: 80, height: 20 },
  { from: 12, to: 16, x: 132, y: 0, width: 44, height: 20 },
]

test('a stroke over words anchors to those whole words, its place kept relative to the first one', () => {
  const anchor = anchorStroke({ x: 40, y: -4, width: 92, height: 28 }, WORDS, SOURCE, ring({ x: 40, y: -4, width: 92, height: 28 })) // a circle around "harbour"
  assert.deepEqual([anchor.pos, anchor.end, anchor.quote.exact, anchor.dx, anchor.dy], [4, 11, 'harbour', -4, -4])
})

test('an underline just below a word still belongs to it', () => {
  const anchor = anchorStroke({ x: 46, y: 21, width: 76, height: 3 }, WORDS, SOURCE, [{ x: 46, y: 22 }, { x: 80, y: 23 }, { x: 122, y: 22 }])
  assert.equal(anchor?.quote.exact, 'harbour')
})

test('a hand-drawn underline a little lower (half a line under the word) still belongs to it', () => {
  const anchor = anchorStroke({ x: 46, y: 29, width: 76, height: 2 }, WORDS, SOURCE, [{ x: 46, y: 29 }, { x: 70, y: 31 }, { x: 96, y: 29 }, { x: 122, y: 30 }])
  assert.equal(anchor?.quote.exact, 'harbour')
})

test('handwriting a line below the words stays ink', () => {
  const scrawl = Array.from({ length: 12 }, (_, i) => ({ x: 10 + i * 14, y: 42 + (i % 2) * 14 })) // a word written one line-height under the text
  assert.equal(anchorStroke({ x: 10, y: 42, width: 154, height: 14 }, WORDS, SOURCE, scrawl), null)
})

test('a stroke away from every word is not a mark', () => {
  assert.equal(anchorStroke({ x: 20, y: 80, width: 40, height: 30 }, WORDS, SOURCE, [{ x: 20, y: 80 }, { x: 60, y: 110 }]), null)
})

test('marks follow their words through typing before them and inside them', () => {
  const marks = [{ id: 'm', anchor: { pos: 4, end: 11, quote: { exact: 'harbour' }, dx: -4, dy: -4 } }]
  const [moved] = mapMarks(marks, SOURCE, 'The old harbours walk')
  assert.deepEqual([moved.anchor.pos, moved.anchor.end, moved.anchor.quote.exact], [8, 16, 'harbours'])
})

test('deleting all of a word deletes its mark', () => {
  const marks = [{ id: 'm', anchor: { pos: 4, end: 11, quote: { exact: 'harbour' } } }]
  assert.deepEqual(mapMarks(marks, SOURCE, 'The walk'), [])
})

test('a mark is drawn at its first word, wherever the layout put it now', () => {
  const marks = [{ id: 'm', anchor: { pos: 4, end: 11, quote: { exact: 'harbour' }, dx: -4, dy: -4 } }]
  const wrapped = [WORDS[0], { ...WORDS[1], x: 0, y: 30 }, WORDS[2]]
  assert.deepEqual(placeMarks(marks, wrapped).map((mark) => [mark.x, mark.y]), [[-4, 26]])
})

test('a circle that grazes the lines above and below still marks only the words it encloses', () => {
  const lines = [{ from: 20, to: 26, x: 0, y: -30, width: 60, height: 20 }, ...WORDS, { from: 30, to: 35, x: 0, y: 30, width: 50, height: 20 }]
  const anchor = anchorStroke({ x: 36, y: -10, width: 96, height: 40 }, lines, `${SOURCE}`.padEnd(40, ' '), ring({ x: 36, y: -10, width: 96, height: 40 }))
  assert.equal(anchor.quote.exact, 'harbour')
})

test('a big stroke across the text (an arrow, a diagonal, a sketch) stays ink, even when its box covers the words', () => {
  const diagonal = Array.from({ length: 20 }, (_, i) => ({ x: -300 + i * 60, y: -200 + i * 40 }))
  assert.equal(anchorStroke({ x: -300, y: -200, width: 1140, height: 760 }, WORDS, SOURCE, diagonal), null)
  assert.equal(anchorStroke({ x: -300, y: -200, width: 800, height: 600 }, WORDS, SOURCE, ring({ x: -300, y: -200, width: 800, height: 600 })), null)
})

test('a highlight dragged along a line marks every word it runs over', () => {
  const anchor = anchorStroke({ x: 0, y: 8, width: 176, height: 4 }, WORDS, SOURCE, [{ x: 0, y: 10 }, { x: 90, y: 10 }, { x: 176, y: 10 }])
  assert.equal(anchor.quote.exact, 'The harbour walk')
})
