// The ink layer's state (ADR 0003), kept inside CodeMirror's state so text and ink share one undo history.
//
// A mark is ink drawn on words or in the margin: { id, tool, points: [[x, y]...], anchor: { pos, quote }, dx, dy, margin?, loose? }.
// `anchor.pos` is a position in the Markdown (the start of the word under the mark); `points` are relative to the stroke's own top-left
// and (dx, dy) places that corner relative to the anchor's character box (a margin mark keeps its x from the column edge instead).
// Every text edit maps the positions; a mark whose words are deleted goes with them. An agent's rewrite (annotated `agentEdit`) can't be
// mapped, so each mark looks for its quoted word again and otherwise becomes loose ink: kept, never silently dropped.
//
// A drawing (F-043) is a standalone block in the page's flow: { id, pos, side, height, quote, link, folded, strokes, items }.
import { Annotation, MapMode, StateEffect, StateField } from '@codemirror/state'
import { invertedEffects } from '@codemirror/commands'

export const agentEdit = Annotation.define()

// ---------- quotes: how a mark finds its words again ----------
const QUOTE_CONTEXT = 32
const WORD = /[\p{L}\p{N}_']/u

export function quoteAt(doc, from, to) {
  return { exact: doc.sliceString(from, to), prefix: doc.sliceString(Math.max(0, from - QUOTE_CONTEXT), from), suffix: doc.sliceString(to, to + QUOTE_CONTEXT) }
}

// The start of the best whole-word match for the quote (most context agreeing on either side), or null.
export function findQuote(text, quote) {
  if (!quote || typeof quote.exact !== 'string' || quote.exact.trim().length < 2) return null
  const { exact, prefix = '', suffix = '' } = quote
  let best = null
  let bestScore = -1
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
    const before = text[at - 1] ?? ' '
    const after = text[at + exact.length] ?? ' '
    if ((WORD.test(exact[0]) && WORD.test(before)) || (WORD.test(exact[exact.length - 1]) && WORD.test(after))) continue
    let left = 0
    while (left < prefix.length && text[at - 1 - left] === prefix[prefix.length - 1 - left]) left += 1
    let right = 0
    while (right < suffix.length && text[at + exact.length + right] === suffix[right]) right += 1
    if (left + right > bestScore) { bestScore = left + right; best = at }
  }
  return best
}

// ---------- marks ----------
// A mark is anchored to its whole word, [pos, end): it lives while any of the word is left and goes when all of it is deleted.
const wordEnd = (anchor) => anchor.end ?? anchor.pos + (anchor.quote?.exact?.length ?? 0)
function mapAnchor(anchor, changes) {
  const end = wordEnd(anchor)
  if (end <= anchor.pos) {
    const pos = changes.mapPos(anchor.pos, 1, MapMode.TrackDel)
    return pos == null ? null : { ...anchor, pos, end: pos }
  }
  const pos = changes.mapPos(anchor.pos, 1)
  const to = changes.mapPos(end, -1)
  return to > pos ? { ...anchor, pos, end: to } : null
}
const mapMark = (mark, mapping) => (mark.anchor?.pos == null ? mark : { ...mark, anchor: mapAnchor(mark.anchor, mapping) ?? { ...mark.anchor, pos: mapping.mapPos(mark.anchor.pos, 1) } })
export const addMark = StateEffect.define({ map: mapMark })
export const setMarks = StateEffect.define({ map: (list, mapping) => list.map((mark) => mapMark(mark, mapping)) })
// { marks: [ids], drawings: [ids], strokes: [{ drawing, id }] }: what the eraser touched.
export const eraseInk = StateEffect.define()

function markLost(mark, changes) {
  return mark.anchor?.pos != null && mapAnchor(mark.anchor, changes) == null
}

export const markField = StateField.define({
  create: () => [],
  update(marks, tr) {
    if (tr.docChanged) {
      const agent = tr.annotation(agentEdit)
      const text = agent ? tr.newDoc.toString() : ''
      const next = []
      for (const mark of marks) {
        if (mark.anchor?.pos == null) { next.push(mark); continue }
        const anchor = mapAnchor(mark.anchor, tr.changes)
        if (anchor) { next.push({ ...mark, anchor }); continue }
        if (!agent) continue // its words were deleted: the mark goes with them (undo brings both back)
        const found = findQuote(text, mark.anchor.quote)
        const { loose, ...rest } = mark
        next.push(found != null
          ? { ...rest, anchor: { ...mark.anchor, pos: found, end: found + mark.anchor.quote.exact.length } }
          : { ...rest, loose: true, anchor: { ...mark.anchor, pos: null, end: null } })
      }
      marks = next
    }
    for (const effect of tr.effects) {
      if (effect.is(addMark)) marks = [...marks, effect.value]
      else if (effect.is(setMarks)) marks = effect.value
      else if (effect.is(eraseInk) && effect.value.marks?.length) marks = marks.filter((mark) => !effect.value.marks.includes(mark.id))
    }
    return marks
  },
})

