// The dynamic island's brain (F-084): which face it wears. Pure state; the DOM lives in island.js. Nothing runs at rest: the only
// timers are one-shot ones that exist while a moment is on (the 3 s wait before "Saving", and the moment that fades back).
export const SLOW_SAVE_MS = 3000
export const SAVED_MS = 1200
export const ADDED_MS = 1500
export const READY_MS = 1500
export const NOTICE_MS = 4000

/**
 * Priority, highest first: focus, the open card, a save error, recording, a short flash (Saved, Added N words, is ready),
 * a download, an agent, a slow save, then rest. `onChange(face, patch)` fires only when the face changes; `patch` is true when
 * it is the same kind with new numbers (a download's percent), so the view updates in place instead of measuring again.
 */
export function createIslandModel({ schedule = setTimeout, cancel = clearTimeout, onChange = () => {} } = {}) {
  const s = { focus: false, card: false, error: null, recording: null, flash: null, download: null, presence: null, notice: null, sending: false, slow: false }
  const timers = { slow: 0, flash: 0, notice: 0 }
  let shown = { kind: 'rest' }
  let shownKey = JSON.stringify(shown)

  function face() {
    if (s.focus) return { kind: 'focus' }
    if (s.card) return { kind: 'card' }
    if (s.error) return { kind: 'error', message: s.error.message, retry: s.error.retry }
    if (s.recording) return { kind: 'recording', startedAt: s.recording.startedAt }
    if (s.flash) return s.flash
    if (s.download) return { kind: 'download', name: s.download.name, percent: s.download.percent }
    if (s.notice || s.presence) return { kind: 'agent', label: s.notice || s.presence }
    if (s.slow) return { kind: 'saving' }
    return { kind: 'rest' }
  }
  function emit() {
    const next = face()
    const key = JSON.stringify(next)
    if (key === shownKey) return
    const patch = next.kind === shown.kind
    shown = next
    shownKey = key
    onChange(next, patch)
  }
  function flash(face, ms) {
    cancel(timers.flash)
    s.flash = face
    timers.flash = schedule(() => { s.flash = null; emit() }, ms)
    emit()
  }

  return {
    face,
    card(open) { s.card = open; emit() },
    focus(on) { s.focus = on; emit() },
    // A save has gone out. It only becomes a moment if it is still out after 3 s.
    saveSending() {
      s.sending = true
      if (!timers.slow && !s.slow) timers.slow = schedule(() => { timers.slow = 0; if (s.sending) { s.slow = true; emit() } }, SLOW_SAVE_MS)
    },
    saveDone() {
      const announce = s.slow || Boolean(s.error)
      cancel(timers.slow)
      timers.slow = 0
      Object.assign(s, { sending: false, slow: false, error: null })
      if (announce) flash({ kind: 'saved' }, SAVED_MS)
      else emit()
    },
    saveFailed(message, retry = false) {
      cancel(timers.slow)
      timers.slow = 0
      Object.assign(s, { sending: false, slow: false, error: { message, retry } })
      emit()
    },
    recording(on, arg) {
      if (on) { s.recording = { startedAt: arg }; emit(); return }
      s.recording = null
      if (arg > 0) flash({ kind: 'added', words: arg }, ADDED_MS)
      else emit()
    },
    agentPresence(label) { s.presence = label || null; emit() },
    agentNotice(label) {
      cancel(timers.notice)
      s.notice = label
      timers.notice = schedule(() => { s.notice = null; emit() }, NOTICE_MS)
      emit()
    },
    download(key, name, percent) { s.download = { key, name, percent }; emit() },
    downloadEnd(key, ready) {
      if (s.download?.key !== key) return
      const { name } = s.download
      s.download = null
      if (ready) flash({ kind: 'ready', name }, READY_MS)
      else emit()
    },
  }
}
