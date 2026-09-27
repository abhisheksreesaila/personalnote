import test from 'node:test'
import assert from 'node:assert/strict'
import { prettifySelection, prettifyText } from './prettify.js'

test('prettify normalizes whitespace, paragraph breaks, headings, and common bullets deterministically', () => {
  const source = 'Project   \n\n\n- first  \n\n* second\t\n\n\n\n#Notes  \nbody   '

  assert.equal(prettifyText(source), 'Project\n\n• first\n• second\n\n# Notes\nbody')
})

test('prettify preserves meaningful text and only formats the selected range supplied by the caller', () => {
  assert.equal(prettifyText('keep  \n\n+ item\n\n\n'), 'keep\n\n• item')
})

test('prettify does not invent bullets or alter ordinary paragraph content', () => {
  assert.equal(prettifyText('A - deliberate dash\n\n\nSecond paragraph'), 'A - deliberate dash\n\nSecond paragraph')
})

test('prettify selection changes only the selected text and retains selection boundaries', () => {
  assert.deepEqual(
    prettifySelection('Before\n- one  \n\n- two\nAfter', 7, 20),
    { text: 'Before\n• one\n• two\nAfter', start: 7, end: 17 },
  )
})