// ---------- drawings (F-043) ----------
const mapDrawing = (drawing, mapping) => ({
  ...drawing,
  pos: mapping.mapPos(drawing.pos, -1),
  ...(drawing.link?.pos != null ? { link: { ...drawing.link, pos: mapping.mapPos(drawing.link.pos, 1) } } : {}),
})
export const addDrawing = StateEffect.define({ map: mapDrawing })
// { id, ...fields }: changes some fields of one drawing (its height, link, fold, strokes, items).
export const updateDrawing = StateEffect.define({ map: (value, mapping) => ({ ...value, ...(value.pos != null ? { pos: mapping.mapPos(value.pos, -1) } : {}), ...(value.link?.pos != null ? { link: { ...value.link, pos: mapping.mapPos(value.link.pos, 1) } } : {}) }) })
export const setDrawings = StateEffect.define({ map: (list, mapping) => list.map((drawing) => mapDrawing(drawing, mapping)) })

// Where a block goes after an agent's rewrite: under the line holding `at`.
function underLine(doc, at) {
  const line = doc.lineAt(at)
  return line.number < doc.lines ? { pos: line.to + 1, side: -1 } : { pos: doc.length, side: 1 }
}

function drawingLost(drawing, changes) {
  return drawing.link?.pos != null && changes.mapPos(drawing.link.pos, 1, MapMode.TrackDel) == null
}

export const drawingField = StateField.define({
  create: () => [],
  update(drawings, tr) {
    if (tr.docChanged) {
      const agent = tr.annotation(agentEdit)
      const text = agent ? tr.newDoc.toString() : ''
      drawings = drawings.flatMap((drawing) => {
        if (drawing.link?.pos != null) {
          const linkPos = tr.changes.mapPos(drawing.link.pos, 1, MapMode.TrackDel)
          if (linkPos == null) {
            if (!agent) return [] // linked: it goes when its word goes (undo brings both back)
            const found = findQuote(text, drawing.link.quote)
            if (found == null) return [{ ...drawing, link: { ...drawing.link, pos: null }, loose: true, ...underLine(tr.newDoc, tr.newDoc.length) }]
            return [{ ...drawing, link: { ...drawing.link, pos: found }, ...underLine(tr.newDoc, found) }]
          }
          drawing = { ...drawing, link: { ...drawing.link, pos: linkPos } }
          if (agent) return [{ ...drawing, ...underLine(tr.newDoc, linkPos) }]
        } else if (agent && drawing.quote) {
          const found = findQuote(text, drawing.quote)
          if (found != null) return [{ ...drawing, ...underLine(tr.newDoc, found) }]
        }
        return [{ ...drawing, pos: Math.min(tr.changes.mapPos(drawing.pos, -1), tr.newDoc.length) }]
      })
    }
    for (const effect of tr.effects) {
      if (effect.is(addDrawing)) drawings = [...drawings, effect.value]
      else if (effect.is(updateDrawing)) drawings = drawings.map((drawing) => (drawing.id === effect.value.id ? { ...drawing, ...effect.value } : drawing))
      else if (effect.is(setDrawings)) drawings = effect.value
      else if (effect.is(eraseInk)) {
        const { drawings: gone = [], strokes = [] } = effect.value
        drawings = drawings.filter((drawing) => !gone.includes(drawing.id)).map((drawing) => {
          const mine = strokes.filter((entry) => entry.drawing === drawing.id).map((entry) => entry.id)
          if (!mine.length) return drawing
          return { ...drawing, strokes: (drawing.strokes ?? []).filter((s) => !mine.includes(s.id)), items: (drawing.items ?? []).filter((s) => !mine.includes(s.id)) }
        })
      }
    }
    return drawings
  },
})

// ---------- one history for text and ink ----------
// Position mapping undoes itself; anything else (a mark drawn, erased, deleted with its words, re-found after an agent's rewrite) is
// undone by putting back the whole list as it was before the transaction.
const inkHistory = invertedEffects.of((tr) => {
  const inverted = []
  const inkEffect = tr.effects.some((e) => e.is(addMark) || e.is(setMarks) || e.is(eraseInk))
  const drawingEffect = tr.effects.some((e) => e.is(addDrawing) || e.is(updateDrawing) || e.is(setDrawings) || e.is(eraseInk))
  const agent = Boolean(tr.annotation(agentEdit))
  const before = tr.startState.field(markField, false) ?? []
  if (inkEffect || agent || (tr.docChanged && before.some((mark) => markLost(mark, tr.changes)))) inverted.push(setMarks.of(before))
  const drawingsBefore = tr.startState.field(drawingField, false) ?? []
  if (drawingEffect || agent || (tr.docChanged && drawingsBefore.some((drawing) => drawingLost(drawing, tr.changes)))) inverted.push(setDrawings.of(drawingsBefore))
  return inverted
})

const clamp = (pos, doc) => (pos == null ? null : Math.max(0, Math.min(pos, doc.length)))

// The ink extension, starting from saved ink. Unknown top-level ink fields ride along untouched.
export function inkState(saved = {}) {
  const extra = Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'marks' && key !== 'drawings'))
  return [
    markField.init((state) => (saved.marks ?? []).map((mark) => (mark.anchor ? { ...mark, anchor: { ...mark.anchor, pos: clamp(mark.anchor.pos, state.doc) } } : mark))),
    drawingField.init((state) => (saved.drawings ?? []).map((drawing) => ({ ...drawing, pos: clamp(drawing.pos ?? state.doc.length, state.doc) }))),
    extraInk.init(() => extra),
    inkHistory,
  ]
}
const extraInk = StateField.define({ create: () => ({}), update: (value) => value })

// The ink as it is saved.
export function readInk(state) {
  return { ...state.field(extraInk, false), marks: state.field(markField), drawings: state.field(drawingField) }
}
