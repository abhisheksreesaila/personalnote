/**
 * Finalizes debounced typing before an immediate editor action mutates the document.
 * This preserves the typed document as its own undo checkpoint.
 */
export function flushPendingHistory({ cancel, commit }) {
  cancel()
  return commit()
}
