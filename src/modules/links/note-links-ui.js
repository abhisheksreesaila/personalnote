// A note dropped or picked into the open note (F-095), loaded the first time it is needed (never in the first load).
// host (main.js's `linkHost`): the app's state, the canvas and page being shown, and a few of the shell's own actions.
import { noteLinkMarkdown } from '../../core/note-links.js'

const NOTE_DRAG = 'application/x-personal-note' // what the notes panel's rows carry (shelves.js)
const dragsNote = (host, event) => !host.state.noteLocked && ['canvas', 'page'].includes(host.state.activeNoteType) && [...(event.dataTransfer?.types || [])].includes(NOTE_DRAG)

/** The note `noteId` becomes a card on the open canvas or a link in the open page. `at` is a drop's window point (none for a pick: the middle of the view, or the caret). */
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

const NARROW = '(max-width: 800px)' // chrome.css's phone layout: the notes panel covers the note
let watching = false
/** Once, when a note row is first dragged: the workspace takes the drop. On a narrow window the panel slides away when the row leaves it, so the note is under the finger. */
export function watchDrops(host) {
  if (watching) return
  watching = true
  const workspace = document.querySelector('#workspace')
  const sidebar = document.querySelector('#sidebar')
  const narrow = matchMedia(NARROW)
  workspace.addEventListener('dragover', (event) => {
    if (!dragsNote(host, event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    workspace.classList.add('is-drop-target')
  })
  workspace.addEventListener('drop', (event) => {
    workspace.classList.remove('is-drop-target')
    if (!dragsNote(host, event)) return
    event.preventDefault()
    linkNote(host, Number(event.dataTransfer.getData(NOTE_DRAG)), { clientX: event.clientX, clientY: event.clientY })
  })
  document.addEventListener('dragover', (event) => {
    if (narrow.matches && sidebar.classList.contains('open') && !sidebar.contains(event.target) && [...(event.dataTransfer?.types || [])].includes(NOTE_DRAG)) document.querySelector('#toggle-sidebar').click()
  })
}

/** "Link to a note…": the omnibar again, asking which note; the pick goes in like a drop. */
export function startLinking(host) {
  if (host.state.noteLocked || !['canvas', 'page'].includes(host.state.activeNoteType)) { host.toast('Notes can be linked into canvas and page notes'); return }
  host.openSearch()
  const input = document.querySelector('#search-input')
  const placeholder = input.placeholder
  host.omni.pick = Object.assign((noteId) => linkNote(host, noteId), { reset: () => { input.placeholder = placeholder } }) // (reset: the omnibar closes and asks for words again)
  host.omni.filter = 'Notes'
  input.placeholder = 'Link to which note?'
  host.renderOmni()
}
