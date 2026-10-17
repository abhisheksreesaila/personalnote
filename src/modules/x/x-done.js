// "Done" on an X bookmark (F-095): one click files the open bookmark into the Archive notebook "X bookmarks done" (archived, never deleted), with
// Undo. Loaded only when a bookmark is open. host: { api, state, parent, settle(), refresh(), moveNote(id, notebookId), toast(message, label, run) }.
const CSS = `
.x-done { height: 44px; padding: 0 18px; border-radius: 22px; font: inherit; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.x-done[hidden] { display: none; }
.x-done:disabled { opacity: .6; cursor: default; }
@media (max-width: 800px) { .x-done { height: 40px; padding: 0 14px; } }
`

export function mountXDone(host) {
  const style = document.createElement('style')
  style.textContent = CSS
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'x-done glass-button'
  button.hidden = true
  button.title = 'Done with this bookmark: file it in the Archive'
  button.innerHTML = '<i data-lucide="check"></i><span>Done</span>'
  document.head.append(style)
  host.parent.prepend(button)
  host.refreshIcons?.()
  let noteId = null

  button.addEventListener('click', async () => {
    const id = noteId
    const note = host.state.notes.find((item) => item.id === id)
    if (id === null || !note) return
    const from = note.notebookId ?? null
    button.disabled = true
    try {
      await host.settle()
      const result = await host.api(`/notes/${id}/x-done`, { method: 'POST' })
      Object.assign(note, { revision: result.revision, notebookId: result.notebookId })
      if (id === host.state.activeNoteId) host.state.selectedNotebookId = result.notebookId
      await host.refresh()
      host.toast('Done. Archived in “X bookmarks done”', 'Undo', () => void host.moveNote(id, from))
    } catch (error) {
      console.error(error)
      host.toast("Couldn't mark it done. Try again.")
    } finally { button.disabled = false }
  })

  return {
    // The bookmark now open (its id), or null when the open note is not a bookmark that is still to do.
    show(id) { noteId = id; button.hidden = id === null },
  }
}
