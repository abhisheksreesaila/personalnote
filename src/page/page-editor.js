// The page note editor (F-040): Markdown in CodeMirror 6 on a sheet of paper that grows as you write. Loaded only when a page note
// opens (src/modules/page.js). The text layer is the Markdown itself; the ink layer (marks, drawings) is added by ink.js.
import { EditorState, RangeSetBuilder, StateEffect, Transaction } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap, drawSelection } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { Language, defineLanguageFacet, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { parser as markdownParser, GFM } from '@lezer/markdown'
import { tags as t } from '@lezer/highlight'
import { normalizePageDocument } from './document.js'
import { installPageStyle } from './page-style.js'
import { mergeText } from './merge.js'
import { inkState, readInk, setMarks, setDrawings, agentEdit } from './ink-state.js'
import { isInkTransaction, mountInkLayer } from './ink.js'
import { NOTE_LINK, loadNoteLinks, onNoteLinks, peekNoteLink } from '../core/note-links.js'

// Markdown with GitHub's tables, task lists and strike-through. Built from the Lezer parser directly: @codemirror/lang-markdown would
// also pull in the HTML, CSS and JavaScript parsers for embedded code, which a notes page doesn't need.
const markdownLanguage = new Language(defineLanguageFacet({ commentTokens: { block: { open: '<!--', close: '-->' } } }), markdownParser.configure([GFM]), [], 'markdown')

const pageHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.9em', fontWeight: '700', fontFamily: 'var(--page-display)', lineHeight: '1.25' },
  { tag: t.heading2, fontSize: '1.4em', fontWeight: '700', fontFamily: 'var(--page-display)' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '700', fontFamily: 'var(--page-display)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700', fontFamily: 'var(--page-display)' },
  { tag: t.processingInstruction, color: 'var(--page-markup)' }, // the # and * and - of Markdown: there, but quiet
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--page-accent)' },
  { tag: t.url, color: 'var(--page-markup)' },
  { tag: t.monospace, fontFamily: 'var(--page-mono)', fontSize: '.9em' },
  { tag: t.quote, color: 'var(--page-muted)', fontStyle: 'italic' },
])

const pageTheme = EditorView.theme({
  '&': { background: 'transparent', color: 'var(--page-ink)', fontSize: '18px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'visible', fontFamily: 'var(--page-text)', lineHeight: '1.65' },
  '.cm-content': { padding: '0', caretColor: 'var(--page-ink)', minHeight: '24em' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftWidth: '2px', borderLeftColor: 'var(--page-ink)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'var(--page-selection) !important' },
})

// A link to another note (F-095), `[Title](personal-note://note/<id>)`: only its title shows (the address appears while the caret is in it), it opens
// that note when clicked, and one whose note was removed is struck through and says so.
const linksChanged = StateEffect.define()
const noteRefs = (text) => [...text.matchAll(NOTE_LINK)].map((match) => match[2])
function noteLinkDecorations(view) {
  const builder = new RangeSetBuilder()
  const hidden = new RangeSetBuilder() // the parts that are hidden: the cursor jumps over them
  const { from: caretFrom, to: caretTo } = view.state.selection.main
  for (const range of view.visibleRanges) {
    for (const match of view.state.sliceDoc(range.from, range.to).matchAll(NOTE_LINK)) {
      const from = range.from + match.index
      const to = from + match[0].length
      const titleEnd = from + 1 + match[1].length
      if (titleEnd === from + 1) continue
      const info = peekNoteLink(match[2])
      const mark = Decoration.mark({ class: `page-note-link${info === null ? ' gone' : ''}`, attributes: { 'data-note-ref': match[2], title: info === null ? 'Note removed' : 'Open this note' } })
      if (caretFrom < to && caretTo > from) builder.add(from, to, mark) // the caret is in it: all of it shows, to edit
      else {
        const hide = Decoration.replace({})
        builder.add(from, from + 1, hide)
        builder.add(from + 1, titleEnd, mark)
        builder.add(titleEnd, to, hide)
        hidden.add(from, from + 1, hide)
        hidden.add(titleEnd, to, hide)
      }
    }
  }
  return { shown: builder.finish(), hidden: hidden.finish() }
}
const noteLinks = () => {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.built = noteLinkDecorations(view)
      this.decorations = this.built.shown
      this.off = onNoteLinks(() => view.dispatch({ effects: linksChanged.of(null) }))
      void loadNoteLinks(noteRefs(view.state.doc.toString()), { fresh: true })
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(linksChanged)))) {
        this.built = noteLinkDecorations(update.view)
        this.decorations = this.built.shown
      }
    }
    destroy() { this.off() }
  }, { decorations: (instance) => instance.decorations })
  return [
    plugin,
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.built.hidden ?? Decoration.none),
    // A note's row dragged here also carries its id as plain text: the editor must not paste that. The shell links the note at the drop point.
    EditorView.domEventHandlers({ drop: (event) => [...(event.dataTransfer?.types ?? [])].includes('application/x-personal-note') }),
  ]
}

