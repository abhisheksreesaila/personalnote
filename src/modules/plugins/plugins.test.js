import assert from 'node:assert/strict'
import test from 'node:test'
import { mapOutline } from './mindmap-readonly.js'
import { describePlugin } from './plugins-settings.js'
import { BUILTIN_PLUGINS } from './builtin.js'

test('a map reads as an outline: branches under their parent, in the order they were made', () => {
  const doc = { rootId: 'r', nodes: [
    { id: 'r', parentId: null, text: 'Trip' },
    { id: 'a', parentId: 'r', text: 'Flights' },
    { id: 'b', parentId: 'r', text: 'Food' },
    { id: 'c', parentId: 'a', text: 'Gate 4' },
  ] }
  assert.deepEqual(mapOutline(doc), [{ text: 'Trip', children: [{ text: 'Flights', children: [{ text: 'Gate 4', children: [] }] }, { text: 'Food', children: [] }] }])
})

test('a damaged map still gives an outline instead of an error', () => {
  assert.deepEqual(mapOutline(null), [])
  assert.deepEqual(mapOutline({ nodes: [{ id: 'x', parentId: 'gone', text: 'Lost' }, 7] }), [])
  assert.deepEqual(mapOutline({ nodes: [{ id: 'x', parentId: null, text: 'Top' }, { id: 'x', parentId: null, text: 'Twin' }] }), [{ text: 'Top', children: [] }])
})

test('a plugin row says what it is and what it needs, in a line', () => {
  assert.equal(describePlugin({ description: 'Draw ideas as a map.', needs: [] }), 'Draw ideas as a map. Nothing to download.')
  assert.equal(describePlugin({ description: 'Say it.', needs: [{ kind: 'download', text: '750 MB download' }, { kind: 'network', text: 'the network' }] }), 'Say it. Needs: 750 MB download, the network.')
})

test('Mind maps is the first built-in plugin, on by default, making mindmap notes', () => {
  const [mindmaps] = BUILTIN_PLUGINS
  assert.deepEqual([mindmaps.id, mindmaps.name, mindmaps.defaultOn, mindmaps.noteKinds.map((k) => k.type)], ['mindmap', 'Mind maps', true, ['mindmap']])
})
