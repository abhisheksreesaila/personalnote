import test from 'node:test'
import assert from 'node:assert/strict'
import { lineLook, piecesOf, splitWords } from './markdown-layout.js'
import { parseMarkdown } from './markdown.js'

const BASE = { fontFamily: 'Literata', fontSize: 20, lineHeight: 1.5, color: '#222222' }

test('headings are bigger and bold, body lines take the text style', () => {
  const [h1, h3, body] = parseMarkdown('# A\n### B\nc').map((line) => lineLook(line, BASE))
  assert.ok(h1.fontSize > h3.fontSize && h3.fontSize > body.fontSize)
  assert.equal(h1.fontWeight, '600')
  assert.deepEqual([body.fontFamily, body.fontSize, body.lineHeight, body.color], ['Literata', 20, 30, '#222222'])
})

test('list items are indented by depth; quotes and code are set apart', () => {
  const [top, inner, quote, code] = parseMarkdown('- a\n  - b\n> c\n```\nd\n```').map((line) => lineLook(line, BASE))
  assert.ok(inner.indent > top.indent && top.indent > 0)
  assert.ok(quote.indent > 0 && quote.color !== BASE.color)
  assert.ok(/mono/i.test(lineLook(parseMarkdown('```\nd\n```')[1], BASE).fontFamily))
  assert.equal(code.kind, 'fence')
})

test('a run is cut into words with their place in the source; spaces are not words', () => {
  assert.deepEqual(splitWords('  harbour walk ', 10), [{ from: 12, to: 19 }, { from: 20, to: 24 }])
})

test('words of one run on one row are drawn as one piece, from the first word to the last', () => {
  const source = 'the **harbour walk** at dusk'
  const [line] = parseMarkdown(source)
  // as the browser laid them out: "the harbour" on row 0, "walk at dusk" on row 1
  const words = [
    { run: 0, from: 0, to: 3, x: 0, row: 0 }, { run: 1, from: 6, to: 13, x: 40, row: 0 },
    { run: 1, from: 14, to: 18, x: 0, row: 1 }, { run: 2, from: 21, to: 23, x: 50, row: 1 }, { run: 2, from: 24, to: 28, x: 75, row: 1 },
  ]
  const pieces = piecesOf(source, line, words)
  assert.deepEqual(pieces.map((piece) => [piece.text, piece.x, piece.row, Boolean(piece.style.bold)]), [
    ['the', 0, 0, false], ['harbour', 40, 0, true], ['walk', 0, 1, true], ['at dusk', 50, 1, false],
  ])
})
