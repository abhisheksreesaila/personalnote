// Font preferences in localStorage. Some web views (WebKitGTK in private mode, Safari with site data
// blocked) have no usable localStorage; that must never stop the notebook from loading.
export const PREFERENCES_KEY = 'personal-note.preferences.v1'
export const FONT_FAMILIES = new Set(['Source Serif 4', 'IBM Plex Sans', 'monospace'])

export function browserStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function attempt(action) {
  try {
    return action()
  } catch {
    return undefined
  }
}

export function readPreferences(storage = browserStorage()) {
  if (!storage) return {}
  const raw = attempt(() => storage.getItem(PREFERENCES_KEY))
  if (!raw) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    attempt(() => storage.removeItem(PREFERENCES_KEY))
    return {}
  }
  const result = {}
  if (FONT_FAMILIES.has(parsed?.fontFamily)) result.fontFamily = parsed.fontFamily
  const fontSize = Number(parsed?.fontSize)
  if (Number.isFinite(fontSize)) result.fontSize = Math.min(72, Math.max(12, Math.round(fontSize)))
  if (parsed?.speedMeter === true) result.speedMeter = true
  return result
}

export function writePreferences(storage = browserStorage(), preferences) {
  if (!storage) return
  attempt(() => storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)))
}
