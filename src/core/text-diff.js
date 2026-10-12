// Comparing two versions of a text (shared by page merges, F-045, and Markdown text marks, F-050): hunks of changed characters, found
// line by line, then character by character inside each changed stretch of lines. Pure, no editor.

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

// How many characters of [from, to) in the old text are left untouched by the hunks.
export function untouched(hunks, from, to) {
  let left = to - from
  for (const hunk of hunks) left -= Math.max(0, Math.min(to, hunk.to) - Math.max(from, hunk.from))
  return left
}

// Where position `pos` of the old text is in the new one. assoc -1 keeps it before text inserted exactly there, 1 after it; a position
// inside replaced text goes to the start (assoc -1) or the end (assoc 1) of the replacement.
export function mapPosition(hunks, pos, assoc = -1) {
  let shift = 0
  for (const hunk of hunks) {
    const size = hunk.insert.length - (hunk.to - hunk.from)
    if (hunk.to < pos || (hunk.to === pos && hunk.from < pos)) { shift += size; continue }
    if (hunk.from > pos) break
    if (hunk.from === pos && hunk.to === pos) { if (assoc > 0) shift += size; break }
    return assoc > 0 ? hunk.from + shift + hunk.insert.length : hunk.from + shift
  }
  return pos + shift
}
