// What a mind map looks like while Mind maps is switched off (F-090): its words as an outline and one button to turn the plugin back on.
// It never imports the editor, so a switched-off plugin loads nothing. Text goes in as text, never as HTML.

// [{ text, children }] from the map's nodes: a node whose parent is missing is not shown, and each node is shown once.
export function mapOutline(doc) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes.filter((node) => node && typeof node === 'object') : []
  const byParent = new Map()
  for (const node of nodes) byParent.set(node.parentId ?? null, [...(byParent.get(node.parentId ?? null) ?? []), node])
  const seen = new Set()
  const build = (parentId) => (byParent.get(parentId) ?? [])
    .filter((node) => !seen.has(node.id) && seen.add(node.id))
    .map((node) => ({ text: String(node.text ?? ''), children: build(node.id) }))
  return build(null)
}

function list(items) {
  const ul = document.createElement('ul')
  for (const item of items) {
    const li = document.createElement('li')
    li.append(item.text)
    if (item.children.length) li.append(list(item.children))
    ul.append(li)
  }
  return ul
}

export function renderMindMapReadOnly(host, doc, { turnOn }) {
  const note = document.createElement('p')
  note.className = 'portability-help'
  note.setAttribute('role', 'status')
  note.textContent = 'Mind maps is switched off, so this map is read-only. Turn on Mind maps to edit.'
  const button = document.createElement('button')
  button.type = 'button'
  button.id = 'mindmap-turn-on'
  button.textContent = 'Turn on Mind maps'
  button.addEventListener('click', () => { button.disabled = true; turnOn() })
  const actions = document.createElement('div')
  actions.className = 'portability-actions'
  actions.append(button)
  const view = document.createElement('div')
  view.className = 'mindmap-readonly'
  view.append(note, actions, list(mapOutline(doc)))
  host.replaceChildren(view)
  host.classList.add('readonly')
  return { destroy() { host.replaceChildren(); host.classList.remove('readonly') } }
}
