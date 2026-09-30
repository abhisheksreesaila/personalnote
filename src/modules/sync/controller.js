import { agentFlagFor, describeAgentPresence, planChangeSync } from './changes.js'

/**
 * DOM-free heart of agent sync. `host` touches the canvas and API; `ui` shows
 * presence: setPresence(presence|null), setFlag(flag|null), showNotice(text).
 */
export function createAgentSyncController({ host, ui }) {
  async function syncActiveNote() {
    const active = host.getActive()
    if (!active || active.noteType !== 'canvas') return
    const note = await host.api(`/notes/${active.id}`)
    const current = host.getActive()
    if (!current || current.id !== active.id || note.revision <= current.revision) return
    if (host.hasUnsavedEdits()) {
      const added = await host.merge(note)
      // Nothing added means this was the user's own in-flight save: no notice.
      if (added > 0) ui.showNotice('New text from an agent was added next to your edits')
    } else {
      await host.reload(note)
    }
  }

  async function onUpdate(update) {
    const active = host.getActive()
    ui.setPresence(describeAgentPresence(update.agents))
    ui.setFlag(agentFlagFor(update.agents, active?.id))
    if (update.baseline) return
    if (!update.changes?.length && !update.overflow) return
    const plan = planChangeSync({
      changes: update.changes,
      overflow: update.overflow,
      activeResourceId: active?.resourceId,
      activeRevision: active?.revision ?? 0,
      hasUnsavedEdits: host.hasUnsavedEdits(),
    })
    if (plan.refreshLists) await host.refreshLists()
    if (plan.activeNote === 'deleted') ui.showNotice('This note was deleted elsewhere')
    else if (plan.activeNote !== 'none') await syncActiveNote()
  }

  function clearPresence() {
    ui.setPresence(null)
    ui.setFlag(null)
  }

  return { onUpdate, syncActiveNote, clearPresence }
}
