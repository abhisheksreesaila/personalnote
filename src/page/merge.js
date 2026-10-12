// Merging an agent's change into unsaved typing on a page (F-045). Both versions are compared with the common ancestor (what the server
// held) as separate hunks: lines first, then the characters inside each changed stretch of lines. Every agent hunk that doesn't collide
// with a local edit is mapped over the local edits and applied (two insertions at one spot keep both, typing first); one that replaces
// text the user also changed, or lands inside it, is dropped, so the typing always survives exactly as typed (unsaved local edits win,
// as on a canvas).
import { ChangeSet } from '@codemirror/state'
import { hunksOf } from '../core/text-diff.js'

export { hunksOf } // (src/core/text-diff.js: shared with Markdown text marks on the canvas)

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

// The changes to apply to `local` so it also carries what changed from `base` to `remote`, without touching anything typed locally.
export function mergeText(base, local, remote) {
  if (remote === base || remote === local) return ChangeSet.empty(local.length)
  const ours = hunksOf(base, local)
  const inside = (point, range) => range.from < point && point < range.to
  const touches = (hunk) => ours.some((mine) => (hunk.from < mine.to && mine.from < hunk.to) // both replace some of the same text
    || (hunk.from === hunk.to && inside(hunk.from, mine)) || (mine.from === mine.to && inside(mine.from, hunk))) // one inserts inside the other
  // Two insertions at one spot where the agent's already holds the typed words (it saw them before the base did): only the rest is new.
  const unseen = (hunk) => {
    if (hunk.from !== hunk.to) return hunk
    const mine = ours.find((each) => each.from === each.to && each.from === hunk.from)
    if (!mine) return hunk
    if (mine.insert.startsWith(hunk.insert)) return null
    return hunk.insert.startsWith(mine.insert) ? { ...hunk, insert: hunk.insert.slice(mine.insert.length) } : hunk
  }
  const theirs = hunksOf(base, remote).filter((hunk) => !touches(hunk)).map(unseen).filter(Boolean)
  return ChangeSet.of(theirs, base.length).map(ChangeSet.of(ours, base.length))
}
