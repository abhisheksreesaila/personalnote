// Whether the notes panel is open is remembered on this machine. Storage can be missing or blocked (WebKit web views), so every access is guarded.
const KEY = 'pn.notesPanelOpen'

export function loadPanelOpen(storage) {
  try { return storage?.getItem(KEY) === '1' } catch { return false }
}

export function savePanelOpen(storage, open) {
  try { storage?.setItem(KEY, open ? '1' : '0') } catch { /* the choice just is not remembered */ }
}
