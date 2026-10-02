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
const CARET_SCAN_LIMIT = 6000

// The character gap nearest a point in the field's own frame (px from its top-left, before the turn and zoom), found on a mirror that
// breaks lines exactly as the field does. The end of the words when there are too many to scan.
function indexAtPoint(area, x, y) {
  const value = area.value
  if (!value || value.length > CARET_SCAN_LIMIT) return value.length
  const style = getComputedStyle(area)
  const mirror = document.createElement('div')
  Object.assign(mirror.style, { position: 'absolute', left: '-9999px', top: '0', width: style.width, font: style.font, letterSpacing: style.letterSpacing, whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, wordBreak: style.wordBreak, textAlign: style.textAlign, lineHeight: style.lineHeight, tabSize: style.tabSize })
  mirror.textContent = value
  document.body.append(mirror)
  const origin = mirror.getBoundingClientRect()
  const text = mirror.firstChild
  const lineHeight = Number.parseFloat(style.lineHeight) || 1
  let best = value.length
  let bestDistance = Infinity
  let lineEnd = null
  const range = document.createRange()
  for (let i = 0; i < value.length; i += 1) {
    range.setStart(text, i)
    range.setEnd(text, i + 1)
    const rect = range.getClientRects()[0]
    if (!rect) continue
    const top = rect.top - origin.top
    const inLine = y >= top - 0.5 && y < top + lineHeight - 0.5
    const left = rect.left - origin.left
    const right = rect.right - origin.left
    if (inLine) {
      lineEnd = i + 1
      const gap = x < left + (right - left) / 2 ? i : i + 1
      const distance = Math.abs((gap === i ? left : right) - x)
      if (distance < bestDistance) { best = gap; bestDistance = distance }
    }
  }
  if (bestDistance === Infinity) best = y < 0 ? 0 : lineEnd ?? value.length
  mirror.remove()
  // a click past the end of a line that ends in a newline lands before the newline, not after it
  if (value[best - 1] === '\n' && best === lineEnd) best -= 1
  return best
}

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

  // A control that keeps the editor open must not take the focus either (the textarea would blur, and on a phone the keyboard would close).
  function keepFocus(event) {
    if (event.target?.closest?.('[data-keeps-text-editing]')) event.preventDefault()
  }

  function teardown() {
    window.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('mousedown', keepFocus, true)
    area.removeEventListener('blur', onBlur)
    area.remove()
    area = null
    session = null
    composing = false
  }

  // A press on a control marked data-keeps-text-editing (the voice buttons, Prettify) acts on the words being edited, so it leaves the editor open.
  function outside(event) {
    if (event.target === area || event.target?.closest?.('[data-keeps-text-editing]')) return
    finish(true)
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
    get composing() { return composing },
    // value: the words so far. font: { family, size, weight, italic, lineHeight (px), letterSpacing (px), align, color, decoration, baseline (px, where
    // the host draws the first baseline below the text's top) }. wrap: false for a text as wide as its words; width: the wrapping width.
    // matrix: the text's own frame -> pixels from the host's top-left. caret: { x, y } in that frame, where to put the caret. Callbacks: onInput({ width, height }), onCommit(value), onEscape().
    open({ value, font, wrap, width, matrix, caret = null, onInput = () => {}, onCommit, onEscape }) {
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
      window.addEventListener('mousedown', keepFocus, true)
      area.focus({ preventScroll: true })
      // The caret goes where the person pointed (in the text's own frame), else to the end of the words.
      const at = caret ? indexAtPoint(area, caret.x, caret.y - shift) : area.value.length
      area.setSelectionRange(at, at)
      onInput(fit())
    },
    // Replaces all the words (voice dictation), the caret at the end. Not while an input method is composing: that is the person typing.
    setValue(value) {
      if (!area || composing) return false
      area.value = value
      area.setSelectionRange(value.length, value.length)
      session.onInput(fit())
      return true
    },
    // The selected range in the field, and a replacement for it ([start, end) -> text), the selection left on the new words.
    get selection() { return area ? { start: area.selectionStart, end: area.selectionEnd } : null },
    replaceRange(start, end, text) {
      if (!area || composing) return false
      area.value = `${area.value.slice(0, start)}${text}${area.value.slice(end)}`
      area.setSelectionRange(start, start + text.length)
      session.onInput(fit())
      return true
    },
    // The text moved on screen (the view moved, the window changed size): put the overlay back over it.
    setMatrix(matrix) { if (session) { session.matrix = matrix; place() } },
    setWidth(width) { if (session) { session.width = width; fit() } },
    commit() { return finish(true) },
    cancel() { return finish(false) },
  }
}
