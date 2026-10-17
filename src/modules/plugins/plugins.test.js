import assert from 'node:assert/strict'
import test from 'node:test'
import { mapOutline } from './mindmap-readonly.js'
import { describePlugin } from './plugins-settings.js'
import { BUILTIN_PLUGINS } from './builtin.js'
import { createPluginRegistry } from '../../core/plugins.js'

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

// ---- F-091: plugins with a lifecycle (activate / dispose), loaded only while on ----
function lifecyclePlugin(log, id = 'voice') {
  return { id, name: id, description: '', icon: 'mic', defaultOn: true, needs: [], activate: async (shell) => { log.push(`activate ${shell.tag}`); return { id, dispose: () => log.push('dispose') } } }
}

test('a plugin that is on is activated once and its instance is found by id', async () => {
  const log = []
  const registry = createPluginRegistry([lifecyclePlugin(log)])
  await registry.sync({ tag: 'a' })
  await registry.sync({ tag: 'b' })
  assert.deepEqual(log, ['activate a'])
  assert.equal(registry.get('voice').id, 'voice')
  assert.deepEqual(registry.instances().map((instance) => instance.id), ['voice'])
})

test('a plugin that is off is never activated, so nothing of it is loaded', async () => {
  const log = []
  const registry = createPluginRegistry([lifecyclePlugin(log)])
  registry.apply({ voice: false })
  await registry.sync({ tag: 'a' })
  assert.deepEqual(log, [])
  assert.equal(registry.get('voice'), null)
})

test('switching off disposes the instance, switching on again activates a fresh one', async () => {
  const log = []
  const registry = createPluginRegistry([lifecyclePlugin(log)])
  await registry.sync({ tag: 'a' })
  registry.apply({ voice: false })
  await registry.sync({ tag: 'a' })
  assert.equal(registry.get('voice'), null)
  registry.apply({ voice: true })
  await registry.sync({ tag: 'b' })
  assert.deepEqual(log, ['activate a', 'dispose', 'activate b'])
})

test('switched off while still loading: it is disposed the moment it arrives', async () => {
  const log = []
  let release
  const slow = { ...lifecyclePlugin(log), activate: () => new Promise((resolve) => { release = () => resolve({ dispose: () => log.push('dispose') }) }) }
  const registry = createPluginRegistry([slow])
  const syncing = registry.sync({})
  registry.apply({ voice: false })
  release()
  await syncing
  assert.deepEqual(log, ['dispose'])
  assert.equal(registry.get('voice'), null)
})

test('Voice and Search by meaning are built-in, on by default, and say what they need', () => {
  const byId = Object.fromEntries(BUILTIN_PLUGINS.map((plugin) => [plugin.id, plugin]))
  assert.deepEqual(BUILTIN_PLUGINS.map((plugin) => plugin.id), ['mindmap', 'voice', 'meaning', 'jam'])
  assert.deepEqual([byId.voice.name, byId.voice.defaultOn, byId.meaning.name, byId.meaning.defaultOn], ['Voice', true, 'Search by meaning', true])
  assert.equal(describePlugin(byId.voice), 'Dictate into a note with your voice. Audio is never kept, only the words. Needs: about 750 MB download (the Nemotron speech model), runs on this computer.')
  assert.equal(describePlugin(byId.meaning), 'Find notes by what they mean, not only their words. Needs: about 315 MB download (the EmbeddingGemma model), runs on this computer.')
})

// ---- F-092: a plugin that needs other plugins ----
const needy = (log) => ({ ...lifecyclePlugin(log, 'jam'), defaultOn: true, requires: ['mindmap', 'voice'] })
const base = () => [{ id: 'mindmap', name: 'Mind maps', description: '', icon: 'map', defaultOn: true, needs: [] }, lifecyclePlugin([], 'voice')]

test('a plugin that needs others waits until they are all on, and goes when one goes', async () => {
  const log = []
  const registry = createPluginRegistry([...base(), needy(log)])
  registry.apply({ voice: false })
  await registry.sync({ tag: 'a' })
  assert.deepEqual(log, [])
  registry.apply({ voice: true })
  await registry.sync({ tag: 'b' })
  assert.deepEqual(log, ['activate b'])
  registry.apply({ mindmap: false })
  await registry.sync({ tag: 'c' })
  assert.deepEqual(log, ['activate b', 'dispose'])
  assert.equal(registry.get('jam'), null)
  assert.equal(registry.isEnabled('jam'), true) // its own switch is still on: it comes back when Mind maps does
})

test('Jam sessions is built in, off until someone turns it on, and says what it needs', () => {
  const jam = BUILTIN_PLUGINS.find((plugin) => plugin.id === 'jam')
  assert.deepEqual([jam.name, jam.defaultOn, jam.requires], ['Jam sessions', false, ['mindmap', 'voice']])
  assert.match(describePlugin(jam), /Needs: .*Mind maps and Voice.*Settings → AI/)
})
