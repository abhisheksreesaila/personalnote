// The Jam sessions plugin (F-092, ADR 0007): talk an idea through and Claude grows the mind map. The shell imports this file only while Jam is on
// (and Mind maps and Voice are on too). Activating adds "New jam" to the new-note menu and the omnibar; a map opened in jam mode gets the island's
// jam face (the live line and Jam) and the mic's words. `dispose()` takes all of it away; the maps made stay ordinary mind-map notes.
//
// Each Jam press is one request to the brain chosen in Settings → AI, carrying that map and the words said since the last turn (ADR 0007). The
// map is changed only by the editor's own `applyJam`, which adds and reacts, never removes, renames or moves, as one undo step.
import { createJamSession } from './jam-session.js'

const NEW_JAM = 'New jam'

export async function activateJam(shell) {
  const { api, island, elements } = shell
  const mic = [document.querySelector('#voice-divider'), document.querySelector('#voice-button')]
  let session = null
  let editor = null

  const requestTurn = async (body) => {
    try {
      return (await api('/jam/turn', { method: 'POST', body: JSON.stringify(body), timeout: 120000 })).edits // (a model call takes seconds; the server gives up at 90)
    } catch (error) {
      throw Object.assign(error, { setup: error.body?.setup === true })
    }
  }

  function detach() {
    session?.dispose()
    session = null
    editor = null
    shell.voiceSink = null
    elements.shell.classList.remove('jam-active')
    elements.dockCanvas.append(...mic) // (the mic goes home to the canvas tools)
    island.model.jam(null)
  }

  // The open mind map changed (a note opened or closed): a jam map gets a session, anything else gets nothing.
  function attach(next) {
    if (next && next === editor) return
    detach()
    if (!next?.isJam()) return
    editor = next
    session = createJamSession({
      getMap: () => editor.getDocument(),
      getGhosts: () => editor.ghosts(),
      requestTurn,
      applyEdits: (edits) => editor.applyJam(edits),
      answerGhost: (id, yes) => editor.answerGhost(id, yes),
      onFace: (face) => island.model.jam(face),
    })
    shell.voiceSink = { heard: (text, options) => session.heard(text, options), listening: (on) => session.listening(on) } // the mic's words come here, not into a text box
    elements.shell.classList.add('jam-active') // (shows the mic on a map)
    elements.mindmapRailActions.append(...mic) // (a map has no canvas tools: the mic joins the map's own, at the bottom of the island)
    session.start()
  }

  async function newJam() {
    await shell.createNote(shell.state.selectedNotebookId ?? undefined, 'mindmap', NEW_JAM)
    const made = shell.mindmapEditor()
    if (!made) return
    made.startJam(NEW_JAM)
    attach(made)
  }

  const removeEntry = shell.addEntry({ id: 'new-jam', label: NEW_JAM, icon: 'sparkles', keywords: 'brainstorm talk mind map claude', run: () => newJam() })
  attach(shell.mindmapEditor())

  return {
    attach,
    newJam,
    onIslandAction(action) {
      if (action === 'jam') void session?.jam()
      else if (action === 'jam-setup') {
        shell.setPropertiesOpen(true)
        document.querySelector('#properties-panel').dispatchEvent(new CustomEvent('settings-show', { detail: 'ai' }))
        document.querySelector('#ai-settings')?.scrollIntoView?.({ block: 'center' })
      }
    },
    async dispose() {
      if (shell.state.listening) await shell.voice()?.stopForSwitch() // (the mic stops before its words lose their place to go)
      removeEntry()
      detach()
    },
  }
}
