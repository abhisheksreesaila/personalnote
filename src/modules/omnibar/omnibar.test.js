import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGroups, filterCounts, flatten, highlight, moveSelection, queryTokens, relativeTime } from './omnibar.js'

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
const labels = (groups) => groups.filter((group) => group.label).map((group) => group.label) // the New note row has no heading
const ids = (groups) => flatten(groups).filter((item) => item.kind !== 'create').map((item) => item.id)

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

test('no match gives no groups under the Notebooks and Actions chips', () => {
  assert.deepEqual(buildGroups({ ...base, query: 'zzzz', filter: 'Notebooks' }), [])
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

// ---- By meaning (F-080) ----
const meaning = (...hits) => hits.map(([id, title, notebookName = 'Home']) => ({ id, title, notebookName, score: 0.7 }))

test('"By meaning" comes last under the word matches and lists notes not already shown', () => {
  const wordHits = [{ id: 11, title: 'Packing list', excerpt: 'bring the tide chart', notebookId: 1 }]
  const groups = buildGroups({ ...base, query: 'tide', wordHits, meaningHits: meaning([10, 'Tide tables'], [11, 'Packing list'], [14, 'Kitchen shelves']) })
  assert.deepEqual(labels(groups), ['Notes', 'In your words', 'By meaning'])
  assert.deepEqual(ids(groups), [10, 11, 14])
  assert.deepEqual(groups[2].items.map((item) => [item.kind, item.title, item.notebookName]), [['meaning', 'Kitchen shelves', 'Home']])
})

test('it shows at most 5 notes, best first, and the rows keep their note type from the notebook list', () => {
  const hits = meaning([10, 'a'], [11, 'b'], [13, 'c'], [14, 'd'], [15, 'e'], [12, 'f'], [99, 'g'])
  const group = buildGroups({ ...base, query: 'zzz', meaningHits: hits }).find((item) => item.key === 'meaning')
  assert.deepEqual(group.items.map((item) => item.id), [10, 11, 13, 14, 15])
  assert.deepEqual(group.items.map((item) => item.noteType), ['canvas', 'page', 'canvas', 'canvas', 'mindmap'])
})

test('a note the title search already shows is not repeated under By meaning', () => {
  const groups = buildGroups({ ...base, query: 'tide', meaningHits: meaning([10, 'Tide tables'], [13, 'Loose thought']) })
  assert.deepEqual(ids(groups), [10, 13])
  assert.deepEqual(labels(groups), ['Notes', 'By meaning'])
})

test('a secure note never appears under By meaning, even if the server sent it', () => {
  const groups = buildGroups({ ...base, query: 'zzz', meaningHits: meaning([12, 'Card numbers'], [13, 'Loose thought']) })
  assert.deepEqual(ids(groups), [13])
})

test('a note the page does not know (deleted since) is left out, and no hits means no group', () => {
  assert.deepEqual(ids(buildGroups({ ...base, query: 'zzz', meaningHits: meaning([404, 'Gone']) })), [])
  assert.deepEqual(labels(buildGroups({ ...base, query: 'tide', meaningHits: [] })), ['Notes'])
})

test('By meaning shows under All and Notes only, and never for an empty query', () => {
  const hits = meaning([13, 'Loose thought'])
  assert.deepEqual(labels(buildGroups({ ...base, query: 'zzz', meaningHits: hits, filter: 'Notes' })), ['By meaning'])
  assert.deepEqual(labels(buildGroups({ ...base, query: 'zzz', meaningHits: hits, filter: 'Notebooks' })), [])
  assert.deepEqual(labels(buildGroups({ ...base, query: 'zzz', meaningHits: hits, filter: 'Actions' })), [])
  assert.deepEqual(labels(buildGroups({ ...base, query: '', meaningHits: hits })), ['Recent', 'Actions'])
})

test('By meaning is the last group, below the actions too, so arrows flow through every group in order', () => {
  const groups = buildGroups({ ...base, query: 'note', meaningHits: meaning([13, 'Loose thought']) })
  assert.deepEqual(labels(groups), ['Actions', 'By meaning'])
  const items = flatten(groups)
  assert.deepEqual(items.map((item) => item.id), ['new', 'quick', 'secure', 13])
  assert.equal(items[moveSelection(2, 1, items.length)].id, 13)
  assert.equal(items[moveSelection(3, 1, items.length)].id, 'new')
})

// ---- the "New note" row is offered whenever nothing else matches (F-080) ----
const created = (groups) => flatten(groups).filter((item) => item.kind === 'create').map((item) => item.title)

test('nothing matching offers New note "query", and Enter on that list creates it', () => {
  const groups = buildGroups({ ...base, query: 'zzzz' })
  assert.deepEqual(flatten(groups).map((item) => [item.kind, item.title]), [['create', 'zzzz']])
})

test('while the meaning answer is still out the list is just New note, so Enter never waits', () => {
  const groups = buildGroups({ ...base, query: 'zzzz', meaningHits: [] })
  assert.equal(flatten(groups)[0].kind, 'create')
})

test('with meaning matches and nothing else, the create row sits last', () => {
  const groups = buildGroups({ ...base, query: 'zzzz', meaningHits: meaning([13, 'Loose thought'], [14, 'Kitchen shelves']) })
  assert.deepEqual(labels(groups).slice(0, 1), ['By meaning'])
  assert.deepEqual(flatten(groups).map((item) => item.kind), ['meaning', 'meaning', 'create'])
})

test('no create row when a title, word, notebook or action matches', () => {
  assert.deepEqual(created(buildGroups({ ...base, query: 'tide' })), [])
  assert.deepEqual(created(buildGroups({ ...base, query: 'home' })), [])
  assert.deepEqual(created(buildGroups({ ...base, query: 'dark' })), [])
  assert.deepEqual(created(buildGroups({ ...base, query: 'zzzz', wordHits: [{ id: 10, title: 'Tide tables', excerpt: 'zzzz', notebookId: 1 }] })), [])
})

test('no create row while the word search is out, for an empty query, or under the Notebooks and Actions chips', () => {
  assert.deepEqual(created(buildGroups({ ...base, query: 'zzzz', wordsPending: true })), [])
  assert.deepEqual(created(buildGroups({ ...base, query: '' })), [])
  assert.deepEqual(created(buildGroups({ ...base, query: 'zzzz', filter: 'Notebooks' })), [])
  assert.deepEqual(created(buildGroups({ ...base, query: 'zzzz', filter: 'Actions' })), [])
})

// ---- prettier results (F-101) ----
const NOW = Date.parse('2026-10-17T12:00:00Z')

test('a note result carries what its row shows: emoji icon, resource id, notebook and when it was edited', () => {
  const icon = { emoji: '✈️', tint: 2, chosen: true }
  const stored = [{ id: 20, resourceId: 'res_a', title: 'Lisbon trip', noteType: 'page', notebookId: 1, secure: false, icon, updatedAt: '2026-10-17 10:00:00', createdAt: '2026-10-02 08:00:00' }]
  const [item] = flatten(buildGroups({ ...base, notes: stored, query: 'lisbon' }))
  assert.deepEqual([item.icon, item.resourceId, item.notebookName, item.updatedAt, item.createdAt], [icon, 'res_a', 'Travel', '2026-10-17 10:00:00', '2026-10-02 08:00:00'])
})

test('a title match shows the snippet the word search found for the same note', () => {
  const wordHits = [{ id: 10, title: 'Tide tables', excerpt: 'low tide at 6:42', notebookId: 1 }]
  const [group] = buildGroups({ ...base, query: 'tide', wordHits })
  assert.deepEqual(group.items.map((item) => [item.id, item.excerpt]), [[10, 'low tide at 6:42']])
})

test('a secure note matched by title shows no snippet even when the search sent one', () => {
  const wordHits = [{ id: 12, title: 'Card numbers', excerpt: 'secret 4111', secure: true, notebookId: 2 }]
  assert.equal(flatten(buildGroups({ ...base, query: 'card', wordHits }))[0].excerpt, '')
})

test('the pills count notes, notebooks and actions for a query', () => {
  assert.deepEqual(filterCounts(buildGroups({ ...base, query: 'note' })), { Notes: 0, Notebooks: 0, Actions: 3 })
  assert.deepEqual(filterCounts(buildGroups({ ...base, query: 'home' })), { Notes: 0, Notebooks: 1, Actions: 0 })
  assert.deepEqual(filterCounts(buildGroups({ ...base, query: 'tide', meaningHits: meaning([13, 'Loose thought']) })), { Notes: 2, Notebooks: 0, Actions: 0 })
})

test('the New note row is not counted as a result', () => {
  assert.deepEqual(filterCounts(buildGroups({ ...base, query: 'zzzz' })), { Notes: 0, Notebooks: 0, Actions: 0 })
})

test('time is said the way people say it: minutes, hours, a weekday, then a date', () => {
  assert.equal(relativeTime('2026-10-17 11:59:40', NOW), 'now')
  assert.equal(relativeTime('2026-10-17 11:15:00', NOW), '45 min ago')
  assert.equal(relativeTime('2026-10-17 10:00:00', NOW), '2 h ago')
  assert.equal(relativeTime('2026-10-14 09:00:00', NOW), 'Wed')
  assert.equal(relativeTime('2026-09-03 09:00:00', NOW), 'Sep 3')
  assert.equal(relativeTime('2025-09-03 09:00:00', NOW), 'Sep 3, 2025')
  assert.equal(relativeTime('', NOW), '')
})
