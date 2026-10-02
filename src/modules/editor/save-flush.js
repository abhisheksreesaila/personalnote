// Edits are saved on a debounce, so a fast reload or tab close can land before they are sent.
// This flushes them when the page is hidden or closed.

// A keepalive request survives unload but is capped at 64 KiB; larger bodies go as a normal request,
// so a note over about 60 KiB is saved on close best-effort (the browser may cancel that request).
export const KEEPALIVE_LIMIT = 60 * 1024

export function canKeepAlive(body) {
  return typeof body === "string" && bodyBytes(body) <= KEEPALIVE_LIMIT
}

/** Runs `flush` on pagehide and when the page becomes hidden. Returns an unbind function. */
export function bindPageLifecycle({ windowTarget, documentTarget, flush }) {
  // `flush` gets the reason: only 'pagehide' means the page is really going away.
  const onHide = () => flush('pagehide')
  const onVisibility = () => {
    if (documentTarget.visibilityState === 'hidden') flush('hidden')
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

// A body longer than the keepalive limit in characters is longer in bytes: every caller only asks whether it fits, so a note of
// megabytes is not walked just to count them.
export const bodyBytes = (body) => (body.length > KEEPALIVE_LIMIT ? body.length : new TextEncoder().encode(body).length)

/**
 * Debounce delays for the Chromium app window, which has no pre-close hook and so saves sooner (about 250ms
 * after the last edit instead of 830ms). A note too big for a keepalive request keeps the normal delays: its
 * close-time save could not be sent anyway, and frequent large autosaves cost frames.
 */
export function createSaveTiming({ fast }) {
  let lastBytes = 0
  const useFast = () => fast && lastBytes <= KEEPALIVE_LIMIT
  return {
    saved: (body) => { lastBytes = bodyBytes(body) },
    saveDelay: () => (useFast() ? 150 : 650),
  }
}

/** The body of a note save: `contentJson` is the note's text, already JSON, joined in without being parsed or searched for. */
export function joinSaveBody(contentJson, fields) {
  const rest = JSON.stringify(fields)
  return `{"content":${contentJson}${rest === '{}' ? '}' : `,${rest.slice(1)}`}`
}
