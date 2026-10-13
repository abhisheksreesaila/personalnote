// Writing Markdown text in place (F-049): the editor for a Markdown text on the canvas, a CodeMirror view set exactly over the words it
// edits. It looks like the drawn text (markdown-layout.js: the same fonts, sizes, line heights and indents per line), so opening it
// does not move the words: the Markdown marks (#, **, the URL of a link) stay hidden except on the line with the caret, where they
// show so they can be edited. Loaded on demand (CodeMirror is not in the main bundle); until then the plain editor (text.js) is used.
// Same contract as text.js createTextOverlay, so the scene drives either one.
import { EditorSelection, EditorState, RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { parseMarkdown } from './markdown.js'
import { withLinks } from './text-links.js'
import { CODE_PAPER, QUIET_COLOR, lineLook, runLook } from './markdown-layout.js'

const cssFont = ({ italic, fontWeight, fontSize, fontFamily }) => `${italic ? 'italic ' : ''}${fontWeight} ${fontSize}px ${fontFamily}`
const quoteFamily = (family) => family.split(',').map((name) => { const n = name.trim(); return /\s/.test(n) && !/^["']/.test(n) ? `"${n}"` : n }).join(', ')
const fontOf = (look) => cssFont({ ...look, fontFamily: quoteFamily(look.fontFamily) })

let styled = false
function installStyle() {
  if (styled) return
  styled = true
  const style = document.createElement('style')
  style.textContent = `
.md-editor { position: absolute; left: 0; top: 0; transform-origin: 0 0; z-index: 5; -webkit-text-size-adjust: none; }
.md-editor .cm-editor { background: transparent; }
.md-editor .cm-editor.cm-focused { outline: none; }
.md-editor .cm-scroller { overflow: visible; font-family: inherit; line-height: inherit; }
.md-editor .cm-content { padding: 0; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; font-kerning: normal; }
.md-editor .cm-line { padding: 0; position: relative; letter-spacing: 0; }
.md-editor .md-mark { position: absolute; pointer-events: none; }
.md-editor .md-dot { border-radius: 50%; }
.md-editor .md-check { box-sizing: border-box; border: 1.5px solid currentColor; }
.md-editor .md-quote::before { content: ''; position: absolute; left: var(--md-bar); top: 0; bottom: 0; width: 3px; background: rgba(120, 100, 70, 0.35); }
.md-editor .md-code { background: ${CODE_PAPER}; }
.md-editor .md-rule::after { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 1.5px; background: rgba(80, 66, 46, 0.35); }
.md-editor .md-raw { color: ${QUIET_COLOR}; }
`
  document.head.append(style)
}

// The bullet, checkbox or number of a list line, drawn in the line's indent where the canvas draws it (it takes no room in the line).
class MarkWidget extends WidgetType {
  constructor(kind, look, line) { super(); this.kind = kind; this.look = look; this.line = line }
  eq(other) { return other.kind === this.kind && other.look.fontSize === this.look.fontSize && other.look.indent === this.look.indent && other.look.lineHeight === this.look.lineHeight && other.line.checked === this.line.checked && other.line.number === this.line.number }
  toDOM() {
    const { look, line } = this
    const mark = document.createElement('span')
    const size = look.fontSize
    mark.className = `md-mark md-${this.kind}`
    mark.setAttribute('aria-hidden', 'true')
    if (this.kind === 'dot') {
      Object.assign(mark.style, { left: `${look.indent - size * 0.75}px`, top: `${look.lineHeight / 2 - size * 0.09}px`, width: `${size * 0.18}px`, height: `${size * 0.18}px`, background: look.color })
    } else if (this.kind === 'check') {
      Object.assign(mark.style, { left: `${look.indent - size * 1.05}px`, top: `${look.lineHeight / 2 - size * 0.36}px`, width: `${size * 0.72}px`, height: `${size * 0.72}px`, borderRadius: `${size * 0.72 * 0.22}px`, color: look.color, background: line.checked ? look.color : 'transparent' })
      if (line.checked) mark.innerHTML = '<svg viewBox="0 0 10 10" width="100%" height="100%" style="display:block"><path d="M2.4 5.2 L4.3 7 L7.7 3" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    } else {
      mark.textContent = line.number
      Object.assign(mark.style, { left: `${look.indent - size * 1.25}px`, top: '0', font: fontOf(look), lineHeight: `${look.lineHeight}px`, color: QUIET_COLOR })
    }
    return mark
  }
  ignoreEvent() { return true }
}

const hide = Decoration.replace({})

// ---- the marks on the words (F-050) stay on screen while the text is typed: they follow their words through each change
const SVG = 'http://www.w3.org/2000/svg'
const pathText = (path) => path.map((command) => command.join(' ')).join(' ')
const alpha = (color, value) => {
  if (value === undefined || value >= 1 || !/^#[0-9a-f]{6}$/i.test(color ?? '')) return color
  return `${color}${Math.round(value * 255).toString(16).padStart(2, '0')}`
}
function markElement(mark) {
  if (mark.kind === 'dot') {
    const dot = document.createElementNS(SVG, 'circle')
    dot.setAttribute('r', mark.radius)
    dot.setAttribute('fill', alpha(mark.color, mark.alpha))
    return dot
  }
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', pathText(mark.path ?? []))
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', alpha(mark.color, mark.alpha))
  path.setAttribute('stroke-width', mark.width ?? 2)
  path.setAttribute('stroke-linecap', mark.cap ?? 'round')
  path.setAttribute('stroke-linejoin', mark.join ?? 'round')
  return path
}

// Every line styled as the canvas draws it; the marks hidden except on the lines the selection touches.
function decorationsFor(state, base, links = []) {
  const source = state.doc.toString()
  const active = new Set()
  for (const range of state.selection.ranges) {
    for (let at = state.doc.lineAt(range.from).number; at <= state.doc.lineAt(range.to).number; at += 1) active.add(at)
  }
  const builder = new RangeSetBuilder()
  withLinks(parseMarkdown(source), links).forEach((line, index) => { // (link words look as on the canvas: they take the same room)
    const look = lineLook(line, base)
    const raw = active.has(index + 1)
    const classes = [`md-${line.kind}`]
    if (line.kind === 'quote') classes.push('md-quote')
    if (line.kind === 'code') classes.push('md-code')
    if (line.kind === 'rule' && !raw) classes.push('md-rule')
    const lineHeight = line.kind === 'fence' && raw ? Math.round(base.fontSize * base.lineHeight * 100) / 100 : look.lineHeight
    builder.add(line.from, line.from, Decoration.line({
      class: classes.join(' '),
      attributes: { style: `font:${fontOf(look)};padding-left:${look.indent}px;line-height:${lineHeight}px;min-height:${lineHeight}px;color:${look.color};--md-bar:${look.fontSize * 0.2}px` }, // (font first: the shorthand resets line-height)
    }))
    // What lies between line.from and line.to, in order: the marker, then shown runs with hidden marks between them.
    const pieces = []
    if (line.kind === 'fence' || line.kind === 'rule') { if (!raw && line.to > line.from) pieces.push({ from: line.from, to: line.to, deco: hide }) } else {
      const widget = line.kind === 'bullet' ? 'dot' : line.kind === 'task' ? 'check' : line.kind === 'ordered' ? 'number' : null
      if (widget) pieces.push({ from: line.from, to: line.from, deco: Decoration.widget({ widget: new MarkWidget(widget, look, line), side: -1 }) })
      let at = line.marker ? line.marker.from : line.contentFrom
      if (line.marker && line.marker.from > line.from && !raw) pieces.push({ from: line.from, to: line.marker.from, deco: hide }) // a nested item's own indent: the padding stands for it
      if (line.marker) { pieces.push({ from: line.marker.from, to: line.marker.to, deco: raw ? Decoration.mark({ class: 'md-raw' }) : hide }); at = line.marker.to }
      for (const run of line.runs) {
        if (run.from > at) pieces.push({ from: at, to: run.from, deco: raw ? Decoration.mark({ class: 'md-raw' }) : hide })
        const piece = runLook(look, run.style)
        let css = `font:${fontOf(piece)};color:${piece.color}`
        if (piece.decoration === 'under') css += ';text-decoration:underline'
        if (piece.decoration === 'delete') css += ';text-decoration:line-through'
        if (piece.paper) css += `;background:${piece.paper};border-radius:4px`
        pieces.push({ from: run.from, to: run.to, deco: Decoration.mark({ attributes: { style: css } }) })
        at = run.to
      }
      if (line.to > at && line.kind !== 'blank') pieces.push({ from: at, to: line.to, deco: raw ? Decoration.mark({ class: 'md-raw' }) : hide })
    }
    for (const piece of pieces) if (piece.to > piece.from || piece.deco.spec.widget) builder.add(piece.from, piece.to, piece.deco)
  })
  return builder.finish()
}

const IME_KEY = 229

export function createMarkdownEditor({ host }) {
  installStyle()
  let holder = null
  let view = null
  let session = null
  let openedAt = 0

  function fit() {
    if (!view) return { width: 0, height: 0 }
    const content = view.contentDOM
    if (!session.wrap) holder.style.width = 'max-content'
    const width = session.wrap ? session.width : Math.max(content.scrollWidth, 2)
    const height = Math.max(content.offsetHeight, session.lineHeight)
    return { width, height }
  }

  function place() {
    if (!holder) return
    const { matrix } = session
    holder.style.transform = `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`
  }

  function finish(commit) {
    if (!view) return null
    const done = session
    const value = view.state.doc.toString()
    teardown()
    if (commit) done.onCommit(value)
    return value
  }

  function keepFocus(event) { if (event.target?.closest?.('[data-keeps-text-editing]')) event.preventDefault() }
  function outside(event) {
    if (holder?.contains(event.target) || event.target?.closest?.('[data-keeps-text-editing]')) return
    finish(true)
  }
  function onBlur() {
    if (view && performance.now() - openedAt < 400 && session) { view.focus(); return }
    setTimeout(() => { if (view && !view.hasFocus) finish(true) }, 0) // (focus can move within the editor, to a widget and back)
  }

  function teardown() {
    window.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('mousedown', keepFocus, true)
    view.contentDOM.removeEventListener('blur', onBlur)
    view.destroy()
    holder.remove()
    holder = null
    view = null
    session = null
  }

  const leave = (escape) => () => {
    const done = session
    finish(true)
    if (escape) done?.onEscape?.()
    return true
  }

  return {
    get isOpen() { return Boolean(view) },
    get element() { return view?.contentDOM ?? null },
    get value() { return view?.state.doc.toString() ?? '' },
    get composing() { return Boolean(view?.composing) },
    // As text.js open(), plus `base`: the text's look (markdown-layout.js) that each line is styled from.
    // `marks`: the text's marks (text-marks.js), drawn over the words while they are typed.
    open({ value, font, base, wrap, width, matrix, caret = null, marks = [], links = [], onInput = () => {}, onCommit, onEscape }) {
      if (view) finish(true)
      session = { matrix, wrap, width, lineHeight: font.lineHeight, onInput, onCommit, onEscape, marks: marks.map((mark) => ({ mark, pos: mark.anchor.pos, end: mark.anchor.end })), links: links.map((link) => ({ ...link })) }
      holder = document.createElement('div')
      holder.className = 'md-editor'
      Object.assign(holder.style, { width: wrap ? `${width}px` : 'max-content', font: cssFont({ italic: base.italic, fontWeight: base.fontWeight, fontSize: base.fontSize, fontFamily: quoteFamily(base.fontFamily) }), color: base.color, caretColor: base.color })
      host.append(holder)
      const inkLayer = document.createElementNS(SVG, 'svg')
      inkLayer.setAttribute('class', 'md-marks')
      Object.assign(inkLayer.style, { position: 'absolute', left: '0', top: '0', width: '1px', height: '1px', overflow: 'visible', pointerEvents: 'none', zIndex: '1' })
      const drawMarks = (editor) => editor.requestMeasure({
        read: () => {
          const box = holder?.getBoundingClientRect()
          const { a, b, c, d } = session?.matrix ?? {}
          if (!box || b || c || !a) return null // (a turned text shows its marks again when the edit ends)
          return session.marks.map((item) => { const at = editor.coordsAtPos(item.pos, 1); return at ? { item, x: (at.left - box.left) / a, y: (at.top - box.top) / d } : null })
        },
        write: (placed) => {
          inkLayer.replaceChildren()
          for (const spot of placed ?? []) {
            if (!spot) continue
            const element = markElement(spot.item.mark)
            const offset = spot.item.mark.kind === 'dot' ? { x: spot.item.mark.radius, y: spot.item.mark.radius } : { x: 0, y: 0 }
            element.setAttribute('transform', `translate(${spot.x + spot.item.mark.anchor.dx + offset.x} ${spot.y + spot.item.mark.anchor.dy + offset.y})`)
            inkLayer.append(element)
          }
        },
      })
      const decorations = ViewPlugin.fromClass(class {
        constructor(editor) { this.decorations = decorationsFor(editor.state, base, session.links) }
        update(update) {
          if (update.docChanged && session) session.links = session.links.map((link) => ({ ...link, pos: update.changes.mapPos(link.pos, 1), end: update.changes.mapPos(link.end, -1) })).filter((link) => link.end > link.pos)
          if (update.docChanged || update.selectionSet) this.decorations = decorationsFor(update.state, base, session?.links ?? [])
        }
      }, { decorations: (plugin) => plugin.decorations })
      view = new EditorView({
        parent: holder,
        state: EditorState.create({
          doc: value,
          extensions: [
            history(),
            keymap.of([{ key: 'Escape', run: leave(true) }, { key: 'Mod-Enter', run: leave(false) }, ...defaultKeymap, ...historyKeymap]),
            wrap ? EditorView.lineWrapping : [],
            EditorView.scrollHandler.of(() => true), // never scroll the page to the caret: the editor sits on the canvas, which the app moves itself
            decorations,
            EditorView.contentAttributes.of({ 'aria-label': 'Edit text', spellcheck: 'true', autocapitalize: 'off', class: 'leafer-text-editor' }),
            EditorView.updateListener.of((update) => {
              if (!session) return
              if (update.docChanged) {
                session.marks = session.marks.map((item) => ({ ...item, pos: update.changes.mapPos(item.pos, 1), end: update.changes.mapPos(item.end, -1) })).filter((item) => item.end > item.pos)
                session.onInput(fit())
              }
              if (update.docChanged || update.geometryChanged || update.viewportChanged) drawMarks(update.view)
            }),
            EditorView.domEventHandlers({
              keydown: (event) => event.isComposing || event.keyCode === IME_KEY, // keys that belong to the input method
              drop: (event) => Boolean(event.dataTransfer?.files?.length), // a picture dropped on the words goes on the page (the app places it), never in as text
            }),
          ],
        }),
      })
      // The editable element reads like the plain editor's textarea (its words, the caret), for the speed test and the checks that drive either.
      const editor = view
      Object.defineProperties(view.contentDOM, {
        value: { get: () => editor.state.doc.toString(), configurable: true },
        selectionStart: { get: () => editor.state.selection.main.from, configurable: true },
        selectionEnd: { get: () => editor.state.selection.main.to, configurable: true },
        setSelectionRange: { value: (start, end = start) => editor.dispatch({ selection: EditorSelection.range(start, end) }), configurable: true },
      })
      holder.append(inkLayer)
      drawMarks(view)
      openedAt = performance.now()
      place()
      view.contentDOM.addEventListener('blur', onBlur)
      window.addEventListener('pointerdown', outside, true)
      window.addEventListener('mousedown', keepFocus, true)
      view.focus()
      // The caret goes where the person pointed (in the text's own frame), else to the end of the words.
      let at = value.length
      if (caret) {
        const box = host.getBoundingClientRect()
        const x = box.left + matrix.a * caret.x + matrix.c * caret.y + matrix.e
        const y = box.top + matrix.b * caret.x + matrix.d * caret.y + matrix.f
        at = view.posAtCoords({ x, y }) ?? value.length
      }
      view.dispatch({ selection: EditorSelection.cursor(at) })
      onInput(fit())
    },
    setValue(value, caret = value.length) {
      if (!view || view.composing) return false
      const at = Math.min(caret, value.length)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: EditorSelection.cursor(at) })
      return true
    },
    get selection() { if (!view) return null; const { from, to } = view.state.selection.main; return { start: from, end: to } },
    replaceRange(start, end, text) {
      if (!view || view.composing) return false
      view.dispatch({ changes: { from: start, to: end, insert: text }, selection: EditorSelection.range(start, start + text.length) })
      return true
    },
    setMatrix(matrix) { if (session) { session.matrix = matrix; place() } },
    setWidth(width) { if (session) { session.width = width; if (session.wrap) holder.style.width = `${width}px`; session.onInput(fit()) } },
    commit() { return finish(true) },
    cancel() { return finish(false) },
  }
}
