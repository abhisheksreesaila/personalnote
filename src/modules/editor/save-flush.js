// Edits are saved on a debounce, so a fast reload or tab close can land before they are sent.
// This flushes them when the page is hidden or closed.

// A keepalive request survives unload but is capped at 64 KiB; larger bodies go as a normal request,
// so a note over about 60 KiB is saved on close best-effort (the browser may cancel that request).
export const KEEPALIVE_LIMIT = 60 * 1024

export function canKeepAlive(body) {
  return typeof body === 'string' && new TextEncoder().encode(body).length <= KEEPALIVE_LIMIT
}

/** Runs `flush` on pagehide and when the page becomes hidden. Returns an unbind function. */
export function bindPageLifecycle({ windowTarget, documentTarget, flush }) {
  const onHide = () => flush()
  const onVisibility = () => {
    if (documentTarget.visibilityState === 'hidden') flush()
  }
  windowTarget.addEventListener('pagehide', onHide)
  documentTarget.addEventListener('visibilitychange', onVisibility)
  return () => {
    windowTarget.removeEventListener('pagehide', onHide)
    documentTarget.removeEventListener('visibilitychange', onVisibility)
  }
}

// An unload save sent while another save is still in flight cannot wait for that save's response.
// The in-flight request will bump the note to inFlightRevision + 1, so this one builds on that.
export function revisionForUnloadSave({ inFlightRevision, noteRevision }) {
  if (inFlightRevision == null) return noteRevision
  return Math.max(noteRevision, inFlightRevision + 1)
}
