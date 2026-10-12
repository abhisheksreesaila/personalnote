// Merging an agent's change into unsaved typing on a page (F-045). Both versions are compared with the common ancestor (what the server
// held) as separate hunks: lines first, then the characters inside each changed stretch of lines. Every agent hunk that doesn't collide
// with a local edit is mapped over the local edits and applied (two insertions at one spot keep both, typing first); one that replaces
// text the user also changed, or lands inside it, is dropped, so the typing always survives exactly as typed (unsaved local edits win,
// as on a canvas).
import { ChangeSet } from '@codemirror/state'

const DIFF_LIMIT = 4_000_000 // cells of the comparison table; beyond this a stretch is treated as one replaced range

// Hunks [{ aFrom, aTo, bFrom, bTo }] turning sequence a into sequence b, from their longest common subsequence. The common start and end
// are set aside first (cheap), so the table only covers what actually changed and the size limit is practically never reached.
function sequenceHunks(a, b) {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  return middleHunks(a.slice(head, a.length - tail), b.slice(head, b.length - tail)).map((hunk) => ({ aFrom: hunk.aFrom + head, aTo: hunk.aTo + head, bFrom: hunk.bFrom + head, bTo: hunk.bTo + head }))
}

function middleHunks(a, b) {
  if (!a.length && !b.length) return []
  if (!a.length || !b.length || a.length * b.length > DIFF_LIMIT) return [{ aFrom: 0, aTo: a.length, bFrom: 0, bTo: b.length }]
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const hunks = []
  let i = 0
  let j = 0
  let open = null
  const close = () => { if (open) { hunks.push({ ...open, aTo: i, bTo: j }); open = null } }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { close(); i += 1; j += 1; continue }
    if (!open) open = { aFrom: i, bFrom: j }
    if (j < b.length && (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) j += 1
    else i += 1
  }
  close()
  return hunks
}

const linesOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
const offsets = (parts) => { const at = [0]; for (const part of parts) at.push(at[at.length - 1] + part.length); return at }

// Character-level hunks between two texts: changed stretches of lines, refined to the characters that differ inside each.
export function hunksOf(from, to) {
  if (from === to) return []
  const a = linesOf(from)
  const b = linesOf(to)
  const aAt = offsets(a)
  const bAt = offsets(b)
  const hunks = []
  for (const lineHunk of sequenceHunks(a, b)) {
    const aStart = aAt[lineHunk.aFrom]
    const bStart = bAt[lineHunk.bFrom]
    const aText = from.slice(aStart, aAt[lineHunk.aTo])
    const bText = to.slice(bStart, bAt[lineHunk.bTo])
    const aChars = [...aText]
    const bChars = [...bText]
    for (const hunk of sequenceHunks(aChars, bChars)) {
      const fromPos = aStart + aChars.slice(0, hunk.aFrom).join('').length
      const toPos = aStart + aChars.slice(0, hunk.aTo).join('').length
      hunks.push({ from: fromPos, to: toPos, insert: bChars.slice(hunk.bFrom, hunk.bTo).join('') })
    }
  }
  return hunks
}

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
