// The text editor over the Leafer canvas (F-029): one real <textarea>, set exactly over the words it edits (same font, size, line
// height, wrapping, turn and zoom), while Leafer's own copy of those words is hidden. A textarea is the browser's own editor, so the
// input method (CJK composition, accents, dead keys, emoji pickers), spellcheck, caret, selection, drag-select, paste as plain text
// and the native undo of a typing session all work as they do in any form. The overlay never sets its value while the person types
// (that is what doubles characters under an input method); it only reads it. No Leafer import here: the host (scene.js) gives it
// the matrix that takes the text's own frame to screen pixels.

// Where the CSS line puts the first baseline for this font, in px below the top of the line box: measured, not assumed, because it
// depends on the font's own metrics (Leafer's rule is (pitch + 0.7 * size) / 2).
function cssBaseline(font) {
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font:${font.css};line-height:${font.lineHeight}px;letter-spacing:${font.letterSpacing}px`
  const marker = document.createElement('span')
  marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
  probe.append('x', marker)
  document.body.append(probe)
  const baseline = marker.offsetTop
  probe.remove()
  return baseline
}

const IME_KEY = 229

export function createTextOverlay({ host }) {
  let area = null
  let session = null
  let composing = false

  const css = (font) => `${font.italic ? 'italic ' : ''}${font.weight} ${font.size}px ${font.family}`

  function fit() {
    if (!area) return
    const { wrap, width } = session
    area.style.height = '0px'
    if (wrap) area.style.width = `${width}px`
    else area.style.width = '0px'
    const contentWidth = wrap ? width : Math.max(area.scrollWidth, 2)
    const contentHeight = Math.max(area.scrollHeight, session.lineHeight) // an empty field still has one line
    if (!wrap) area.style.width = `${contentWidth + 2}px` // room for the caret at the end of the longest line
    area.style.height = `${contentHeight}px`
    return { width: contentWidth, height: contentHeight }
  }

  function place() {
    if (!area) return
    const { matrix, shift } = session
    area.style.transform = `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f}) translate(0px, ${shift}px)`
  }

  function finish(commit) {
    if (!area) return null
    const done = session
    const value = area.value
    teardown()
    if (commit) done.onCommit(value)
    return value
  }

  function teardown() {
    window.removeEventListener('pointerdown', outside, true)
    area.removeEventListener('blur', onBlur)
    area.remove()
    area = null
    session = null
    composing = false
  }

  function outside(event) {
    if (event.target !== area) finish(true)
  }

  function onBlur() {
    // A composition that is still open (the window lost focus mid-word) is committed as the browser leaves it.
    finish(true)
  }

  function onKeydown(event) {
    const typing = composing || event.isComposing || event.keyCode === IME_KEY
    if (typing) return // Esc cancels the candidate list and Enter picks a candidate: those belong to the input method
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      const done = session
      finish(true)
      done?.onEscape?.()
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      finish(true)
    }
  }

  return {
    get isOpen() { return Boolean(area) },
    get element() { return area },
    get value() { return area?.value ?? '' },
    // value: the words so far. font: { family, size, weight, italic, lineHeight (px), letterSpacing (px), align, color, decoration, baseline (px, where
    // the host draws the first baseline below the text's top) }. wrap: false for a text as wide as its words; width: the wrapping width.
    // matrix: the text's own frame -> pixels from the host's top-left. Callbacks: onInput({ width, height }), onCommit(value), onEscape().
    open({ value, font, wrap, width, matrix, onInput = () => {}, onCommit, onEscape }) {
      if (area) finish(true)
      area = document.createElement('textarea')
      area.className = 'leafer-text-editor'
      area.value = value
      area.spellcheck = true
      area.setAttribute('autocapitalize', 'off')
      area.setAttribute('aria-label', 'Edit text')
      area.rows = 1
      const shift = font.baseline - cssBaseline({ ...font, css: css(font) })
      session = { matrix, wrap, width, shift, lineHeight: font.lineHeight, onInput, onCommit, onEscape }
      Object.assign(area.style, {
        position: 'absolute', left: '0px', top: '0px', margin: '0', padding: '0', border: '0', outline: '0', boxSizing: 'content-box',
        background: 'transparent', resize: 'none', overflow: 'hidden', pointerEvents: 'auto', zIndex: '5',
        whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: wrap ? 'break-word' : 'normal', wordBreak: 'normal', tabSize: '4',
        font: css(font), lineHeight: `${font.lineHeight}px`, letterSpacing: `${font.letterSpacing}px`, textAlign: font.align,
        color: font.color, caretColor: font.color, textDecoration: font.decoration, transformOrigin: '0 0', webkitTextSizeAdjust: 'none',
        fontKerning: 'auto',
      })
      host.append(area)
      place()
      fit()
      area.addEventListener('input', () => { if (area) onInput(fit()) })
      area.addEventListener('compositionstart', () => { composing = true })
      area.addEventListener('compositionend', () => { composing = false; if (area) onInput(fit()) })
      area.addEventListener('keydown', onKeydown)
      area.addEventListener('blur', onBlur)
      window.addEventListener('pointerdown', outside, true)
      area.focus({ preventScroll: true })
      area.setSelectionRange(area.value.length, area.value.length)
      onInput(fit())
    },
    // The text moved on screen (the view moved, the window changed size): put the overlay back over it.
    setMatrix(matrix) { if (session) { session.matrix = matrix; place() } },
    setWidth(width) { if (session) { session.width = width; fit() } },
    commit() { return finish(true) },
    cancel() { return finish(false) },
  }
}
