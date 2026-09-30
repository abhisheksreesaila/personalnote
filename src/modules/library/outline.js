// What the sidebar shows: notebooks grouped by PARA category, and the Inbox of recent notes.

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

// Newest first across every notebook; the server already sorts, this keeps the view correct if it did not.
export function inboxNotes(notes, limit = 6) {
  return [...notes]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit)
}

export function modifierLabel(platform = '') {
  return /mac|iphone|ipad/i.test(platform) ? '⌘' : 'Ctrl'
}

// Ctrl/⌘+N belongs to the browser, so a page never receives it. Alt/Option+N is free in every major
// browser and OS; matching the physical key keeps it working where Option+N types a dead key.
export function isQuickNoteShortcut(event) {
  return event.code === 'KeyN' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
}

export function quickNoteKeycap(platform = '') {
  return modifierLabel(platform) === '⌘' ? '⌥N' : 'Alt N'
}