export const PAGE_SHEET_HEIGHT = 1080

export function mountPage(host, { documentValue, onChange = () => {}, onOpenNote = () => {} } = {}) {
  installPageStyle()
  const initial = normalizePageDocument(documentValue)
  host.innerHTML = `
    <div class="page-desk">
      <div class="page-stage">
        <div class="page-paper">
          <div class="page-sheets" aria-hidden="true"></div>
          <div class="page-editor"></div>
        </div>
      </div>
    </div>`
  const desk = host.querySelector('.page-desk')
  const paper = host.querySelector('.page-paper')
  const sheets = host.querySelector('.page-sheets')
  let silent = false
  let base = initial.markdown // what the server holds: the common ancestor when an agent's change meets unsaved typing

  const view = new EditorView({
    parent: host.querySelector('.page-editor'),
    state: EditorState.create({
      doc: initial.markdown,
      extensions: [
        history(),
        drawSelection(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdownLanguage,
        syntaxHighlighting(pageHighlight),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Page text', spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' }),
        pageTheme,
        inkState(initial.ink),
        noteLinks(),
        EditorView.updateListener.of((update) => {
          if (silent) return
          if (update.docChanged || update.transactions.some(isInkTransaction)) onChange()
        }),
      ],
    }),
  })
  const ink = mountInkLayer({ view, host, paper, desk })
  // A press and release close together on a note link opens its note. The press is read first (capture), before the caret enters the link and its
  // address shows, which would move the words under the finger; a drag or a long press only does what it always did.
  let linkPress = null
  const pressLink = (event) => {
    const link = event.button === 0 && !event.shiftKey && event.target instanceof Element ? event.target.closest('[data-note-ref]') : null
    linkPress = link && { ref: link.dataset.noteRef, id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() }
  }
  const releaseLink = (event) => {
    const press = linkPress
    linkPress = null
    if (press && press.id === event.pointerId && performance.now() - press.time < 700 && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 6) onOpenNote(press.ref)
  }
  host.addEventListener('pointerdown', pressLink, true)
  host.addEventListener('pointerup', releaseLink, true)

  // Faint "Page N" marks every sheet: the page is one continuous sheet that grows; the marks only show where paper would break.
  let shownSheets = 0
  const markSheets = () => {
    const count = Math.max(1, Math.ceil(paper.offsetHeight / PAGE_SHEET_HEIGHT))
    if (count === shownSheets) return
    shownSheets = count
    sheets.replaceChildren(...Array.from({ length: count }, (_, index) => {
      const mark = document.createElement('div')
      mark.className = 'page-sheet-mark'
      mark.style.top = `${(index + 1) * PAGE_SHEET_HEIGHT}px`
      mark.textContent = `Page ${index + 2}`
      mark.hidden = (index + 1) * PAGE_SHEET_HEIGHT >= paper.offsetHeight
      return mark
    }))
  }
  const resize = new ResizeObserver(markSheets)
  resize.observe(paper)

  return {
    view,
    getDocument() {
      return { version: initial.version, markdown: view.state.doc.toString(), ink: readInk(view.state) }
    },
    // A whole new document (an agent's change): replaces the text and ink without announcing an edit.
    setDocument(documentValue) {
      const next = normalizePageDocument(documentValue)
      silent = true
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next.markdown },
          effects: [setMarks.of(next.ink.marks), setDrawings.of(next.ink.drawings)],
          annotations: Transaction.addToHistory.of(false),
        })
        base = next.markdown
      } finally { silent = false }
    },
    // The server now holds `markdown` (a save landed).
    markSaved(markdown) { if (typeof markdown === 'string') base = markdown },
    // An agent's change arriving while there are unsaved edits: both survive. The agent's change (relative to what the server held)
    // is mapped over the local edits and applied; marks whose words it rewrote look for them again. Returns 0 when it changed nothing.
    mergeRemote(documentValue) {
      const next = normalizePageDocument(documentValue)
      if (next.markdown === base) return 0
      view.dispatch({ changes: mergeText(base, view.state.doc.toString(), next.markdown), annotations: [agentEdit.of(true), Transaction.addToHistory.of(false)] })
      base = next.markdown
      return 1
    },
    // Show on an agent's edit (F-096): scroll the lines from..to (UTF-16 offsets in the Markdown) to the middle of the window, then where they
    // are on screen as {left, top, width, height}, or null when the page has changed so much they are gone.
    async revealRange(from, to) {
      const length = view.state.doc.length
      const start = Math.min(from, length)
      view.dispatch({ effects: EditorView.scrollIntoView(start, { y: 'center' }) })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const top = view.coordsAtPos(start, 1)
      const bottom = view.coordsAtPos(Math.min(Math.max(to, start), length), -1) ?? top
      if (!top || !bottom) return null
      const bounds = view.contentDOM.getBoundingClientRect()
      return { left: bounds.left, top: top.top, width: bounds.width, height: Math.max(bottom.bottom, top.bottom) - top.top }
    },
    setTitle() {},
    // A note dropped or picked into this page (F-095): the link goes in at the window point `at` (a drop) or at the caret, with a space on either
    // side where it would touch a word.
    insertNoteLink(markdown, at) {
      let pos = (at && view.posAtCoords({ x: at.clientX, y: at.clientY })) ?? view.state.selection.main.head
      const word = view.state.wordAt(pos)
      if (word && pos > word.from && pos < word.to) pos = pos - word.from < word.to - pos ? word.from : word.to // (dropped in the middle of a word: at the nearer edge of it)
      const before = view.state.sliceDoc(Math.max(0, pos - 1), pos)
      const after = view.state.sliceDoc(pos, pos + 1)
      const text = `${before && !/\s/.test(before) ? ' ' : ''}${markdown}${after && !/\s/.test(after) ? ' ' : ''}`
      view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, scrollIntoView: true, userEvent: 'input.drop' })
      view.focus()
      return true
    },
    // The dock's and the menu's Undo/Redo: one history for text and ink.
    history(direction) { (direction < 0 ? undo : redo)(view) },
    // Clear all: one undoable step. False when there was nothing to clear.
    clear() {
      if (!view.state.doc.length) return false
      view.dispatch({ changes: { from: 0, to: view.state.doc.length }, userEvent: 'delete' })
      return true
    },
    // Opening a page puts the caret at the end of its text, ready to carry on writing.
    // Focus mode (F-073): no drawing of any kind while it is on (the pen, the mouse, the eraser, clicking a drawing).
    setNoDrawing(on) { ink.setFrozen(on) },
    focus() { view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true }); view.focus() },
    destroy() {
      resize.disconnect()
      host.removeEventListener('pointerdown', pressLink, true)
      host.removeEventListener('pointerup', releaseLink, true)
      ink.destroy()
      view.destroy()
      host.replaceChildren()
    },
  }
}
