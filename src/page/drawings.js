// Drawings (F-043): standalone blocks in the page's flow, made by drawing on empty space. Each is a CodeMirror block widget between
// lines, so text above pushes it down and text never runs under it. Its strokes, shapes and text objects are painted inside its own
// element (coordinates relative to its top-left), so it moves as one piece. The element is updated in place, never rebuilt, so a change
// of height animates (folding, F-044).
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { drawingField } from './ink-state.js'
import { SVG, INK_COLOR, TEXT_SIZES, shapeElement, strokeElement } from './strokes.js'

class DrawingWidget extends WidgetType {
  constructor(drawing) {
    super()
    this.drawing = drawing
  }

  eq(other) {
    const a = this.drawing
    const b = other.drawing
    return a.id === b.id && a.height === b.height && a.strokes === b.strokes && a.items === b.items
      && (a.link?.quote?.exact ?? '') === (b.link?.quote?.exact ?? '') && Boolean(a.folded) === Boolean(b.folded)
  }

  toDOM() {
    const element = document.createElement('div')
    element.dataset.drawing = this.drawing.id
    const art = document.createElementNS(SVG, 'svg')
    art.setAttribute('class', 'page-drawing-art')
    art.setAttribute('aria-hidden', 'true')
    const items = document.createElement('div')
    items.className = 'page-drawing-items'
    const tag = document.createElement('div')
    tag.className = 'page-drawing-tag'
    element.append(art, items, tag)
    this.paint(element)
    return element
  }

  updateDOM(element) {
    if (element.dataset.drawing !== this.drawing.id) return false
    this.paint(element)
    return true
  }

  paint(element) {
    const drawing = this.drawing
    const linked = Boolean(drawing.link?.quote)
    element.className = `page-drawing${linked ? ' linked' : ''}${linked && drawing.folded ? ' folded' : ''}`
    element.style.height = `${drawing.height}px`
    const art = element.querySelector('.page-drawing-art')
    art.replaceChildren()
    for (const item of drawing.items ?? []) if (item.kind === 'rect' || item.kind === 'ellipse') {
      const shape = shapeElement(item)
      shape.dataset.item = item.id
      art.append(shape)
    }
    for (const stroke of drawing.strokes ?? []) {
      const group = document.createElementNS(SVG, 'g')
      group.setAttribute('transform', `translate(${stroke.dx} ${stroke.dy})`)
      group.dataset.stroke = stroke.id
      group.append(strokeElement(stroke.tool, stroke.points))
      art.append(group)
    }
    const texts = element.querySelector('.page-drawing-items')
    texts.replaceChildren(...(drawing.items ?? []).filter((item) => item.kind === 'text').map((item) => {
      const text = document.createElement('div')
      text.className = 'page-text-object'
      text.dataset.item = item.id
      text.textContent = item.text
      text.style.left = `${item.x}px`
      text.style.top = `${item.y}px`
      text.style.fontSize = `${TEXT_SIZES[item.size] ?? TEXT_SIZES.l}px`
      text.style.color = item.color || INK_COLOR
      return text
    }))
    const tag = element.querySelector('.page-drawing-tag')
    tag.innerHTML = `<span>${linked ? `drawing · opens from “${escapeText(drawing.link.quote.exact)}”` : 'drawing · on its own'}</span>`
      + (linked ? `<button type="button" data-drawing-fold="${drawing.id}">Fold</button>` : '')
      + `<button type="button" data-drawing-link="${drawing.id}">${linked ? 'Unlink' : 'Link to text'}</button>`
  }

  get estimatedHeight() { return this.drawing.folded && this.drawing.link ? 0 : this.drawing.height }

  // Presses inside a drawing are the ink layer's, not the editor's (no caret jumps into the drawing).
  ignoreEvent() { return true }
}

const escapeText = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// Block widgets sit at a line boundary: before a line (side -1, at its start) or after the last one (side 1, at its end).
export const drawingDecorations = EditorView.decorations.compute([drawingField], (state) => {
  const ranges = []
  for (const drawing of state.field(drawingField)) {
    const line = state.doc.lineAt(Math.max(0, Math.min(drawing.pos, state.doc.length)))
    const after = drawing.side === 1
    ranges.push(Decoration.widget({ widget: new DrawingWidget(drawing), block: true, side: after ? 1 : -1 }).range(after ? line.to : line.from))
    // The link word (F-044): teal, with a disclosure marker; clicking it folds or opens its drawing.
    const link = drawing.link
    if (link?.pos != null) {
      const from = Math.min(link.pos, state.doc.length)
      const to = Math.min(link.end ?? from + link.quote.exact.length, state.doc.length)
      if (to > from) ranges.push(Decoration.mark({ class: `page-link-word${drawing.folded ? '' : ' open'}`, attributes: { 'data-drawing': drawing.id, title: drawing.folded ? 'Open the drawing' : 'Fold the drawing' } }).range(from, to))
    }
  }
  return Decoration.set(ranges, true)
})

// Where a new drawing goes for ink whose top is at document height `top` (px from the top of the text): before the line it starts on
// (or the next one, when it starts in a line's lower half), or after the last line.
export function placementAt(view, top) {
  const doc = view.state.doc
  const last = view.lineBlockAt(doc.length)
  if (top >= last.bottom) return { pos: doc.length, side: 1 }
  const block = view.lineBlockAtHeight(Math.max(0, top))
  if (top < block.top + block.height / 2) return { pos: block.from, side: -1 }
  const line = doc.lineAt(block.to)
  return line.number < doc.lines ? { pos: line.to + 1, side: -1 } : { pos: doc.length, side: 1 }
}
