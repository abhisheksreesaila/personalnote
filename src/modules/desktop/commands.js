// The page side of the native menu bar: desktop.py calls window.personalNote.command(name).
// COMMAND_NAMES is the contract with desktop_menu.py (tests check both sides); unknown names and failing handlers are ignored so a
// menu click can never break the page.
export const COMMAND_NAMES = Object.freeze([
  'new-note', 'quick-note', 'export-backup', 'export-markdown', 'print', 'settings',
  'undo', 'redo', 'zoom-in', 'zoom-out', 'zoom-fit',
  'skin-crayon', 'skin-paper', 'skin-night', 'speed-meter', 'speed-test',
])

export function createCommandDispatcher(handlers = {}) {
  return function command(name) {
    if (!Object.hasOwn(handlers, name)) return false
    try {
      handlers[name]()
      return true
    } catch (error) {
      console.error('Menu command failed', name, error)
      return false
    }
  }
}

// Undo/Redo from the Edit menu: text being edited keeps its own native history; otherwise the note's.
export function runHistoryCommand(name, { doc = globalThis.document, noteHistory }) {
  const active = doc?.activeElement
  const typing = ['INPUT', 'TEXTAREA'].includes(active?.tagName) || active?.isContentEditable
  if (typing && typeof doc.execCommand === 'function') return doc.execCommand(name)
  return noteHistory(name)
}
