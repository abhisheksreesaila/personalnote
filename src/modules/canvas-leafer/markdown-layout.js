// Laying out Markdown text for the canvas (F-048, ADR 0004). The browser does the layout: a hidden copy of the text is built with the
// same fonts and widths, every word's box is read from it, and the canvas paints those words at exactly those places (scene.js). So
// line breaks are the browser's, the editor and the picture agree, and every word's box is known (marks anchor to words, F-050).
// lineLook, splitWords and piecesOf are pure and tested in Node; layoutMarkdown needs a DOM.
import { parseMarkdown } from './markdown.js'

export const MONO_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
export const LINK_COLOR = '#1d5fae'
const QUIET_COLOR = '#6b6257'
const CODE_PAPER = 'rgba(120, 100, 70, 0.10)'
// Bold is the 600 face: the text fonts ship 400 and 600 (a 700 would be a synthetic or a late-loading face).
export const BOLD = '600'
const HEADING_SCALE = [1.75, 1.45, 1.25, 1.1, 1, 0.95]

// How a line looks: its font, size, line height (px), colour and indent, from the text's own style (`base`).
export function lineLook(line, base) {
  const size = base.fontSize
  const look = { kind: line.kind, fontFamily: base.fontFamily, fontSize: size, fontWeight: base.fontWeight ?? 'normal', italic: base.italic ?? false, color: base.color, indent: 0, lineHeight: Math.round(size * base.lineHeight * 100) / 100 }
  switch (line.kind) {
    case 'heading': {
      const headingSize = Math.round(size * HEADING_SCALE[line.level - 1] * 100) / 100
      return { ...look, fontSize: headingSize, fontWeight: BOLD, lineHeight: Math.round(headingSize * Math.max(1.2, base.lineHeight - 0.2) * 100) / 100 }
    }
    case 'bullet': case 'ordered': case 'task': return { ...look, indent: Math.round((line.depth + 1) * size * 1.4) }
    case 'quote': return { ...look, indent: Math.round(size * 1.1), color: QUIET_COLOR }
    case 'code': return { ...look, fontFamily: MONO_FAMILY, fontSize: Math.round(size * 0.86 * 100) / 100, indent: Math.round(size * 0.6) }
    case 'fence': return { ...look, lineHeight: Math.round(size * 0.5) }
    default: return look
  }
}

// The words of `text` (which starts at `offset` in the source): stretches without white space.
export function splitWords(text, offset = 0) {
  const words = []
  const pattern = /\S+/g
  let match
  while ((match = pattern.exec(text))) words.push({ from: offset + match.index, to: offset + match.index + match[0].length })
  return words
}

// Measured words ({ run, from, to, x, row }) grouped into what is drawn: one piece per run per row, its text running from the first word
// to the last (the spaces between them included, as the browser set them).
export function piecesOf(source, line, words) {
  const pieces = []
  for (const word of words) {
    const last = pieces.at(-1)
    if (last && last.run === word.run && last.row === word.row) { last.to = word.to; last.text = source.slice(last.from, last.to); continue }
    pieces.push({ run: word.run, row: word.row, from: word.from, to: word.to, x: word.x, text: source.slice(word.from, word.to), style: line.runs[word.run].style })
  }
  return pieces
}

// ---------- DOM layout

