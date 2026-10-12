// Merging an agent's change into unsaved typing on a page (F-045). Both sides are reduced to the single replaced range that turns the
// common ancestor (what the server held) into each version; the agent's range is mapped over the local one and applied on top.
import { ChangeSet } from '@codemirror/state'

// The single replaced range that turns `from` into `to` (common start and end kept), as a change set on `from`.
export function differenceOf(from, to) {
  let start = 0
  const limit = Math.min(from.length, to.length)
  while (start < limit && from[start] === to[start]) start += 1
  let end = 0
  while (end < limit - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end += 1
  if (start === from.length - end && start === to.length - end) return ChangeSet.empty(from.length)
  return ChangeSet.of([{ from: start, to: from.length - end, insert: to.slice(start, to.length - end) }], from.length)
}

// The changes to apply to `local` so it also carries what changed from `base` to `remote`.
export function mergeText(base, local, remote) {
  return differenceOf(base, remote).map(differenceOf(base, local))
}
