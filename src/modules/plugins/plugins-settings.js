// Settings → Plugins (F-090): one row per built-in plugin, with what it does, what it needs and a switch. The server keeps the choice
// (plugin_settings.py); this draws the rows from the registry and sends a switch to `onSwitch(id, on)`.

export function describePlugin({ description, needs }) {
  return needs.length ? `${description} Needs: ${needs.map((need) => need.text).join(', ')}.` : `${description} Nothing to download.`
}

export function mountPluginSettings(root, registry, onSwitch, afterDraw = () => {}) {
  function draw() {
    root.replaceChildren(...registry.list().map((plugin) => {
      const row = document.createElement('label')
      row.className = 'setting-row'
      const name = document.createElement('span')
      const icon = document.createElement('i')
      icon.dataset.lucide = plugin.icon
      const text = document.createElement('span')
      text.className = 'row-text'
      const title = document.createElement('b')
      title.textContent = plugin.name
      const help = document.createElement('small')
      help.textContent = describePlugin(plugin)
      text.append(title, help)
      name.append(icon, text)
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.id = `plugin-${plugin.id}`
      box.checked = plugin.enabled
      box.addEventListener('change', async () => {
        box.disabled = true
        try { await onSwitch(plugin.id, box.checked) } catch { box.checked = !box.checked } finally { box.disabled = false }
      })
      row.append(name, box)
      return row
    }))
    afterDraw()
  }
  registry.onChange(draw)
  draw()
}
