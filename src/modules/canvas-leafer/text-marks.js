// Marks on words (F-050): a pen or highlighter stroke drawn over the words of a Markdown text belongs to those words. It is kept in the
// text object (`marks`), anchored to its whole words in the Markdown ([pos, end) and a quote with context, as on pages, ADR 0003), and
// placed relative to the first word's box, so it follows the words through typing, rewrapping, resizing and moving. Pure, no DOM.
import { hunksOf, mapPosition, untouched } from '../../core/text-diff.js'

const QUOTE_CONTEXT = 32
const WORD = /[\p{L}\p{N}_']/u
const UNDERLINE_REACH = 0.35 // a word's box reaches this much of its height below (and above) it: an underline sits just under the letters

export const quoteOf = (source, pos, end) => ({ exact: source.slice(pos, end), prefix: source.slice(Math.max(0, pos - QUOTE_CONTEXT), pos), suffix: source.slice(end, end + QUOTE_CONTEXT) })

const meets = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

// The anchor for a stroke whose box (in the text's frame) is `box`, given the laid-out words, or null when it touches no word.
export function anchorStroke(box, words, source) {
  // The words whose middle the stroke encloses (a circle, a box, a highlight over them); else the one word nearest the stroke's middle
  // among those it touches (an underline, a tick beside a word).
  const inside = (word) => { const x = word.x + word.width / 2; const y = word.y + word.height / 2; return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height }
  let touched = words.filter(inside)
  if (!touched.length) {
    const near = words.filter((word) => meets(box, { x: word.x, y: word.y - word.height * UNDERLINE_REACH, width: word.width, height: word.height * (1 + 2 * UNDERLINE_REACH) }))
    if (!near.length) return null
    const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const gap = (word) => Math.hypot(word.x + word.width / 2 - mid.x, word.y + word.height / 2 - mid.y)
    touched = [near.reduce((best, word) => (gap(word) < gap(best) ? word : best))]
  }
  touched.sort((a, b) => a.from - b.from)
  const first = touched[0]
  const last = touched.at(-1)
  return { pos: first.from, end: last.to, quote: quoteOf(source, first.from, last.to), dx: box.x - first.x, dy: box.y - first.y }
}

// The whole word(s) around [pos, end) in `source`.
export function wholeWords(source, pos, end) {
  while (pos > 0 && WORD.test(source[pos - 1])) pos -= 1
  while (end < source.length && WORD.test(source[end])) end += 1
  return [pos, end]
}

// A word survives an edit while at least half of it is left as it was (a fix inside it, an ending added); a word replaced or deleted
// does not, even when the comparison happens to keep one of its letters.
export const survives = (hunks, anchor) => untouched(hunks, anchor.pos, anchor.end) * 2 >= anchor.end - anchor.pos

// The marks after the text changed from `before` to `after`: each follows its words; a mark whose words are all gone goes too.
export function mapMarks(marks, before, after) {
  if (!marks?.length || before === after) return marks ?? []
  const hunks = hunksOf(before, after)
  const kept = []
  for (const mark of marks) {
    const anchor = mark.anchor
    const pos = mapPosition(hunks, anchor.pos, 1)
    const end = mapPosition(hunks, anchor.end, -1)
    if (end <= pos || !survives(hunks, anchor)) continue
    const [from, to] = wholeWords(after, pos, end)
    kept.push({ ...mark, anchor: { ...anchor, pos: from, end: to, quote: quoteOf(after, from, to) } })
  }
  return kept
}

// Where each mark is drawn in the text's frame now: at its first word's box plus its offset. A mark whose word the layout no longer has
// (it should not happen) stays where it was last drawn.
export function placeMarks(marks, words) {
  const byStart = new Map(words.map((word) => [word.from, word]))
  return (marks ?? []).map((mark) => {
    const word = byStart.get(mark.anchor.pos) ?? words.find((each) => each.from <= mark.anchor.pos && mark.anchor.pos < each.to)
    return word ? { ...mark, x: word.x + mark.anchor.dx, y: word.y + mark.anchor.dy } : { ...mark, x: mark.x ?? 0, y: mark.y ?? 0 }
  })
}
