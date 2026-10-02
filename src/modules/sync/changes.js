// Browser-side logic for noticing agent writes and presence. Pure functions plus a
// small poller with injectable timers so it can be tested without a browser.

export function planChangeSync({ changes = [], overflow = false, activeResourceId, activeRevision, hasUnsavedEdits }) {
  if (overflow) return { refreshLists: true, activeNote: 'check' }
  let refreshLists = false
  let activeNote = 'none'
  for (const change of changes) {
    const isActive = change.resourceKind === 'note' && change.resourceId === activeResourceId
    if (isActive && change.changeType !== 'deleted' && change.revision <= activeRevision) continue
    refreshLists = true
    if (!isActive) continue
    if (change.changeType === 'deleted') activeNote = 'deleted'
    else if (activeNote !== 'deleted') activeNote = hasUnsavedEdits ? 'merge' : 'reload'
  }
  return { refreshLists, activeNote }
}

export function describeAgentPresence(agents) {
  if (!Array.isArray(agents) || !agents.length) return null
  const chosen = agents.find((agent) => agent.action === 'writing') || agents[0]
  return {
    agent: chosen.agent,
    action: chosen.action,
    label: `${chosen.agent} is ${chosen.action}`,
    title: chosen.noteTitle || '',
  }
}

// The agent (if any) currently working on the open note, for the cursor flag.
export function agentFlagFor(agents, activeNoteId) {
  if (!Array.isArray(agents) || activeNoteId == null) return null
  const mine = agents.filter((agent) => agent.noteId === activeNoteId)
  const chosen = mine.find((agent) => agent.action === 'writing') || mine[0]
  if (!chosen) return null
  const name = String(chosen.agent || 'Agent').replace(/ Code$/, '')
  return { agent: chosen.agent, action: chosen.action, label: `${name} · ${chosen.action}` }
}

export function createChangePoller({
  fetchChanges,
  onUpdate,
  onError = () => {},
  isVisible = () => true,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (id) => clearTimeout(id),
  intervalMs = 2000,
}) {
  let since = null
  let timer = null
  let running = false
  let polling = false

  async function poll() {
    if (polling || !isVisible()) return
    polling = true
    try {
      const result = await fetchChanges(since)
      const baseline = since === null
      const wentBackwards = since !== null && result.sequence < since
      since = result.sequence
      await onUpdate({ ...result, baseline, overflow: Boolean(result.overflow) || wentBackwards })
    } catch (error) {
      onError(error)
    } finally {
      polling = false
    }
  }

  function arm(delay) {
    if (!running) return
    if (timer !== null) cancel(timer)
    timer = schedule(async () => {
      timer = null
      await poll()
      arm(intervalMs)
    }, delay)
  }

  return {
    start() {
      running = true
      arm(0)
    },
    stop() {
      running = false
      if (timer !== null) cancel(timer)
      timer = null
    },
    pollNow: poll,
  }
}
