// The built-in plugin host (F-090, ADR 0006, docs/MODULE-CONTRACTS.md "Plugin host contract").
// The shell asks this registry what exists instead of hard-coding optional features. Plugins are written by us and built in: nothing here loads
// outside code. A plugin that is off is hidden (no entries), not loaded (its editor is only imported through mountEditor, which refuses while
// off) and keeps its data (kindOf still knows its note types, so existing notes open read-only).
//
// A plugin definition:
//   { id, name, description, icon, defaultOn, needs: [{ kind: 'download'|'network'|'model', text }],
//     noteKinds: [{ type, label, icon, defaultTitle, mount(host, options) -> Promise<editor>, readOnly(host, document, handlers) }],
//     activate(shell) -> Promise<instance> }   (F-091: for plugins that put things in the shell, such as Voice's mic or the "By meaning" group;
//                                               `instance.dispose()` takes all of it away again)

export function createPluginRegistry(definitions) {
  const plugins = new Map(definitions.map((definition) => [definition.id, definition]))
  const enabled = new Map(definitions.map((definition) => [definition.id, Boolean(definition.defaultOn)]))
  const listeners = new Set()
  const kinds = new Map() // note type -> { plugin, kind }
  for (const plugin of definitions) for (const kind of plugin.noteKinds ?? []) kinds.set(kind.type, { plugin, kind })

  const notify = () => listeners.forEach((listener) => listener())
  const instances = new Map() // plugin id -> what activate() returned, while the plugin is on
  const loading = new Map() // plugin id -> the activate() still on its way

  return {
    list: () => definitions.map(({ id, name, description, icon, needs = [] }) => ({ id, name, description, icon, needs, enabled: enabled.get(id) })),
    isEnabled: (id) => enabled.get(id) === true,

    // `saved` is the machine's choice, {plugin id: boolean}. Anything else keeps the plugin's default.
    apply(saved = {}) {
      for (const plugin of definitions) enabled.set(plugin.id, typeof saved[plugin.id] === 'boolean' ? saved[plugin.id] : Boolean(plugin.defaultOn))
      notify()
    },

    // Make the shell match the switches: a plugin that is on and has `activate` is activated once (its code is imported only now); one that
    // is off is disposed. Safe to call after every change; a plugin switched off while it was still loading is disposed when it arrives.
    async sync(shell) {
      await Promise.all(definitions.filter((plugin) => plugin.activate).map(async (plugin) => {
        const on = enabled.get(plugin.id) === true
        if (!on && instances.has(plugin.id)) {
          const instance = instances.get(plugin.id)
          instances.delete(plugin.id)
          await instance.dispose()
        } else if (on && !instances.has(plugin.id)) {
          if (!loading.has(plugin.id)) loading.set(plugin.id, plugin.activate(shell))
          const started = loading.get(plugin.id)
          const instance = await started
          if (loading.get(plugin.id) === started) loading.delete(plugin.id)
          if (instances.has(plugin.id)) return
          if (enabled.get(plugin.id) === true) instances.set(plugin.id, instance)
          else await instance.dispose()
        }
      }))
    },

    get: (id) => instances.get(id) ?? null,
    instances: () => [...instances.values()],

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
