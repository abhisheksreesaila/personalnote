// What the sidebar shows: notebooks grouped by PARA category, and the Inbox of unfiled notes.

export const CATEGORIES = ['projects', 'areas', 'resources', 'archive']
const LABELS = { projects: 'Projects', areas: 'Areas', resources: 'Resources', archive: 'Archive' }

export function categoryLabel(category) {
  return LABELS[category] || LABELS.projects
}

function categoryOf(notebook) {
  return CATEGORIES.includes(notebook.category) ? notebook.category : 'projects'
}

export function outline(notebooks, notes) {
  const counts = new Map()
  for (const note of notes) counts.set(note.notebookId, (counts.get(note.notebookId) || 0) + 1)
  return CATEGORIES.map((id) => ({
    id,
    label: LABELS[id],
    notebooks: notebooks
      .filter((notebook) => categoryOf(notebook) === id)
      .map((notebook) => ({ ...notebook, count: counts.get(notebook.id) || 0 })),
  }))
}

// The Inbox: notes with no notebook yet, newest first. Filing a note takes it out of here.
export function inboxNotes(notes) {
  return notes
    .filter((note) => note.notebookId == null)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

// A copy of the notebooks with one moved to another PARA section (the server call is update_notebook).
export function moveNotebookToCategory(notebooks, notebookId, category) {
  if (!CATEGORIES.includes(category)) return notebooks
  return notebooks.map((notebook) => (notebook.id === notebookId ? { ...notebook, category } : notebook))
}

// Which sections are folded is kept on this machine. Storage can be missing or throw (private mode, some web views), so nothing here may.
export const FOLD_KEY = 'personal-note-folded-sections'

export const NOTEBOOK_FOLD_KEY = 'personal-note-open-notebooks' // the same shape for notebooks: { notebookId: isOpen }

export function readFolded(storage, key = FOLD_KEY) { // -> { sectionId: isOpen }
  try {
    const value = JSON.parse(storage?.getItem(key) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export function writeFolded(storage, open, key = FOLD_KEY) {
  try { storage?.setItem(key, JSON.stringify(open)) } catch {}
}

// `open` maps a section id to whether it is open. Until the person chooses, every section is open except the Archive.
export function isSectionOpen(open, id) {
  return typeof open[id] === 'boolean' ? open[id] : id !== 'archive'
}

export function modifierLabel(platform = '') {
  return /mac|iphone|ipad/i.test(platform) ? '⌘' : 'Ctrl'
}

// Ctrl/⌘+N belongs to the browser, so a page never receives it. Alt/Option+N is free in every major
// browser and OS; matching the physical key keeps it working where Option+N types a dead key.
export function isQuickNoteShortcut(event, { blocked = false } = {}) {
  // While typing, Option+N is the dead key for n-with-tilde on Mac layouts, so it must reach the field.
  if (blocked) return false
  return event.code === 'KeyN' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
}

export function quickNoteKeycap(platform = '') {
  return modifierLabel(platform) === '⌘' ? '⌥N' : 'Alt N'
}
