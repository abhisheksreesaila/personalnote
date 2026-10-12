import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState, Transaction } from '@codemirror/state'
import { history, undo, redo } from '@codemirror/commands'
import { inkState, addMark, eraseInk, readInk, agentEdit, quoteAt, addDrawing, updateDrawing, foldDrawing, setMarks, setDrawings } from './ink-state.js'

// A tiny editor: state plus dispatch, enough for CodeMirror's undo/redo commands.
function editor(doc, ink = { marks: [], drawings: [] }) {
  const target = { state: EditorState.create({ doc, extensions: [history(), inkState(ink)] }) }
  target.dispatch = (tr) => { target.state = tr.state }
  target.update = (spec) => target.dispatch(target.state.update(spec))
  return target
}
const markOn = (state, word, id = 'm1') => {
  const pos = state.doc.toString().indexOf(word)
  return { id, tool: 'red', points: [[0, 0], [30, 8]], anchor: { pos, end: pos + word.length, quote: quoteAt(state.doc, pos, pos + word.length) }, dx: -4, dy: -2 }
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

test('a mark survives its paragraph being split and merged back', () => {
  const page = editor('First half. Second half with a word.')
  page.update({ effects: addMark.of(markOn(page.state, 'word')) })
  const cut = page.state.doc.toString().indexOf(' Second')
  page.update({ changes: { from: cut, to: cut + 1, insert: '\n\n' } })
  page.update({ changes: { from: cut, to: cut + 2, insert: ' ' } })
  assert.equal(page.state.doc.sliceString(marks(page)[0].anchor.pos, marks(page)[0].anchor.end), 'word')
})

test('backspacing into a marked word and undoing gives the mark its whole word back', () => {
  const page = editor('a word here')
  page.update({ effects: addMark.of(markOn(page.state, 'word')) })
  const d = page.state.doc.toString().indexOf('d here')
  page.update({ changes: { from: d, to: d + 1 }, userEvent: 'delete.backward' })
  undo(page)
  const [mark] = marks(page)
  assert.equal(page.state.doc.sliceString(mark.anchor.pos, mark.anchor.end), 'word')
})

test('a margin mark anchored to its whole line lives until the whole line is gone', () => {
  const page = editor('Top\nfirst words of a line\nEnd')
  const line = page.state.doc.line(2)
  page.update({ effects: addMark.of({ id: 'margin', tool: 'red', margin: true, points: [[0, 0], [5, 5]], anchor: { pos: line.from, end: line.to, quote: quoteAt(page.state.doc, line.from, line.to) }, dx: -40, dy: 0 }) })
  page.update({ changes: { from: line.from, to: line.from + 'first '.length } })
  assert.equal(marks(page).length, 1)
  const now = page.state.doc.line(2)
  page.update({ changes: { from: now.from - 1, to: now.to } })
  assert.equal(marks(page).length, 0)
})

test('loading a whole new document (an agent change) after deleting marked words never breaks undo history', () => {
  const page = editor('Keep this. Drop this word here.')
  page.update({ effects: addMark.of(markOn(page.state, 'word')) })
  const from = page.state.doc.toString().indexOf(' Drop')
  page.update({ changes: { from, to: page.state.doc.length } })
  page.update({ changes: { from: 0, to: page.state.doc.length, insert: 'abcd' }, effects: [setMarks.of([]), setDrawings.of([])], annotations: Transaction.addToHistory.of(false) })
  assert.doesNotThrow(() => { undo(page); undo(page) })
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

// ---------- drawings (F-043) ----------
const drawingBefore = (state, text, id = 'd1') => {
  const pos = state.doc.toString().indexOf(text)
  const line = state.doc.lineAt(pos)
  return { id, pos: line.from, side: -1, height: 120, quote: quoteAt(state.doc, line.from, line.to), link: null, folded: false, strokes: [{ id: 's1', tool: 'pen', points: [[0, 0], [40, 20]], dx: 30, dy: 20 }], items: [] }
}
const drawings = (target) => readInk(target.state).drawings

test('a drawing on its own stays between its paragraphs when text is typed above it', () => {
  const page = editor('Intro\n\nAfter the sketch')
  page.update({ effects: addDrawing.of(drawingBefore(page.state, 'After the sketch')) })
  page.update({ changes: { from: 0, insert: 'A new first line\n' } })
  const [drawing] = drawings(page)
  assert.equal(page.state.doc.lineAt(drawing.pos).text, 'After the sketch')
})

test('a drawing on its own is linked to no word: deleting the text next to it keeps it', () => {
  const page = editor('Intro\n\nAfter the sketch')
  page.update({ effects: addDrawing.of(drawingBefore(page.state, 'After the sketch')) })
  const from = page.state.doc.toString().indexOf('After')
  page.update({ changes: { from, to: page.state.doc.length } })
  assert.equal(drawings(page).length, 1)
})

test('adding to a drawing (a stroke, more height) is one undo step', () => {
  const page = editor('Intro\n\nAfter')
  page.update({ effects: addDrawing.of(drawingBefore(page.state, 'After')) })
  const grown = { id: 'd1', height: 220, strokes: [...drawings(page)[0].strokes, { id: 's2', tool: 'red', points: [[0, 0], [5, 5]], dx: 10, dy: 150 }] }
  page.update({ effects: updateDrawing.of(grown) })
  assert.equal(drawings(page)[0].strokes.length, 2)
  undo(page)
  assert.equal(drawings(page)[0].strokes.length, 1)
  assert.equal(drawings(page)[0].height, 120)
})

test('erasing a stroke inside a drawing, or a whole drawing, is undoable', () => {
  const page = editor('Intro\n\nAfter')
  page.update({ effects: addDrawing.of(drawingBefore(page.state, 'After')) })
  page.update({ effects: eraseInk.of({ strokes: [{ drawing: 'd1', id: 's1' }] }) })
  assert.equal(drawings(page)[0].strokes.length, 0)
  page.update({ effects: eraseInk.of({ drawings: ['d1'] }) })
  assert.equal(drawings(page).length, 0)
  undo(page)
  undo(page)
  assert.equal(drawings(page)[0].strokes.length, 1)
})

test('after an agent rewrite a drawing on its own goes back under the line it sat under', () => {
  const page = editor('Intro\n\nAfter the sketch\nTail')
  const pos = page.state.doc.toString().indexOf('After')
  const line = page.state.doc.lineAt(pos)
  page.update({ effects: addDrawing.of({ ...drawingBefore(page.state, 'After'), pos: line.to + 1, quote: quoteAt(page.state.doc, line.from, line.to) }) })
  page.update({ changes: { from: 0, to: page.state.doc.length, insert: 'Tail first\n\nAfter the sketch\nend' }, annotations: agentEdit.of(true) })
  const [drawing] = drawings(page)
  assert.equal(page.state.doc.lineAt(drawing.pos).text, 'end')
})

// ---------- link and fold (F-044) ----------
const linkTo = (state, word) => { const pos = state.doc.toString().indexOf(word); return { pos, end: pos + word.length, quote: quoteAt(state.doc, pos, pos + word.length) } }

test('a drawing linked to a word is deleted with the word, and undo brings back both', () => {
  const page = editor('See the sketch here\n\nNext')
  page.update({ effects: addDrawing.of({ ...drawingBefore(page.state, 'Next'), link: linkTo(page.state, 'sketch'), folded: true }) })
  const at = page.state.doc.toString().indexOf('sketch')
  page.update({ changes: { from: at, to: at + 'sketch'.length } })
  assert.equal(drawings(page).length, 0)
  undo(page)
  assert.equal(drawings(page).length, 1)
  assert.equal(drawings(page)[0].folded, true)
})

test('folding is saved with the drawing but is not an undo step', () => {
  const page = editor('See the sketch\n\nNext')
  page.update({ effects: addDrawing.of({ ...drawingBefore(page.state, 'Next'), link: linkTo(page.state, 'sketch') }) })
  page.update({ changes: { from: 0, insert: 'A ' } })
  page.update({ effects: foldDrawing.of({ ids: ['d1'], folded: true }), annotations: Transaction.addToHistory.of(false) })
  assert.equal(drawings(page)[0].folded, true)
  undo(page) // undoes the typing, not the fold
  assert.equal(page.state.doc.toString().startsWith('See'), true)
  assert.equal(drawings(page)[0].folded, true)
})

test('only a linked drawing can fold', () => {
  const page = editor('Intro\n\nNext')
  page.update({ effects: addDrawing.of(drawingBefore(page.state, 'Next')) })
  page.update({ effects: foldDrawing.of({ ids: ['d1'], folded: true }) })
  assert.equal(drawings(page)[0].folded, false)
})

test('backspacing into a link word and undoing gives the link its whole word back', () => {
  const page = editor('See the sketch here\n\nNext')
  page.update({ effects: addDrawing.of({ ...drawingBefore(page.state, 'Next'), link: linkTo(page.state, 'sketch') }) })
  const h = page.state.doc.toString().indexOf('h here')
  page.update({ changes: { from: h, to: h + 1 }, userEvent: 'delete.backward' })
  undo(page)
  const { link } = drawings(page)[0]
  assert.equal(page.state.doc.sliceString(link.pos, link.end), 'sketch')
})

test('undo never flips a fold: undoing a stroke keeps the drawing folded as it is now', () => {
  const page = editor('See the sketch\n\nNext')
  page.update({ effects: addDrawing.of({ ...drawingBefore(page.state, 'Next'), link: linkTo(page.state, 'sketch') }) })
  page.update({ effects: updateDrawing.of({ id: 'd1', strokes: [...drawings(page)[0].strokes, { id: 's2', tool: 'red', points: [[0, 0], [5, 5]], dx: 1, dy: 1 }] }) })
  page.update({ effects: foldDrawing.of({ ids: ['d1'], folded: true }), annotations: Transaction.addToHistory.of(false) })
  undo(page)
  assert.equal(drawings(page)[0].strokes.length, 1)
  assert.equal(drawings(page)[0].folded, true)
})

test('after an agent rewrite a linked drawing follows its word, or is unlinked and unfolded when the word is gone', () => {
  const page = editor('Intro\n\nSee the sketch here\n\nTail')
  page.update({ effects: addDrawing.of({ ...drawingBefore(page.state, 'Tail'), link: linkTo(page.state, 'sketch'), folded: true }) })
  page.update({ changes: { from: 0, to: page.state.doc.length, insert: 'Tail first\n\nThe sketch moved\n\nEnd' }, annotations: agentEdit.of(true) })
  let [drawing] = drawings(page)
  assert.equal(page.state.doc.sliceString(drawing.link.pos, drawing.link.end), 'sketch')
  assert.equal(page.state.doc.lineAt(drawing.pos).text, '')
  assert.equal(drawing.folded, true)
  page.update({ changes: { from: 0, to: page.state.doc.length, insert: 'Nothing about it now' }, annotations: agentEdit.of(true) })
  ;[drawing] = drawings(page)
  assert.equal(drawing.link, null)
  assert.equal(drawing.folded, false)
})
