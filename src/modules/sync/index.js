import './agent-chip.css'
import { createChangePoller, describeAgentPresence, planChangeSync } from './changes.js'

const NOTICE_MS = 7000

/**
 * Keeps the open note in step with local agent writes and shows agent presence.
 * The host supplies everything that touches the canvas, so this module stays small:
 *   api(path), saveStateElement, getActive() -> {id, resourceId, revision, noteType} | null,
 *   hasUnsavedEdits(), reload(note), merge(note) -> number of objects added,
 *   refreshLists()
 */
export function mountAgentSync(host) {
  const chip = document.createElement('div')
  chip.className = 'agent-chip'
  chip.id = 'agent-chip'
  chip.hidden = true
  chip.setAttribute('role', 'status')
  chip.setAttribute('aria-live', 'polite')
  host.saveStateElement.before(chip)

  let notice = ''
  let noticeTimer
  let presence = null

  function renderChip() {
    const text = notice || presence?.label || ''
    chip.hidden = !text
    chip.textContent = text
    chip.title = notice ? '' : presence?.title || ''
    chip.classList.toggle('is-notice', Boolean(notice))
    chip.dataset.action = notice ? 'notice' : presence?.action || ''
  }

  function showNotice(message) {
    notice = message
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => {
      notice = ''
      renderChip()
    }, NOTICE_MS)
    renderChip()
  }

  async function syncActiveNote() {
    const active = host.getActive()
    if (!active || active.noteType !== 'canvas') return
    const note = await host.api(`/notes/${active.id}`)
    const current = host.getActive()
    if (!current || current.id !== active.id || note.revision <= current.revision) return
    if (host.hasUnsavedEdits()) {
      const added = await host.merge(note)
      showNotice(added ? 'New text from an agent was added next to your edits' : 'This note changed elsewhere; your edits are kept')
    } else {
      await host.reload(note)
    }
  }

  async function onUpdate(update) {
    presence = describeAgentPresence(update.agents)
    renderChip()
    if (update.baseline) return
    const active = host.getActive()
    const plan = planChangeSync({
      changes: update.changes,
      overflow: update.overflow,
      activeResourceId: active?.resourceId,
      activeRevision: active?.revision ?? 0,
      hasUnsavedEdits: host.hasUnsavedEdits(),
    })
    if (plan.refreshLists) await host.refreshLists()
    if (plan.activeNote === 'deleted') showNotice('This note was deleted elsewhere')
    else if (plan.activeNote !== 'none') await syncActiveNote()
  }

  const poller = createChangePoller({
    fetchChanges: (since) => host.api(since === null ? '/changes' : `/changes?since=${since}`),
    onUpdate,
    onError: () => {
      presence = null
      renderChip()
    },
    isVisible: () => document.visibilityState === 'visible',
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poller.pollNow()
    else {
      presence = null
      renderChip()
    }
  })
  poller.start()

  return { syncActiveNote, pollNow: poller.pollNow, stop: poller.stop }
}
