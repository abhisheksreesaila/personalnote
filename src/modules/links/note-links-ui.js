// A note dropped or picked into the open note (F-095), loaded the first time it is needed (never in the first load).
// host: { state, canvas, page, center, toast }; `at` is the drop's window point (none for a pick: the middle of the view, or the caret).
import { noteLinkMarkdown } from '../../core/note-links.js'

export function linkNote(host, noteId, at) {
  const { state } = host
  const note = state.notes.find((item) => item.id === noteId)
  if (!note) return false
  if (note.id === state.activeNoteId) { host.toast("A note can't link to itself"); return false }
  if (state.activeNoteType === 'canvas') {
    const point = at ? host.canvas.pageAt(at.clientX, at.clientY) : host.center
    host.pickTool() // (the card is selected: the select tool moves it)
    return host.canvas.addNoteLink(point, { ref: note.resourceId, title: note.title || 'Untitled note' })
  }
  if (state.activeNoteType === 'page' && host.page) return host.page.insertNoteLink(noteLinkMarkdown(note.resourceId, note.title), at)
  host.toast('Notes can be linked into canvas and page notes')
  return false
}
