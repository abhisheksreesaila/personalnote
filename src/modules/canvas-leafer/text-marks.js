// Marks on words (F-050): a pen or highlighter stroke drawn over the words of a Markdown text belongs to those words. It is kept in the
// text object (`marks`), anchored to its whole words in the Markdown ([pos, end) and a quote with context, as on pages, ADR 0003), and
// placed relative to the first word's box, so it follows the words through typing, rewrapping, resizing and moving. Pure, no DOM.
import { hunksOf, mapPosition, untouched } from '../../core/text-diff.js'

const QUOTE_CONTEXT = 32
const WORD = /[\p{L}\p{N}_']/u
const UNDERLINE_REACH = 0.35 // a word's box reaches this much of its height below (and above) it: an underline sits just under the letters

export const quoteOf = (source, pos, end) => ({ exact: source.slice(pos, end), prefix: source.slice(Math.max(0, pos - QUOTE_CONTEXT), pos), suffix: source.slice(end, end + QUOTE_CONTEXT) })


// The anchor for a stroke, or null when it is not a mark on words (it stays ordinary ink). `box` is the stroke's box and `points` its
// points, both in the text's frame; `words` the laid-out words. A mark is a stroke that encloses words (a circle, a box), or runs over or
// just under words of one line (a highlight, an underline, a strike); most of its points stay close to those words, so a big arrow, a
// diagonal or a sketch drawn across a paragraph is not taken for a mark.
export function anchorStroke(box, words, source, points = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }]) {
  const reach = (word) => ({ x: word.x, y: word.y - word.height * UNDERLINE_REACH, width: word.width, height: word.height * (1 + 2 * UNDERLINE_REACH) })
  const contains = (rect, point) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
  const first = points[0]
  const last = points.at(-1)
  const closed = points.length > 4 && Math.hypot(last.x - first.x, last.y - first.y) <= Math.max(box.width, box.height) * 0.35
  let chosen = closed ? words.filter((word) => insidePolygon(points, { x: word.x + word.width / 2, y: word.y + word.height / 2 })) : []
  if (!chosen.length) {
    const touched = words.filter((word) => points.some((point) => contains(reach(word), point)))
    if (!touched.length) return null
    const line = touched[0].y
    chosen = touched.every((word) => Math.abs(word.y - line) < word.height / 2) ? touched : [touched.reduce((best, word) => (gap(word, box) < gap(best, box) ? word : best))]
  }
  // Most of the stroke stays near the words it marks.
  const near = chosen.reduce((all, word) => ({ left: Math.min(all.left, word.x), top: Math.min(all.top, word.y), right: Math.max(all.right, word.x + word.width), bottom: Math.max(all.bottom, word.y + word.height) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity })
  const margin = Math.max(24, (near.bottom - near.top) * 1.2)
  const zone = { x: near.left - margin, y: near.top - margin, width: near.right - near.left + 2 * margin, height: near.bottom - near.top + 2 * margin }
  if (points.filter((point) => !contains(zone, point)).length > points.length * 0.2) return null
  chosen.sort((a, b) => a.from - b.from)
  const start = chosen[0]
  const end = chosen.at(-1)
  return { pos: start.from, end: end.to, quote: quoteOf(source, start.from, end.to), dx: box.x - start.x, dy: box.y - start.y }
}

const gap = (word, box) => Math.hypot(word.x + word.width / 2 - (box.x + box.width / 2), word.y + word.height / 2 - (box.y + box.height / 2))

// Whether a point is inside the polygon the points make (even-odd).
function insidePolygon(points, point) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i]
    const b = points[j]
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
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
