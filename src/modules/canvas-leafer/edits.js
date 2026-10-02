// Edits on the open Leafer note (F-030): the engine-independent history (core/document/history.js) plus the one callback that puts a
// new document on screen and saves it. Pure JS (no Leafer, no DOM), so it is tested in Node; main.js supplies `onChange`.
//
// What later tickets call (F-028 select/move/transform/delete, F-029 text, F-031 ink, ...):
//   edits.record({ label, changes: [{ id, before, after }], page?, selection? }, { coalesce? })   one undo step
//     page: { before, after, shift? }: the page grid changed; `shift` is the distance every object moved when pages were added or folded on
//     the top or left, and `viewShift` (not stored) the part of it the view has not followed yet
//   edits.begin('Move') ... edits.record(...) per pointer move ... edits.end()                   a drag is one step
//   edits.deleteObjects(ids)                                                                       one step, connectors included
//   edits.undo() / edits.redo()                                                                    what Cmd/Ctrl+Z and the buttons call
//   edits.remote(noteId, doc)                                                                      an agent/sync merge: not undoable
// `onChange(doc, { kind, changed, page, pageShift, viewShift, selection })` runs after every edit, undo and redo with the new document. `selection` is
// the object ids that should be selected afterwards (undo: what the step restored or the selection it began with).
import { createHistory } from '../../core/document/history.js'
import { planRemove } from '../../core/document/operations.js'

export function createLeaferEdits({ onChange = () => {} } = {}) {
  let history = null
  let noteId = null

  const changed = (kind, info = {}) => onChange(history.doc, { kind, changed: [], page: false, pageShift: null, viewShift: null, selection: [], ...info })
  const live = () => (history ? history : null)

  function wrap(kind) {
    const result = history?.[kind]() ?? null
    if (result) changed(kind, { changed: result.changed, page: result.page, pageShift: result.pageShift, viewShift: result.pageShift, selection: result.selection })
    return result
  }

  return {
    // A note was opened (or re-opened): a new base and an empty history.
    open(id, doc) {
      noteId = id
      history = createHistory({ doc })
    },
    // The same note again with newer content (the agent wrote): a new base, and the history stays as it is. Another note: open().
    remote(id, doc) {
      if (!history || id !== noteId) return this.open(id, doc)
      history.mergeRemote(doc)
    },
    get noteId() { return noteId },
    get doc() { return history?.doc ?? null },
    get canUndo() { return Boolean(history?.canUndo) },
    get canRedo() { return Boolean(history?.canRedo) },
    stats: () => history?.stats() ?? { undoSteps: 0, redoSteps: 0, bytes: 0 },
    record(op, options) {
      if (!live()) return null
      const { viewShift, ...stored } = op
      history.record(stored, options)
      changed('edit', { changed: op.changes.map((change) => change.id), page: Boolean(op.page), pageShift: op.page?.shift ?? null, viewShift: viewShift ?? op.page?.shift ?? null, selection: op.selection?.after ?? [] })
      return history.doc
    },
    begin: (label) => history?.begin(label),
    end(options) { history?.end(options) },
    // Deletes top-level objects, and the connectors that point at them, as one undoable step. The rule (a locked object stays) is
    // core/document/operations.js planRemove; this only records it.
    deleteObjects(ids) {
      if (!history) return null
      const { op } = planRemove(history.doc, { ids })
      if (!op.changes.length) return null
      const deleted = ids.filter((id) => op.changes.some((change) => change.id === id))
      return this.record({ ...op, selection: { before: deleted, after: [] } })
    },
    undo: () => wrap('undo'),
    redo: () => wrap('redo'),
  }
}
