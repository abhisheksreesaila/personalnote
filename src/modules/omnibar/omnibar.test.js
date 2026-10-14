import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGroups, flatten, highlight, moveSelection, queryTokens } from './omnibar.js'

const notebooks = [
  { id: 1, name: 'Travel', color: '#2f9d8f', noteCount: 2 },
  { id: 2, name: 'Home', color: '#d9822b', noteCount: 1 },
]
const notes = [
  { id: 10, title: 'Tide tables', noteType: 'canvas', notebookId: 1, secure: false },
  { id: 11, title: 'Packing list', noteType: 'page', notebookId: 1, secure: false },
  { id: 12, title: 'Card numbers', noteType: 'page', notebookId: 2, secure: true },
  { id: 13, title: 'Loose thought', noteType: 'canvas', notebookId: null, secure: false },
  { id: 14, title: 'Kitchen shelves', noteType: 'canvas', notebookId: 2, secure: false },
  { id: 15, title: 'Old idea', noteType: 'mindmap', notebookId: 2, secure: false },
]
const actions = [
  { id: 'new', title: 'New note', icon: 'plus', top: true },
  { id: 'quick', title: 'Quick note', icon: 'zap', top: true },
  { id: 'secure', title: 'Make this note secure', icon: 'lock', keywords: 'lock private' },
  { id: 'skin-night', title: 'Skin: Night', icon: 'palette', keywords: 'switch skin theme dark' },
]
const base = { notes, notebooks, actions, wordHits: [], filter: 'All' }
const labels = (groups) => groups.map((group) => group.label)
const ids = (groups) => flatten(groups).map((item) => item.id)

test('an empty query offers the 4 most recent notes and the top actions', () => {
  const groups = buildGroups({ ...base, query: '' })
  assert.deepEqual(labels(groups), ['Recent', 'Actions'])
  assert.deepEqual(ids(groups), [10, 11, 12, 13, 'new', 'quick'])
})

test('with the Notes chip an empty query lists 8 recent notes, with Notebooks all notebooks, with Actions all actions', () => {
  assert.equal(flatten(buildGroups({ ...base, query: '', filter: 'Notes' })).length, 6)
  assert.deepEqual(ids(buildGroups({ ...base, query: '', filter: 'Notebooks' })), [1, 2])
  assert.equal(flatten(buildGroups({ ...base, query: '', filter: 'Actions' })).length, 4)
})

test('a query finds notes by title, notebooks by name and actions by title or keyword', () => {
  assert.deepEqual(ids(buildGroups({ ...base, query: 'tide' })), [10])
  assert.deepEqual(labels(buildGroups({ ...base, query: 'home' })), ['Notebooks'])
  assert.deepEqual(ids(buildGroups({ ...base, query: 'dark' })), ['skin-night'])
  assert.deepEqual(ids(buildGroups({ ...base, query: 'note' })), ['new', 'quick', 'secure'])
})

test('every word of the query must be in the title, in any order', () => {
  assert.deepEqual(ids(buildGroups({ ...base, query: 'tables tide' })), [10])
  assert.deepEqual(ids(buildGroups({ ...base, query: 'tide zzz' })), [])
})

test('word matches from the search go under "In your words" with their snippet, after the title matches, without repeating a note', () => {
  const wordHits = [
    { id: 10, title: 'Tide tables', excerpt: 'low tide at 6:42', notebookId: 1 },
    { id: 11, title: 'Packing list', excerpt: 'bring the tide chart', notebookId: 1 },
  ]
  const groups = buildGroups({ ...base, query: 'tide', wordHits })
  assert.deepEqual(labels(groups), ['Notes', 'In your words'])
  assert.deepEqual(ids(groups), [10, 11])
  assert.equal(groups[1].items[0].excerpt, 'bring the tide chart')
  assert.equal(groups[1].items[0].kind, 'words')
})

test('a search hit with no snippet is a title match and stays under Notes', () => {
  const groups = buildGroups({ ...base, query: 'old zzz', wordHits: [{ id: 15, title: 'Old idea', excerpt: '', notebookId: 2 }] })
  assert.deepEqual(labels(groups), ['Notes'])
})

test('a secure note shows by title only: no words, even if the server sent some', () => {
  const wordHits = [{ id: 12, title: 'Card numbers', excerpt: 'secret 4111', secure: true, notebookId: 2 }]
  const groups = buildGroups({ ...base, query: 'card', wordHits })
  const secure = flatten(groups).filter((item) => item.id === 12)
  assert.equal(secure.length, 1)
  assert.equal(secure[0].kind, 'note')
  assert.equal(secure[0].secure, true)
  assert.equal(secure[0].excerpt, '')
  const byWords = buildGroups({ ...base, query: 'secret', wordHits })
  assert.equal(flatten(byWords).find((item) => item.id === 12)?.excerpt ?? '', '')
})

test('chips narrow the groups', () => {
  const wordHits = [{ id: 14, title: 'Kitchen shelves', excerpt: 'home oak', notebookId: 2 }]
  assert.deepEqual(labels(buildGroups({ ...base, query: 'home', wordHits, filter: 'Notebooks' })), ['Notebooks'])
  assert.deepEqual(labels(buildGroups({ ...base, query: 'home', wordHits, filter: 'Notes' })), ['In your words'])
  assert.deepEqual(labels(buildGroups({ ...base, query: 'note', filter: 'Actions' })), ['Actions'])
})

test('no match gives no groups', () => {
  assert.deepEqual(buildGroups({ ...base, query: 'zzzz' }), [])
})

test('rows carry the notebook name; an unfiled note says Inbox', () => {
  const [group] = buildGroups({ ...base, query: 'loose' })
  assert.equal(group.items[0].notebookName, 'Inbox')
  assert.equal(buildGroups({ ...base, query: 'tide' })[0].items[0].notebookName, 'Travel')
})

test('highlight marks each query word and escapes everything else', () => {
  assert.equal(highlight('Tide <b>tables</b>', queryTokens('tide')), '<mark>Tide</mark> &lt;b&gt;tables&lt;/b&gt;')
  assert.equal(highlight('a.b (c)', queryTokens('a.b (c)')), '<mark>a.b</mark> <mark>(c)</mark>')
  assert.equal(highlight('plain', []), 'plain')
})

test('the selection wraps around and stays put on an empty list', () => {
  assert.equal(moveSelection(0, 1, 3), 1)
  assert.equal(moveSelection(2, 1, 3), 0)
  assert.equal(moveSelection(0, -1, 3), 2)
  assert.equal(moveSelection(0, 1, 0), 0)
})
