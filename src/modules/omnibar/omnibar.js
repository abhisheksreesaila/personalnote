// The omnibar's logic with no page in it (F-072): what a query finds, in which groups, and how the selection moves.
// main.js owns the data (notes, notebooks, the word search) and the actions; this turns them into groups of rows.

export const FILTERS = ['All', 'Notes', 'Notebooks', 'Actions']
const RECENT_WHEN_ALL = 4
const RECENT_WHEN_NOTES = 8
const TITLE_LIMIT = 8
const MEANING_LIMIT = 5 // the server already keeps only the notes close enough in meaning (services.py MEANING_FLOOR); this is how many rows show

export function queryTokens(query) {
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

const matchesAll = (text, tokens) => tokens.every((token) => String(text ?? '').toLowerCase().includes(token))

export function highlight(text, tokens) {
  const escape = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
  const source = String(text ?? '')
  if (!tokens.length) return escape(source)
  const pattern = new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|'), 'gi')
  let html = ''
  let last = 0
  for (const match of source.matchAll(pattern)) {
    html += `${escape(source.slice(last, match.index))}<mark>${escape(match[0])}</mark>`
    last = match.index + match[0].length
  }
  return html + escape(source.slice(last))
}

export function moveSelection(index, delta, count) {
  if (count <= 0) return 0
  return (((index + delta) % count) + count) % count
}

export const flatten = (groups) => groups.flatMap((group) => group.items)

const PILL_OF = { notebook: 'Notebooks', action: 'Actions' }
/** How many notes, notebooks and actions the groups hold (the filter pills' numbers; the New note row is not a result). */
export function filterCounts(groups) {
  const counts = { Notes: 0, Notebooks: 0, Actions: 0 }
  for (const item of flatten(groups)) if (item.kind !== 'create') counts[PILL_OF[item.kind] ?? 'Notes']++
  return counts
}

const stamp = (value) => new Date(/Z$/.test(value) ? value : `${String(value).replace(' ', 'T')}Z`) // (the database writes UTC with no zone)
/** "Sep 3", with the year when it is not this one. */
export function shortDate(value, now = Date.now()) {
  const then = stamp(value)
  return Number.isNaN(+then) ? '' : then.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(then.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) })
}
/** "2 h ago", a weekday inside the last week, then the date. */
export function relativeTime(value, now = Date.now()) {
  const then = value ? stamp(value) : null
  if (!then || Number.isNaN(+then)) return ''
  const minutes = Math.floor((now - then) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`
  return minutes < 10080 ? then.toLocaleDateString('en', { weekday: 'short' }) : shortDate(value, now)
}

// A secure note is found by its title only, so its row never carries words.
function noteItem(note, notebooks, extra = {}) {
  const notebook = notebooks.find((item) => item.id === note.notebookId)
  return {
    kind: 'note', id: note.id, resourceId: note.resourceId, title: note.title || 'Untitled note', noteType: note.noteType, secure: Boolean(note.secure), excerpt: '',
    icon: note.icon, updatedAt: note.updatedAt, createdAt: note.createdAt,
    notebookName: notebook?.name || note.notebookName || 'Inbox', notebookColor: notebook?.color || note.notebookColor || '', ...extra,
  }
}
const notebookItem = (notebook) => ({ kind: 'notebook', id: notebook.id, name: notebook.name, color: notebook.color, icon: notebook.icon, category: notebook.category, noteCount: notebook.noteCount ?? 0 })
const actionItem = (action) => ({ kind: 'action', ...action })

/**
 * Groups for the panel. `wordHits` are the results of the word search (title + words, as the server sends them);
 * `meaningHits` are the notes closest in meaning, best first (F-080): they go last, as "By meaning", without repeating a note shown above.
 * When nothing else matches (and the word search is not still out) the list ends with a "New note" row, so Enter always does something.
 * `filter` is one of FILTERS. Nothing here touches the page.
 */
export function buildGroups({ query, filter = 'All', notes = [], notebooks = [], actions = [], wordHits = [], meaningHits = [], wordsPending = false }) {
  const tokens = queryTokens(query)
  const want = (name) => filter === 'All' || filter === name
  const groups = []
  const add = (key, label, items) => { if (items.length) groups.push({ key, label, items }) }

  if (!tokens.length) {
    if (want('Notes')) add('recent', 'Recent', notes.slice(0, filter === 'Notes' ? RECENT_WHEN_NOTES : RECENT_WHEN_ALL).map((note) => noteItem(note, notebooks)))
    if (filter === 'Notebooks') add('notebooks', 'Notebooks', notebooks.map(notebookItem))
    if (want('Actions')) add('actions', 'Actions', (filter === 'All' ? actions.filter((action) => action.top) : actions).map(actionItem))
    return groups
  }

  const known = new Map(notes.map((note) => [note.id, note]))
  const byTitle = notes.filter((note) => matchesAll(note.title || 'Untitled note', tokens)).slice(0, TITLE_LIMIT)
  const taken = new Set(byTitle.map((note) => note.id))
  const snippets = new Map(wordHits.map((hit) => [hit.id, hit.excerpt]))
  const titleItems = byTitle.map((note) => noteItem(note, notebooks, { excerpt: note.secure ? '' : snippets.get(note.id) || '' }))
  const wordItems = []
  for (const hit of wordHits) {
    if (taken.has(hit.id)) continue
    const note = { ...hit, ...(known.get(hit.id) ?? {}) }
    const excerpt = note.secure ? '' : hit.excerpt || ''
    taken.add(hit.id)
    if (excerpt) wordItems.push(noteItem(note, notebooks, { kind: 'words', excerpt }))
    else titleItems.push(noteItem(note, notebooks))
  }
  if (want('Notes')) {
    add('notes', 'Notes', titleItems)
    add('words', 'In your words', wordItems)
  }
  if (want('Notebooks')) add('notebooks', 'Notebooks', notebooks.filter((notebook) => matchesAll(notebook.name, tokens)).map(notebookItem))
  if (want('Actions')) add('actions', 'Actions', actions.filter((action) => matchesAll(`${action.title} ${action.keywords ?? ''}`, tokens)).map(actionItem))
  if (filter === 'All' || filter === 'Notes') {
    const meaningItems = []
    for (const hit of meaningHits) {
      const note = known.get(hit.id)
      if (!note || note.secure || taken.has(hit.id)) continue // a note the page does not know was deleted; a secure one is found by title only
      meaningItems.push(noteItem(note, notebooks, { kind: 'meaning' }))
      if (meaningItems.length === MEANING_LIMIT) break
    }
    add('meaning', 'By meaning', meaningItems)
    if (!wordsPending && !groups.some((group) => group.key !== 'meaning')) groups.push({ key: 'create', label: '', items: [{ kind: 'create', title: query.trim() }] })
  }
  return groups
}
