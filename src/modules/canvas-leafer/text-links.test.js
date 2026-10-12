import test from 'node:test'
import assert from 'node:assert/strict'
import { followLinks, linkRanges, linkWord, withLinks } from './text-links.js'
import { parseMarkdown } from './markdown.js'

const SOURCE = 'See the route map today'
const doc = (objects) => ({ objects })
const link = (id, pos, end, folded = false) => ({ id, type: 'ink', link: { textId: 'T', pos, end, quote: { exact: SOURCE.slice(pos, end) } }, folded })

test('the words that open linked objects, with whether they are folded', () => {
  const ranges = linkRanges(doc([link('a', 8, 13, true), link('b', 14, 17), { id: 'c', type: 'ink' }, { id: 'd', link: { textId: 'X', pos: 0, end: 3 } }]), 'T')
  assert.deepEqual(ranges, [{ pos: 8, end: 13, folded: true, ids: ['a'] }, { pos: 14, end: 17, folded: false, ids: ['b'] }])
})

test('a run is cut where a link word starts and ends, and the link word is marked', () => {
  const [line] = withLinks(parseMarkdown(SOURCE), [{ pos: 8, end: 13, folded: true, ids: ['a'] }])
  assert.deepEqual(line.runs.map((run) => [SOURCE.slice(run.from, run.to), run.style.fold ?? null]), [['See the ', null], ['route', 'folded'], [' map today', null]])
})

test('a click inside a link word finds it', () => {
  const words = [{ from: 8, to: 13, x: 60, y: 0, width: 50, height: 20 }]
  assert.deepEqual(linkWord(words, [{ pos: 8, end: 13, folded: false, ids: ['a'] }], { x: 70, y: 10 })?.ids, ['a'])
  assert.equal(linkWord(words, [{ pos: 8, end: 13, folded: false, ids: ['a'] }], { x: 20, y: 10 }), null)
})

test('linked objects follow their word through an edit; a deleted word unlinks and shows its object', () => {
  const objects = [link('a', 8, 13, true), link('b', 18, 23, true)]
  const changes = followLinks(doc(objects), 'T', SOURCE, 'See the old route map')
  const after = Object.fromEntries(changes.map((change) => [change.id, change.after]))
  assert.deepEqual([after.a.link.pos, after.a.link.end, after.a.folded], [12, 17, true])
  assert.deepEqual([after.b.link, after.b.folded], [null, false])
})

test('deleting a link word never hands the link to the next word, even when they share letters', () => {
  const source = 'a quiet quote'
  const objects = [{ id: 'a', link: { textId: 'T', pos: 2, end: 7, quote: { exact: 'quiet' } }, folded: true }]
  const [change] = followLinks({ objects }, 'T', source, 'a quote')
  assert.deepEqual([change.after.link, change.after.folded], [null, false])
})
