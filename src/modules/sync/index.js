import './agent-flag.css'
import { createChangePoller } from './changes.js'
import { createAgentSyncController } from './controller.js'

/**
 * Keeps the open note in step with local agent writes and shows agent presence
 * (a face on the dynamic island plus a cursor flag over the block the agent is working on).
 * The host supplies everything that touches the canvas:
 *   api(path), island ({agentPresence(label|null), agentNotice(text)}), getActive() -> {id, resourceId, revision, noteType} | null,
 *   hasUnsavedEdits(), reload(note), merge(note) -> number of objects added,
 *   refreshLists(), locateFlagBlock(action) -> {x, y} in viewport pixels | null,
 *   onLayout(callback) to re-place the flag when the canvas re-renders or scrolls.
 */
export function mountAgentSync(host) {
  // The flag is a DOM overlay, never a canvas object, so it is not saved or printed.
  const flagElement = document.createElement('div')
  flagElement.className = 'agent-flag'
  flagElement.hidden = true
  flagElement.setAttribute('aria-hidden', 'true')
  document.body.append(flagElement)

  let flag = null

  function placeFlag() {
    const position = flag ? host.locateFlagBlock(flag.action) : null
    flagElement.hidden = !position
    if (!position) return
    flagElement.textContent = flag.label
    flagElement.dataset.action = flag.action
    flagElement.style.left = `${Math.round(position.x)}px`
    flagElement.style.top = `${Math.round(position.y - flagElement.offsetHeight - 4)}px`
  }

  const controller = createAgentSyncController({
    host,
    ui: {
      setPresence(next) {
        host.island.agentPresence(next?.label)
      },
      setFlag(next) {
        flag = next
        placeFlag()
      },
      showNotice(message) {
        host.island.agentNotice(message)
      },
    },
  })

  host.onLayout(() => {
    if (flag) placeFlag()
  })

  const poller = createChangePoller({
    fetchChanges: (since) => host.api(since === null ? '/changes' : `/changes?since=${since}`),
    onUpdate: controller.onUpdate,
    onError: controller.clearPresence,
    isVisible: () => document.visibilityState === 'visible',
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poller.pollNow()
    else controller.clearPresence()
  })
  poller.start()

  return { syncActiveNote: controller.syncActiveNote, pollNow: poller.pollNow, stop: poller.stop }
}
