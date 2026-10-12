import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { history, undo, redo } from '@codemirror/commands'
import { inkState, addMark, eraseInk, readInk, agentEdit, quoteAt } from './ink-state.js'

// A tiny editor: state plus dispatch, enough for CodeMirror's undo/redo commands.
function editor(doc, ink = { marks: [], drawings: [] }) {
  const target = { state: EditorState.create({ doc, extensions: [history(), inkState(ink)] }) }
  target.dispatch = (tr) => { target.state = tr.state }
  target.update = (spec) => target.dispatch(target.state.update(spec))
  return target
}
const markOn = (state, word, id = 'm1') => {
  const pos = state.doc.toString().indexOf(word)
  return { id, tool: 'red', points: [[0, 0], [30, 8]], anchor: { pos, quote: quoteAt(state.doc, pos, pos + word.length) }, dx: -4, dy: -2 }
}
const marks = (target) => readInk(target.state).marks

test('a mark on a word moves with the word when text is typed before it', () => {
  const page = editor('Circle this word please.')
  page.update({ effects: addMark.of(markOn(page.state, 'word')) })
  page.update({ changes: { from: 0, insert: 'Go on, ' } })
  assert.equal(page.state.doc.sliceString(marks(page)[0].anchor.pos, marks(page)[0].anchor.pos + 4), 'word')
})

test('deleting the words deletes their mark, and one undo brings back both', () => {
  const page = editor('Keep this. Drop this word here.')
  page.update({ effects: addMark.of(markOn(page.state, 'word')) })
  const from = page.state.doc.toString().indexOf(' Drop')
  page.update({ changes: { from, to: page.state.doc.length }, userEvent: 'delete' })
  assert.equal(marks(page).length, 0)
  undo(page)
  assert.equal(page.state.doc.toString(), 'Keep this. Drop this word here.')
  assert.equal(marks(page).length, 1)
  assert.equal(page.state.doc.sliceString(marks(page)[0].anchor.pos, marks(page)[0].anchor.pos + 4), 'word')
})

test('deleting a line that starts with the marked word deletes the mark; editing part of the word keeps it', () => {
  const page = editor('First line\nword starts this line\nlast')
  page.update({ effects: addMark.of(markOn(page.state, 'word')) })
  const start = page.state.doc.toString().indexOf('word')
  page.update({ changes: { from: start, to: start + 1, insert: 'W' } }) // a letter retyped: still the same word
  assert.equal(marks(page).length, 1)
  page.update({ changes: { from: start, to: page.state.doc.toString().indexOf('\nlast') } })
  assert.equal(marks(page).length, 0)
})

test('drawing a mark is one undo step, and redo puts it back', () => {
  const page = editor('Some text')
  page.update({ effects: addMark.of(markOn(page.state, 'text')) })
  undo(page)
  assert.equal(marks(page).length, 0)
  redo(page)
  assert.equal(marks(page).length, 1)
})

test('erasing is undoable too', () => {
  const page = editor('Some text')
  page.update({ effects: addMark.of(markOn(page.state, 'text')) })
  page.update({ effects: eraseInk.of({ marks: ['m1'] }) })
  assert.equal(marks(page).length, 0)
  undo(page)
  assert.equal(marks(page).length, 1)
})

test('after an agent rewrites the text, marks find their words again or wait as loose ink', () => {
  const page = editor('The harbour walk at dusk. A tram ride later.')
  page.update({ effects: [addMark.of(markOn(page.state, 'harbour', 'h')), addMark.of(markOn(page.state, 'tram', 't'))] })
  page.update({ changes: { from: 0, to: page.state.doc.length, insert: 'Dinner first, then the harbour at dusk.' }, annotations: agentEdit.of(true) })
  const [harbour, tram] = marks(page)
  assert.equal(page.state.doc.sliceString(harbour.anchor.pos, harbour.anchor.pos + 7), 'harbour')
  assert.equal(tram.loose, true)
  assert.equal(tram.anchor.pos, null)
  assert.equal(tram.anchor.quote.exact, 'tram')
})

test('a quote matches whole words only, so "word" is not found inside "words"', () => {
  const page = editor('Circle a word.')
  page.update({ effects: addMark.of(markOn(page.state, 'word')) })
  page.update({ changes: { from: 0, to: page.state.doc.length, insert: 'Many words here.' }, annotations: agentEdit.of(true) })
  assert.equal(marks(page)[0].loose, true)
})

test('saved ink loads back exactly as it was saved', () => {
  const saved = { marks: [{ id: 'm1', tool: 'pen', points: [[0, 0], [5, 5]], anchor: { pos: 2, quote: { exact: 'cd', prefix: 'ab', suffix: '' } }, dx: 1, dy: 2 }], drawings: [], extra: true }
  const page = editor('abcd', saved)
  assert.deepEqual(readInk(page.state), saved)
})
