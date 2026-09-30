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

// The revision the server last confirmed. It only moves forward and never by guessing: a failed save
// (for example a conflict with an agent's write) returns no result and leaves it unchanged.
//
// Limit: when the page closes while a save is still in flight, the close-time save is sent at once with
// the last confirmed revision. If the in-flight save lands first, the server rejects the close-time save
// with a conflict instead of overwriting anything, so edits made after the in-flight save can be lost.
export function confirmedRevision(current, result) {
  return Math.max(current ?? 0, result ?? 0)
}

/**
 * Sends what is pending and resolves once no save is in flight, for a host (the desktop window) that must
 * not stop the server before edits land. Resolves true when nothing is left unsaved.
 */
export async function settleSaves({ flushPending, isSaving, hasUnsaved, save, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  flushPending()
  while (isSaving()) await wait(15)
  if (hasUnsaved()) await save()
  while (isSaving()) await wait(15)
  return !hasUnsaved()
}