const cssFont = ({ italic, fontWeight, fontSize, fontFamily }) => `${italic ? 'italic ' : ''}${fontWeight} ${fontSize}px ${fontFamily}`
const quoteFamily = (family) => family.split(',').map((name) => { const n = name.trim(); return /\s/.test(n) && !/^["']/.test(n) ? `"${n}"` : n }).join(', ')

function runLook(look, style) {
  const piece = { fontFamily: look.fontFamily, fontSize: look.fontSize, fontWeight: style.bold ? BOLD : look.fontWeight, italic: look.italic || Boolean(style.italic), color: look.color, decoration: 'none' }
  if (style.code && look.kind !== 'code') { piece.fontFamily = MONO_FAMILY; piece.fontSize = Math.round(look.fontSize * 0.86 * 100) / 100; piece.paper = CODE_PAPER }
  if (style.link) { piece.color = LINK_COLOR; piece.decoration = 'under' }
  if (style.strike) piece.decoration = 'delete'
  return piece
}

let probe = null
let ruler = null
const ascents = new Map()
// The font's ascent (the browser puts a word's box this far above its baseline).
function ascentOf(font) {
  let ascent = ascents.get(font)
  if (ascent === undefined) {
    ruler ??= document.createElement('canvas').getContext('2d')
    ruler.font = font
    const metrics = ruler.measureText('Hg')
    ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent
    ascents.set(font, ascent)
  }
  return ascent
}

const cache = new Map()
const CACHE_SIZE = 300

export function clearMarkdownLayouts() { cache.clear(); ascents.clear() }

// The layout of `source` wrapped at `width` px (no wrapping when it is undefined), in the text's own frame (origin at its top-left):
// { width, height, pieces, shapes, words }. pieces: what is drawn as text ({ text, x, baseline, font..., color, decoration });
// shapes: bullets, checkboxes, quote bars, code paper and rules; words: every word's box with its place in the source.
export function layoutMarkdown(source, { width, base }) {
  const key = JSON.stringify([source, width ?? null, base])
  const known = cache.get(key)
  if (known) { cache.delete(key); cache.set(key, known); return known }
  const result = measure(String(source ?? ''), width, base)
  if (document.fonts?.status === 'loading') return result // measured with a font still on its way: measured again once it is here
  cache.set(key, result)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value)
  return result
}

function measure(source, width, base) {
  probe ??= Object.assign(document.createElement('div'), { ariaHidden: 'true' })
  probe.style.cssText = `position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;font-kerning:normal;text-rendering:auto;${width === undefined ? 'width:max-content' : `width:${width}px`}`
  probe.replaceChildren()
  const lines = parseMarkdown(source)
  const rows = []
  for (const line of lines) {
    const look = lineLook(line, base)
    const element = document.createElement('div')
    element.style.cssText = `margin:0;padding:0 0 0 ${look.indent}px;min-height:${look.lineHeight}px;line-height:${look.lineHeight}px;font:${cssFont({ ...look, fontFamily: quoteFamily(look.fontFamily) })};letter-spacing:0`
    const spans = line.runs.map((run) => {
      const piece = runLook(look, run.style)
      const span = document.createElement('span')
      span.style.font = cssFont({ ...piece, fontFamily: quoteFamily(piece.fontFamily) })
      span.style.lineHeight = `${look.lineHeight}px`
      span.textContent = source.slice(run.from, run.to)
      element.append(span)
      return { span, piece }
    })
    if (!spans.length) element.append('​')
    probe.append(element)
    rows.push({ line, look, element, spans })
  }
  document.body.append(probe)
  const origin = probe.getBoundingClientRect()
  const range = document.createRange()
  const pieces = []
  const shapes = []
  const words = []
  const rowTops = [] // the top of every visual row, blank ones too
  for (const { line, look, element, spans } of rows) {
    const box = element.getBoundingClientRect()
    const top = box.top - origin.top
    const rowOf = (rect) => Math.max(0, Math.floor((rect.top + rect.height / 2 - box.top) / look.lineHeight))
    const measured = []
    spans.forEach(({ span, piece }, runIndex) => {
      const run = line.runs[runIndex]
      const node = span.firstChild
      const ascent = ascentOf(cssFont(piece))
      for (const word of splitWords(node.data, run.from)) {
        range.setStart(node, word.from - run.from)
        range.setEnd(node, word.to - run.from)
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0)
        if (rects.length > 1) { // a word too long for the width was broken: its parts, letter by letter
          let partFrom = word.from
          for (let at = word.from + 1; at <= word.to; at += 1) {
            range.setStart(node, partFrom - run.from)
            range.setEnd(node, at - run.from)
            if (range.getClientRects().length > 1 || at === word.to) {
              const end = at === word.to && range.getClientRects().length === 1 ? at : at - 1
              range.setEnd(node, end - run.from)
              const rect = range.getBoundingClientRect()
              measured.push({ run: runIndex, from: partFrom, to: end, x: rect.left - origin.left, row: rowOf(rect), rect, ascent })
              partFrom = end
            }
          }
          continue
        }
        const rect = rects[0] ?? range.getBoundingClientRect()
        measured.push({ run: runIndex, from: word.from, to: word.to, x: rect.left - origin.left, row: rowOf(rect), rect, ascent })
      }
    })
    for (const word of measured) words.push({ from: word.from, to: word.to, x: word.x, y: word.rect.top - origin.top, width: word.rect.width, height: word.rect.height, line: line.from })
    for (const piece of piecesOf(source, line, measured)) {
      const first = measured.find((word) => word.from === piece.from)
      const last = [...measured].reverse().find((word) => word.to === piece.to)
      const look2 = spans[piece.run].piece
      const baseline = first.rect.top - origin.top + first.ascent
      pieces.push({ text: piece.text, from: piece.from, to: piece.to, x: piece.x, baseline, rowTop: top + piece.row * look.lineHeight, lineHeight: look.lineHeight, ...look2 })
      if (look2.paper) shapes.push({ kind: 'paper', x: piece.x - 3, y: first.rect.top - origin.top - 1, width: last.rect.right - first.rect.left + 6, height: first.rect.height + 2, color: look2.paper })
    }
    const height = box.height
    for (let row = 0; row < Math.max(1, Math.round(height / look.lineHeight)); row += 1) rowTops.push(top + row * look.lineHeight)
    const mid = top + look.lineHeight / 2
    if (line.kind === 'bullet') shapes.push({ kind: 'dot', x: look.indent - look.fontSize * 0.75, y: mid - look.fontSize * 0.09, size: look.fontSize * 0.18, color: look.color })
    else if (line.kind === 'ordered') pieces.push({ text: line.number, x: look.indent - look.fontSize * 1.25, baseline: top + (look.lineHeight + look.fontSize * 0.7) / 2, rowTop: top, lineHeight: look.lineHeight, fontFamily: look.fontFamily, fontSize: look.fontSize, fontWeight: look.fontWeight, italic: false, color: QUIET_COLOR, decoration: 'none', marker: true })
    else if (line.kind === 'task') shapes.push({ kind: 'check', x: look.indent - look.fontSize * 1.05, y: mid - look.fontSize * 0.36, size: look.fontSize * 0.72, checked: line.checked, color: look.color })
    else if (line.kind === 'quote') shapes.push({ kind: 'bar', x: look.fontSize * 0.2, y: top, width: 3, height, color: 'rgba(120, 100, 70, 0.35)' })
    else if (line.kind === 'code') shapes.push({ kind: 'paper', x: 0, y: top, width: width ?? Math.max(box.width, probe.scrollWidth), height, color: CODE_PAPER })
    else if (line.kind === 'rule') shapes.push({ kind: 'rule', x: 0, y: mid, width: width ?? 0, height: 1.5, color: 'rgba(80, 66, 46, 0.35)' })
  }
  const total = { width: width ?? Math.ceil(probe.scrollWidth), height: Math.ceil(probe.getBoundingClientRect().height) }
  for (const shape of shapes) if ((shape.kind === 'rule' || (shape.kind === 'paper' && shape.x === 0)) && !shape.width) shape.width = total.width
  probe.remove()
  return { ...total, pieces, shapes, words, rowTops }
}
