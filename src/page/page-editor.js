// The page note editor (F-040): Markdown in CodeMirror 6 on a sheet of paper that grows as you write. Loaded only when a page note
// opens (src/modules/page.js). The text layer is the Markdown itself; the ink layer (marks, drawings) is added by ink.js.
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { Language, defineLanguageFacet, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { parser as markdownParser, GFM } from '@lezer/markdown'
import { tags as t } from '@lezer/highlight'
import { normalizePageDocument } from './document.js'
import { installPageStyle } from './page-style.js'

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

export const PAGE_SHEET_HEIGHT = 1080

export function mountPage(host, { documentValue, onChange = () => {} } = {}) {
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
  let ink = null
  let silent = false

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
        EditorView.updateListener.of((update) => {
          if (silent) return
          if (update.docChanged) onChange()
        }),
      ],
    }),
  })
  let inkValue = initial.ink // kept as it came until the ink layer (F-042) edits it

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
      return { version: initial.version, markdown: view.state.doc.toString(), ink: ink ? ink.toDocument() : inkValue }
    },
    // A whole new document (an agent's change): replaces the text and ink without announcing an edit.
    setDocument(documentValue) {
      const next = normalizePageDocument(documentValue)
      silent = true
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next.markdown } })
        if (ink) ink.load(next.ink); else inkValue = next.ink
      } finally { silent = false }
    },
    setTitle() {},
    // The dock's and the menu's Undo/Redo: one history for text and ink.
    history(direction) { (direction < 0 ? undo : redo)(view) },
    // Clear all: one undoable step. False when there was nothing to clear.
    clear() {
      if (!view.state.doc.length) return false
      view.dispatch({ changes: { from: 0, to: view.state.doc.length }, userEvent: 'delete' })
      return true
    },
    // Opening a page puts the caret at the end of its text, ready to carry on writing.
    focus() { view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true }); view.focus() },
    destroy() {
      resize.disconnect()
      ink?.destroy()
      view.destroy()
      host.replaceChildren()
    },
  }
}
