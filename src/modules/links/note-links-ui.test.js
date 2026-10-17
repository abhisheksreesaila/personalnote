import assert from 'node:assert/strict'
import test from 'node:test'
import { linkNote } from './note-links-ui.js'

const REF = `res_${'e'.repeat(32)}`
const notes = [{ id: 1, resourceId: `res_${'1'.repeat(32)}`, title: 'Hub' }, { id: 2, resourceId: REF, title: 'Lisbon trip' }]

function host(activeNoteType, extra = {}) {
  const log = { cards: [], links: [], toasts: [] }
  return {
    log,
    state: { notes, activeNoteId: 1, activeNoteType },
    canvas: { pageAt: (x, y) => ({ x: x - 10, y: y - 20 }), addNoteLink: (point, card) => { log.cards.push([point, card]); return true } },
    page: { insertNoteLink: (markdown, at) => { log.links.push([markdown, at]); return true } },
    center: { x: 430, y: 540 },
    toast: (message) => log.toasts.push(message),
    pickTool: () => log.cards.push('select tool'),
    ...extra,
  }
}

test('a note dropped on a canvas lands as a card at the drop spot', () => {
  const h = host('canvas')
  assert.equal(linkNote(h, 2, { clientX: 300, clientY: 200 }), true)
  assert.deepEqual(h.log.cards, ['select tool', [{ x: 290, y: 180 }, { ref: REF, title: 'Lisbon trip' }]])
})

test('a note picked from the menu lands in the middle of the view', () => {
  const h = host('canvas')
  linkNote(h, 2)
  assert.deepEqual(h.log.cards[1][0], { x: 430, y: 540 })
})

test('a note dropped on a page becomes a Markdown link at the drop point', () => {
  const h = host('page')
  linkNote(h, 2, { clientX: 5, clientY: 6 })
  assert.deepEqual(h.log.links, [[`[Lisbon trip](personal-note://note/${REF})`, { clientX: 5, clientY: 6 }]])
})

test('a note cannot be linked into itself, and a mind map takes no links', () => {
  const h = host('canvas')
  assert.equal(linkNote(h, 1, { clientX: 1, clientY: 1 }), false)
  assert.deepEqual([h.log.cards.length, h.log.toasts], [0, ["A note can't link to itself"]])
  const map = host('mindmap')
  assert.equal(linkNote(map, 2), false)
  assert.deepEqual(map.log.toasts, ['Notes can be linked into canvas and page notes'])
})
