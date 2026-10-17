// Settings → Plugins (F-090): one row per built-in plugin, with what it does, what it needs and a switch. The server keeps the choice
// (plugin_settings.py); this draws the rows from the registry and sends a switch to `onSwitch(id, on)`.

export function describePlugin({ description, needs }) {
  return needs.length ? `${description} Needs: ${needs.map((need) => need.text).join(', ')}.` : `${description} Nothing to download.`
}

export function mountPluginSettings(root, registry, onSwitch, afterDraw = () => {}) {
  function draw() {
    root.replaceChildren(...registry.list().flatMap((plugin) => {
      const row = document.createElement('label')
      row.className = 'setting-row'
      const name = document.createElement('span')
      const icon = document.createElement('i')
      icon.dataset.lucide = plugin.icon
      name.append(icon, plugin.name)
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.id = `plugin-${plugin.id}`
      box.checked = plugin.enabled
      box.addEventListener('change', async () => {
        box.disabled = true
        try { await onSwitch(plugin.id, box.checked) } catch { box.checked = !box.checked } finally { box.disabled = false }
      })
      row.append(name, box)
      const help = document.createElement('p')
      help.className = 'portability-help'
      help.textContent = describePlugin(plugin)
      return [row, help]
    }))
    afterDraw()
  }
  registry.onChange(draw)
  draw()
}
