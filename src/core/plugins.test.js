import assert from 'node:assert/strict'
import test from 'node:test'
import { createPluginRegistry } from './plugins.js'

function fakeMaps(loads) {
  return {
    id: 'maps', name: 'Maps', description: 'Draw maps.', icon: 'git-fork', defaultOn: true,
    needs: [],
    noteKinds: [{
      type: 'map', label: 'Map', icon: 'git-fork', defaultTitle: 'Untitled map',
      mount: async (host, options) => { loads.push('editor'); return { host, options } },
      readOnly: (host, document, handlers) => ({ host, document, handlers }),
    }],
  }
}
const fakeVoice = { id: 'talk', name: 'Talk', description: 'Say it.', icon: 'mic', defaultOn: false, needs: [{ kind: 'download', text: '750 MB' }], noteKinds: [] }

test('a plugin starts on or off as its default says, until the machine says otherwise', () => {
  const registry = createPluginRegistry([fakeMaps([]), fakeVoice])
  assert.deepEqual(registry.list().map((p) => [p.id, p.enabled]), [['maps', true], ['talk', false]])
  registry.apply({ maps: false, talk: true })
  assert.deepEqual(registry.list().map((p) => [p.id, p.enabled]), [['maps', false], ['talk', true]])
  registry.apply({ maps: 'yes', other: true }) // not a boolean, not a known plugin: the default and nothing new
  assert.deepEqual(registry.list().map((p) => [p.id, p.enabled]), [['maps', true], ['talk', false]])
})

test('the new-note menu offers a plugin kind only while its plugin is on', () => {
  const registry = createPluginRegistry([fakeMaps([])])
  assert.deepEqual(registry.creatableKinds().map((k) => [k.type, k.label, k.icon]), [['map', 'Map', 'git-fork']])
  registry.apply({ maps: false })
  assert.deepEqual(registry.creatableKinds(), [])
})

test('a note type is known to its plugin even while the plugin is off, so its notes still open', () => {
  const registry = createPluginRegistry([fakeMaps([])])
  registry.apply({ maps: false })
  assert.deepEqual(registry.kindOf('map'), { pluginId: 'maps', type: 'map', label: 'Map', defaultTitle: 'Untitled map', enabled: false })
  assert.equal(registry.kindOf('canvas'), null)
})

test('the editor is loaded only while the plugin is on', async () => {
  const loads = []
  const registry = createPluginRegistry([fakeMaps(loads)])
  registry.apply({ maps: false })
  await assert.rejects(registry.mountEditor('map', 'host', {}), /Maps is switched off/)
  assert.deepEqual(loads, [])
  registry.apply({ maps: true })
  assert.deepEqual(await registry.mountEditor('map', 'host', { a: 1 }), { host: 'host', options: { a: 1 } })
  assert.deepEqual(loads, ['editor'])
})

test('a note of a switched-off plugin is shown through the plugin\'s read-only view', () => {
  const registry = createPluginRegistry([fakeMaps([])])
  assert.equal(registry.showReadOnly('map', 'host', { n: 1 }, { turnOn() {} }).document.n, 1)
  assert.equal(registry.showReadOnly('canvas', 'host', {}, {}), null)
})

test('listeners hear about a change once, and can stop listening', () => {
  const registry = createPluginRegistry([fakeMaps([])])
  const heard = []
  const stop = registry.onChange(() => heard.push(registry.isEnabled('maps')))
  registry.apply({ maps: false })
  stop()
  registry.apply({ maps: true })
  assert.deepEqual(heard, [false])
})
