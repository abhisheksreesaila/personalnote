// The built-in plugin host (F-090, ADR 0006, docs/MODULE-CONTRACTS.md "Plugin host contract").
// The shell asks this registry what exists instead of hard-coding optional features. Plugins are written by us and built in: nothing here loads
// outside code. A plugin that is off is hidden (no entries), not loaded (its editor is only imported through mountEditor, which refuses while
// off) and keeps its data (kindOf still knows its note types, so existing notes open read-only).
//
// A plugin definition:
//   { id, name, description, icon, defaultOn, needs: [{ kind: 'download'|'network'|'model', text }],
//     noteKinds: [{ type, label, icon, defaultTitle, mount(host, options) -> Promise<editor>, readOnly(host, document, handlers) }] }

export function createPluginRegistry(definitions) {
  const plugins = new Map(definitions.map((definition) => [definition.id, definition]))
  const enabled = new Map(definitions.map((definition) => [definition.id, Boolean(definition.defaultOn)]))
  const listeners = new Set()
  const kinds = new Map() // note type -> { plugin, kind }
  for (const plugin of definitions) for (const kind of plugin.noteKinds ?? []) kinds.set(kind.type, { plugin, kind })

  const notify = () => listeners.forEach((listener) => listener())

  return {
    list: () => definitions.map(({ id, name, description, icon, needs = [] }) => ({ id, name, description, icon, needs, enabled: enabled.get(id) })),
    isEnabled: (id) => enabled.get(id) === true,

    // `saved` is the machine's choice, {plugin id: boolean}. Anything else keeps the plugin's default.
    apply(saved = {}) {
      for (const plugin of definitions) enabled.set(plugin.id, typeof saved[plugin.id] === 'boolean' ? saved[plugin.id] : Boolean(plugin.defaultOn))
      notify()
    },

    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    // What the "new note" menu may offer: the kinds of the plugins that are on.
    creatableKinds: () => [...kinds.values()]
      .filter(({ plugin }) => enabled.get(plugin.id))
      .map(({ kind }) => ({ type: kind.type, label: kind.label, icon: kind.icon })),

    // The plugin a note type belongs to, on or off; null for the notebook's own types.
    kindOf(type) {
      const found = kinds.get(type)
      return found ? { pluginId: found.plugin.id, type, label: found.kind.label, defaultTitle: found.kind.defaultTitle, enabled: enabled.get(found.plugin.id) } : null
    },

    // The only road to a plugin's editor code: refused while the plugin is off, so the chunk is never requested.
    async mountEditor(type, host, options) {
      const found = kinds.get(type)
      if (!found) throw new Error(`No plugin makes ${type} notes`)
      if (!enabled.get(found.plugin.id)) throw new Error(`${found.plugin.name} is switched off`)
      return found.kind.mount(host, options)
    },

    // A note whose plugin is off, drawn without the editor.
    showReadOnly(type, host, document, handlers) {
      const found = kinds.get(type)
      return found ? found.kind.readOnly(host, document, handlers) : null
    },
  }
}
