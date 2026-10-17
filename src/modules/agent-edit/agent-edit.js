// Show and Undo on "Claude edited this note" (F-096). Loaded the first time a change from outside reaches the open note, never in the first load.
// `host` is main.js's `linkHost`: state, api, island (the model), settle() (the person's unsaved words go out first), sync() (fetch the note
// as it is now and show it, merging into any unsaved words), page (the page editor), toast, and the canvas's geometry and glide.
import { changedBoxes, onScreen, viewForBoxes } from './show.js'

const CSS = `
.agent-mark { position: fixed; z-index: 40; pointer-events: none; box-sizing: border-box; border: 2px solid var(--sk-accent, #b86b4b); border-radius: 10px; background: color-mix(in srgb, var(--sk-accent, #b86b4b) 14%, transparent); box-shadow: 0 0 0 5px color-mix(in srgb, var(--sk-accent, #b86b4b) 22%, transparent); }
@media print { .agent-mark { display: none; } }
`
const MARK_MS = 1800
const GLIDE_MS = 360 // (a little after the view's own glide ends)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const first = (name) => String(name || 'Agent').replace(/ Code$/, '')

let current = null // the edit on offer: { noteId, edit }

function mark(rects) {
  if (!document.getElementById('agent-mark-style')) document.head.append(Object.assign(document.createElement('style'), { id: 'agent-mark-style', textContent: CSS }))
  for (const rect of rects) {
    const node = document.createElement('div')
    node.className = 'agent-mark'
    node.setAttribute('aria-hidden', 'true')
    Object.assign(node.style, { left: `${rect.left - 4}px`, top: `${rect.top - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px` })
    document.body.append(node)
    const gone = () => node.remove()
    if (node.animate) node.animate([{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: MARK_MS }).onfinish = gone
    else setTimeout(gone, MARK_MS)
  }
}

/** A change from outside reached the open note: if an agent made that revision, offer Show and Undo on the island. */
export async function announce(host, note) {
  if (note.id !== host.state.activeNoteId) return
  const { edit } = await host.api(`/notes/${note.id}/agent-edit?revision=${note.revision}`).catch(() => ({}))
  if (!edit || edit.state !== 'applied' || note.id !== host.state.activeNoteId) return
  current = { noteId: note.id, edit }
  host.island.agentNotice(`${first(edit.agent)} edited`, { wide: ' this note', actions: [['agent-show', 'Show'], ['agent-undo', 'Undo']] })
}

async function show(host, { changed }) {
  if (changed.kind === 'page') {
    const rect = await host.page?.revealRange(changed.from, changed.to)
    if (rect) mark([rect])
    return
  }
  const geometry = host.canvasGeometry()
  const boxes = changedBoxes(geometry.objects, changed.ids)
  if (!boxes.length) return // (it only took things away: nothing to point at)
  host.glide(viewForBoxes(boxes, { width: geometry.size.width, height: geometry.size.height, scale: geometry.view.scale, base: geometry.base }))
  await wait(GLIDE_MS)
  const now = host.canvasGeometry()
  mark(boxes.map((box) => onScreen(box, now.origin, now.view)))
}

// Undo and Redo: the person's own words go out first, the server turns the agent's revision over whatever is stored (their later edits stay),
// and the note on screen follows. If they changed the same words since, nothing happens and they are told why.
async function turn(host, direction) {
  const { noteId, edit } = current
  host.island.agentNotice(null)
  if (noteId !== host.state.activeNoteId) return
  try {
    await host.settle()
    await host.api(`/agent-edits/${edit.id}/${direction}`, { method: 'POST' })
    await host.sync()
    const undid = direction === 'undo'
    host.island.agentNotice(undid ? `Undid ${first(edit.agent)}’s edit` : `Put ${first(edit.agent)}’s edit back`, { actions: [undid ? ['agent-redo', 'Redo'] : ['agent-undo', 'Undo']] })
  } catch (error) {
    // The island says it in a few words (it is small); the toast has the server's plain sentence.
    host.island.agentNotice(error.status === 409 ? `Can’t ${direction}: you changed it since` : `Couldn’t ${direction}`, { ms: 6000 })
    host.toast(error.message)
  }
}

export function act(host, action) {
  if (!current) return
  if (action === 'agent-show') return show(host, current.edit)
  return turn(host, action === 'agent-redo' ? 'redo' : 'undo')
}
