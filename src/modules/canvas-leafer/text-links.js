// Link and fold (F-051): any object can be linked to words of a Markdown text (`link: { textId, pos, end, quote }`). Those words are drawn
// teal; a click on them folds the object away into them (`folded: true`, hidden) and opens it again. Pure, no DOM, no Leafer.
import { hunksOf, mapPosition } from '../../core/text-diff.js'
import { quoteOf, survives, wholeWords } from './text-marks.js'

// The link words of text `textId`: [{ pos, end, folded, ids }] in reading order (objects linked to the same words share them).
export function linkRanges(doc, textId) {
  const ranges = new Map()
  for (const object of doc.objects) {
    const link = object?.link
    if (!link || link.textId !== textId || !(link.end > link.pos)) continue
    const key = `${link.pos}:${link.end}`
    const range = ranges.get(key) ?? { pos: link.pos, end: link.end, folded: true, ids: [] }
    range.ids.push(object.id)
    range.folded &&= Boolean(object.folded) // the words show "folded" only when everything behind them is
    ranges.set(key, range)
  }
  return [...ranges.values()].sort((a, b) => a.pos - b.pos)
}

// The parsed lines with their runs cut at the link words, which get `style.fold` ('folded' or 'open').
export function withLinks(lines, ranges) {
  if (!ranges.length) return lines
  return lines.map((line) => {
    const runs = []
    for (const run of line.runs) {
      const cuts = new Set([run.from, run.to])
      for (const range of ranges) { if (range.pos > run.from && range.pos < run.to) cuts.add(range.pos); if (range.end > run.from && range.end < run.to) cuts.add(range.end) }
      const points = [...cuts].sort((a, b) => a - b)
      for (let index = 0; index < points.length - 1; index += 1) {
        const from = points[index]
        const to = points[index + 1]
        const range = ranges.find((each) => each.pos <= from && to <= each.end)
        runs.push({ from, to, style: range ? { ...run.style, fold: range.folded ? 'folded' : 'open' } : run.style })
      }
    }
    return { ...line, runs }
  })
}

// The link words under a point in the text's frame, or null.
export function linkWord(words, ranges, point) {
  for (const word of words) {
    if (point.x < word.x || point.x > word.x + word.width || point.y < word.y || point.y > word.y + word.height) continue
    return ranges.find((range) => range.pos <= word.from && word.to <= range.end) ?? null
  }
  return null
}

// Changes ({ id, before, after }) for the objects linked to text `textId` after its words changed from `before` to `after`: each link follows
// its words; an object whose words are all gone is unlinked and shown, never left hidden.
export function followLinks(doc, textId, before, after) {
  if (before === after) return []
  const hunks = hunksOf(before, after)
  const changes = []
  for (const object of doc.objects) {
    const link = object?.link
    if (!link || link.textId !== textId) continue
    const pos = mapPosition(hunks, link.pos, 1)
    const end = mapPosition(hunks, link.end, -1)
    let next
    if (end <= pos || !survives(hunks, link)) next = { ...object, link: null, folded: false }
    else {
      const [from, to] = wholeWords(after, pos, end)
      if (from === link.pos && to === link.end && after.slice(from, to) === link.quote?.exact) continue
      next = { ...object, link: { ...link, pos: from, end: to, quote: quoteOf(after, from, to) } }
    }
    changes.push({ id: object.id, before: object, after: next })
  }
  return changes
}
