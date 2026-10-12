// The ink layer on a page note (F-042, F-043): the toolbar, drawing with a mouse, pen or Apple Pencil, and painting marks over the
// Markdown. State lives in ink-state.js (inside CodeMirror's state); drawings paint themselves (drawings.js). This module routes input.
//
// Who gets a press: a pen always draws and a finger always scrolls. A mouse types on words and draws on empty space (margins, blank
// lines, past a line's end, below the text); in Draw mode, or with Alt held, it draws everywhere. Esc goes back to writing.
// Where a stroke goes: inside a drawing it joins that drawing; on words it is a mark linked to them; in the side margins it is a mark
// that follows its line; anywhere else it starts a new drawing of its own, linked to no word.
import { EditorSelection, StateEffect } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import { isolateHistory, undo, redo } from '@codemirror/commands'
import { Transaction } from '@codemirror/state'
import { addDrawing, addMark, eraseInk, drawingField, foldDrawing, markField, quoteAt, setDrawings, setMarks, updateDrawing } from './ink-state.js'
import { drawingDecorations, placementAt } from './drawings.js'
import { INK_COLOR, SVG, TEXT_SIZES, TOOLS, bounds, pathOf, round, shapeElement, strokeElement } from './strokes.js'

export { TOOLS, pathOf, strokeElement }

const INK_EFFECTS = [addMark, eraseInk, setMarks, addDrawing, updateDrawing, setDrawings, foldDrawing]
export const isInkTransaction = (tr) => tr.effects.some((effect) => INK_EFFECTS.some((type) => effect.is(type)))

const DRAWING_PADDING = 20
const SHAPES = { rect: 'Rectangle', ellipse: 'Ellipse' }
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

const TOOLBAR = `
  <div class="page-toolbar" role="toolbar" aria-label="Page tools">
    <div class="page-tool-group" role="group" aria-label="Mode">
      <button type="button" data-page-mode="write" aria-pressed="true">Write</button>
      <button type="button" data-page-mode="draw" aria-pressed="false">Draw</button>
    </div>
    <div class="page-tool-group" role="group" aria-label="Ink">
      ${Object.entries(TOOLS).map(([id, tool]) => `<button type="button" data-page-tool="${id}" aria-pressed="false"><span class="page-swatch" style="background:${tool.color}"></span>${tool.label}</button>`).join('')}
      <button type="button" data-page-tool="eraser" aria-pressed="false">Eraser</button>
    </div>
    <div class="page-tool-group" role="group" aria-label="Shapes and text">
      ${Object.entries(SHAPES).map(([id, label]) => `<button type="button" data-page-tool="${id}" aria-pressed="false">${label}</button>`).join('')}
      <button type="button" data-page-tool="text" aria-pressed="false">Text</button>
      <span class="page-text-sizes" hidden>${Object.keys(TEXT_SIZES).map((size) => `<button type="button" data-text-size="${size}" aria-pressed="${size === 'l'}">${size.toUpperCase()}</button>`).join('')}</span>
    </div>
    <div class="page-tool-group" role="group" aria-label="Drawings">
      <button type="button" data-fold-all hidden>Fold all drawings</button>
    </div>
  </div>
  <div class="page-draw-hint" role="status">Drawing. Press Esc or Write to type again.</div>
  <div class="page-link-hint" role="status">Click a word to link the drawing to it. Esc cancels.</div>`

export function mountInkLayer({ view, host, paper, desk }) {
  host.querySelector('.page-desk').insertAdjacentHTML('afterbegin', TOOLBAR)
  const toolbar = host.querySelector('.page-toolbar')
  const art = document.createElementNS(SVG, 'svg')
  art.setAttribute('class', 'page-ink')
  art.setAttribute('aria-hidden', 'true')
  paper.append(art)

  let tool = 'pen'
  let textSize = 'l'
  let drawMode = false
  let drawing = null
  let editingText = null
  let linking = null // the drawing waiting for a word to link to
  const placed = new Map() // mark id -> its top-left on the paper, as last painted (for the eraser)
  const listeners = []
  const on = (target, type, handler, options) => { target.addEventListener(type, handler, options); listeners.push(() => target.removeEventListener(type, handler, options)) }

  // ---------- where things are, in paper pixels ----------
  const paperBox = () => paper.getBoundingClientRect()
  const paperPoint = (clientX, clientY) => { const box = paperBox(); return [round(clientX - box.left), round(clientY - box.top)] }
  const column = () => {
    const box = paperBox()
    const content = view.contentDOM.getBoundingClientRect()
    return { left: content.left - box.left, right: content.right - box.left }
  }
  const drawingElement = (id) => view.contentDOM.querySelector(`.page-drawing[data-drawing="${id}"]`)
  const drawingOrigin = (element) => { const box = paperBox(); const r = element.getBoundingClientRect(); return { x: r.left - box.left, y: r.top - box.top } }
  const drawingById = (id) => view.state.field(drawingField).find((entry) => entry.id === id)
  function originOf(mark, box, col) {
    if (mark.anchor?.pos == null) return null
    const at = view.coordsAtPos(Math.min(mark.anchor.pos, view.state.doc.length), 1)
    if (!at) return null
    return { x: mark.margin ? col.left : at.left - box.left, y: at.top - box.top }
  }

  // ---------- painting marks ----------
  const paint = () => view.requestMeasure({
    key: 'page-ink',
    read: () => {
      const box = paperBox()
      const col = column()
      return view.state.field(markField).map((mark) => ({ mark, origin: originOf(mark, box, col) }))
    },
    write: (items) => {
      art.querySelectorAll('g.page-mark').forEach((node) => node.remove())
      placed.clear()
      let lowest = 0
      for (const { mark, origin } of items) {
        if (!origin) continue
        const x = origin.x + mark.dx
        const y = origin.y + mark.dy
        const group = document.createElementNS(SVG, 'g')
        group.setAttribute('class', 'page-mark')
        group.dataset.mark = mark.id
        group.setAttribute('transform', `translate(${round(x)} ${round(y)})`)
        group.append(strokeElement(mark.tool, mark.points))
        art.append(group)
        placed.set(mark.id, { x, y })
        lowest = Math.max(lowest, y + bounds(mark.points).maxY)
      }
      growTo(lowest + 200)
    },
  })
  const growTo = (height) => {
    const wanted = Math.ceil(height)
    if (wanted > (parseFloat(paper.style.minHeight) || 0)) paper.style.minHeight = `${wanted}px`
  }
  const painter = ViewPlugin.define(() => ({
    update: (update) => {
      if (update.docChanged || update.geometryChanged || update.viewportChanged || update.transactions.some((tr) => tr.effects.length)) paint()
      if (update.transactions.some(isInkTransaction)) syncFoldAll()
    },
  }))
  view.dispatch({ effects: StateEffect.appendConfig.of([drawingDecorations, painter]) })
  paint()
  queueMicrotask(() => syncFoldAll())

  // ---------- who gets the press ----------
  function onText(clientX, clientY) {
    const pos = view.posAtCoords({ x: clientX, y: clientY })
    if (pos == null) return false
    const line = view.state.doc.lineAt(pos)
    if (!line.length) return false
    const at = view.coordsAtPos(pos, pos > line.from ? -1 : 1)
    if (!at || clientY < at.top - 2 || clientY > at.bottom + 2) return false
    const start = view.coordsAtPos(view.moveToLineBoundary(EditorSelection.cursor(pos), false).head, 1)
    const end = view.coordsAtPos(view.moveToLineBoundary(EditorSelection.cursor(pos), true).head, -1)
    return Boolean(start && end && clientX >= start.left - 6 && clientX <= end.right + 28)
  }
  const inDrawing = (target) => target.closest?.('.page-drawing')
  const wantsDraw = (event) => event.pointerType === 'pen' || drawMode || tool === 'eraser' || event.altKey || Boolean(inDrawing(event.target)) || !onText(event.clientX, event.clientY)
  const pointsOnText = (points) => {
    const box = paperBox()
    for (let i = 0; i < points.length; i += 2) if (onText(box.left + points[i][0], box.top + points[i][1])) return true
    return false
  }

  // ---------- a stroke on words or in the margin becomes a mark ----------
  function markFor(points) {
    const { minX, minY, maxX, maxY } = bounds(points)
    const box = paperBox()
    const col = column()
    const margin = maxX < col.left + 4 || minX > col.right - 4
    // Underlines are flat: their words are just above them. Everything else is anchored to the word under its middle.
    const flat = maxY - minY < 16 && maxX - minX > 24
    const probeX = margin ? (maxX < col.left ? col.left + 2 : col.right - 2) : (minX + maxX) / 2
    const probeY = flat ? minY - 10 : (minY + maxY) / 2
    const pos = view.posAtCoords({ x: box.left + probeX, y: box.top + probeY }, false)
    // A margin mark belongs to its whole line (paragraph): it goes only when all of that line is deleted.
    const line = view.state.doc.lineAt(pos)
    const word = margin ? null : view.state.wordAt(pos)
    const from = margin ? line.from : word ? word.from : pos
    const to = margin ? line.to : word ? word.to : Math.min(pos + 1, view.state.doc.length)
    const mark = { id: newId('m'), tool, points: points.map(([x, y]) => [round(x - minX), round(y - minY)]), anchor: { pos: from, end: to, quote: quoteAt(view.state.doc, from, to) }, dx: 0, dy: 0 }
    if (margin) mark.margin = true
    const origin = originOf(mark, box, col)
    mark.dx = round(minX - origin.x)
    mark.dy = round(minY - origin.y)
    return mark
  }

  // ---------- anything else lands in a drawing ----------
  // A new drawing for ink whose bounds (paper px) are given: placed between the lines where the ink began, as tall as the ink.
  function newDrawing({ minX, minY, maxY }) {
    const box = paperBox()
    const col = column()
    const place = placementAt(view, box.top + minY - view.documentTop)
    const line = view.state.doc.lineAt(Math.max(0, Math.min(place.side === 1 ? place.pos : Math.max(0, place.pos - 1), view.state.doc.length)))
    return {
      drawing: { id: newId('d'), ...place, height: Math.ceil(maxY - minY + DRAWING_PADDING * 2), quote: quoteAt(view.state.doc, line.from, line.to), link: null, folded: false, strokes: [], items: [] },
      origin: { x: col.left, y: minY - DRAWING_PADDING },
    }
  }
  // Puts a stroke/shape/text (in paper px) into the drawing under it, or into a new one; one undo step.
  function addToDrawing(kind, payload, bbox, targetId) {
    let target = targetId ? drawingById(targetId) : null
    let origin
    const effects = []
    if (target) origin = drawingOrigin(drawingElement(target.id))
    else {
      const made = newDrawing(bbox)
      target = made.drawing
      origin = made.origin
      effects.push(addDrawing.of(target))
    }
    const local = (x, y) => [round(x - origin.x), round(y - origin.y)]
    let entry
    if (kind === 'stroke') {
      const [dx, dy] = local(bbox.minX, bbox.minY)
      entry = { strokes: [...(target.strokes ?? []), { id: newId('s'), tool, points: payload.map(([x, y]) => [round(x - bbox.minX), round(y - bbox.minY)]), dx, dy }] }
    } else {
      const [x, y] = local(payload.x, payload.y)
      entry = { items: [...(target.items ?? []), { ...payload, id: payload.id ?? newId('i'), x, y }] }
    }
    const needed = Math.ceil(bbox.maxY - origin.y + DRAWING_PADDING)
    effects.push(updateDrawing.of({ id: target.id, ...entry, height: Math.max(target.height, needed) }))
    view.dispatch({ effects, annotations: isolateHistory.of('full') })
    return target.id
  }

  // ---------- pointer ----------
  on(paper, 'pointerdown', (event) => {
    if (linking) {
      if (event.target.closest?.('button')) return
      event.preventDefault()
      event.stopPropagation()
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      const word = pos == null ? null : view.state.wordAt(pos)
      if (word && onText(event.clientX, event.clientY)) linkDrawing(linking, word)
      setLinking(null)
      return
    }
    if (event.pointerType === 'touch') return // fingers scroll
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target.closest?.('button, textarea')) return
    const textObject = event.target.closest?.('.page-text-object')
    if (textObject && tool !== 'eraser') { event.preventDefault(); event.stopPropagation(); editText(textObject.closest('.page-drawing').dataset.drawing, textObject.dataset.item); return }
    if (!wantsDraw(event)) return
    event.preventDefault()
    event.stopPropagation()
    commitText()
    paper.setPointerCapture(event.pointerId)
    const point = paperPoint(event.clientX, event.clientY)
    const inside = inDrawing(event.target)?.dataset.drawing ?? null
    if (tool === 'eraser' || event.buttons === 32) { drawing = { erase: true, marks: new Set(), strokes: new Map() }; eraseAt(point); return }
    if (tool === 'text' && drawMode) { drawing = { text: true, point, inside }; return }
    if (SHAPES[tool] && drawMode) {
      const live = shapeElement({ kind: tool, x: point[0], y: point[1], w: 1, h: 1 })
      art.append(live)
      drawing = { shape: tool, start: point, end: point, live, inside }
      return
    }
    const live = strokeElement(tool, [point])
    art.append(live)
    drawing = { points: [point], live, inside }
  }, true)

  on(paper, 'pointermove', (event) => {
    if (!drawing) { hover(event); return }
    if (drawing.text) return
    const events = event.getCoalescedEvents?.() ?? []
    for (const each of events.length ? events : [event]) {
      const point = paperPoint(each.clientX, each.clientY)
      if (drawing.erase) eraseAt(point)
      else if (drawing.shape) drawing.end = point
      else drawing.points.push(point)
    }
    if (drawing.erase) return
    const last = drawing.shape ? drawing.end : drawing.points[drawing.points.length - 1]
    if (drawing.shape) {
      const [x0, y0] = drawing.start
      const replacement = shapeElement({ kind: drawing.shape, x: Math.min(x0, last[0]), y: Math.min(y0, last[1]), w: Math.abs(last[0] - x0), h: Math.abs(last[1] - y0) })
      drawing.live.replaceWith(replacement)
      drawing.live = replacement
    } else drawing.live.setAttribute('d', pathOf(drawing.points))
    // A drawing being drawn in grows as you pass its bottom edge (the size sticks when the stroke ends).
    if (drawing.inside) {
      const element = drawingElement(drawing.inside)
      const bottom = element ? drawingOrigin(element).y + element.offsetHeight : Infinity
      if (element && last[1] > bottom - 24) element.style.height = `${element.offsetHeight + 60}px`
    }
    if (last[1] > paper.offsetHeight - 160) growTo(paper.offsetHeight + 300) // the page grows as you draw past its bottom
    const area = desk.getBoundingClientRect()
    if (event.clientY > area.bottom - 40) desk.scrollTop += 14
    else if (event.clientY < area.top + 40) desk.scrollTop -= 14
  }, true)

  const finish = () => {
    if (!drawing) return
    const done = drawing
    drawing = null
    if (done.erase) { commitErase(done); return }
    if (done.text) { startText(done.point, done.inside); return }
    done.live.remove()
    if (done.shape) {
      const [x0, y0] = done.start
      const [x1, y1] = done.end
      const box = { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) }
      if (box.maxX - box.minX < 4 || box.maxY - box.minY < 4) return
      addToDrawing('item', { kind: done.shape, x: box.minX, y: box.minY, w: round(box.maxX - box.minX), h: round(box.maxY - box.minY), color: TOOLS.pen.color }, box, done.inside)
      return
    }
    if (done.points.length < 2) return
    const box = bounds(done.points)
    const col = column()
    const margin = box.maxX < col.left + 4 || box.minX > col.right - 4
    if (done.inside || (!margin && !pointsOnText(done.points))) addToDrawing('stroke', done.points, box, done.inside)
    else view.dispatch({ effects: addMark.of(markFor(done.points)), annotations: isolateHistory.of('full') })
  }
  on(paper, 'pointerup', finish, true)
  on(paper, 'pointercancel', finish, true)
  // Apple Pencil on iPad: keep the page still under the pen while fingers still scroll.
  on(paper, 'touchstart', (event) => { if ([...event.touches].some((touch) => touch.touchType === 'stylus')) event.preventDefault() }, { passive: false })

  let hoverFrame = 0
  function hover(event) {
    if (hoverFrame || event.pointerType !== 'mouse') return
    hoverFrame = requestAnimationFrame(() => { hoverFrame = 0; paper.classList.toggle('page-draw-cursor', wantsDraw(event) && !event.target.closest?.('button, .page-text-object')) })
  }

  // ---------- the eraser: marks, strokes, shapes and text objects it touches ----------
  // One sweep is one undo step: what it touches fades at once and is removed together when the pen lifts.
  function eraseAt([x, y]) {
    const sweep = drawing
    for (const mark of view.state.field(markField)) {
      const at = placed.get(mark.id)
      if (at && !sweep.marks.has(mark.id) && mark.points.some(([px, py]) => Math.hypot(at.x + px - x, at.y + py - y) < 12)) {
        sweep.marks.add(mark.id)
        art.querySelectorAll('g.page-mark').forEach((node) => { if (node.dataset.mark === mark.id) node.style.opacity = '.15' })
      }
    }
    const strokes = []
    for (const entry of view.state.field(drawingField)) {
      const element = drawingElement(entry.id)
      if (!element || entry.folded) continue
      const origin = drawingOrigin(element)
      const lx = x - origin.x
      const ly = y - origin.y
      for (const stroke of entry.strokes ?? []) if (stroke.points.some(([px, py]) => Math.hypot(stroke.dx + px - lx, stroke.dy + py - ly) < 12)) strokes.push({ drawing: entry.id, id: stroke.id })
      for (const item of entry.items ?? []) {
        const textBox = item.kind === 'text' ? element.querySelector(`.page-text-object[data-item="${item.id}"]`) : null
        const w = textBox ? textBox.offsetWidth : item.w
        const h = textBox ? textBox.offsetHeight : item.h
        if (lx >= item.x - 6 && lx <= item.x + w + 6 && ly >= item.y - 6 && ly <= item.y + h + 6) strokes.push({ drawing: entry.id, id: item.id })
      }
    }
    for (const hit of strokes) {
      if (sweep.strokes.has(hit.id)) continue
      sweep.strokes.set(hit.id, hit)
      drawingElement(hit.drawing)?.querySelectorAll(`[data-stroke="${hit.id}"], [data-item="${hit.id}"]`).forEach((node) => { node.style.opacity = '.15' })
    }
  }
  function commitErase(sweep) {
    const marks = [...sweep.marks]
    const strokes = [...sweep.strokes.values()]
    if (!marks.length && !strokes.length) return
    // A drawing left with nothing in it goes too.
    const emptied = view.state.field(drawingField).filter((entry) => {
      const mine = strokes.filter((s) => s.drawing === entry.id).map((s) => s.id)
      return mine.length && [...(entry.strokes ?? []), ...(entry.items ?? [])].every((part) => mine.includes(part.id))
    }).map((entry) => entry.id)
    view.dispatch({ effects: eraseInk.of({ marks, strokes, drawings: emptied }), annotations: isolateHistory.of('full') })
  }

  // ---------- text objects (word art) ----------
  function startText(point, inside) {
    const size = TEXT_SIZES[textSize]
    const box = { minX: point[0], minY: point[1] - size * 0.2, maxX: point[0] + size * 4, maxY: point[1] + size * 1.4 }
    const id = newId('t')
    const drawingId = addToDrawing('item', { id, kind: 'text', x: point[0], y: point[1] - size * 0.2, text: '', size: textSize, color: INK_COLOR }, box, inside)
    requestAnimationFrame(() => editText(drawingId, id))
  }
  function editText(drawingId, itemId) {
    commitText()
    const element = drawingElement(drawingId)
    const target = element?.querySelector(`.page-text-object[data-item="${itemId}"]`)
    const item = drawingById(drawingId)?.items?.find((entry) => entry.id === itemId)
    if (!target || !item) return
    const origin = drawingOrigin(element)
    const field = document.createElement('textarea')
    field.className = 'page-text-edit'
    field.value = item.text
    field.setAttribute('aria-label', 'Text object')
    Object.assign(field.style, { left: `${origin.x + item.x}px`, top: `${origin.y + item.y}px`, fontSize: target.style.fontSize, color: target.style.color })
    target.style.visibility = 'hidden'
    paper.append(field)
    const fit = () => { field.style.width = '1px'; field.style.height = '1px'; field.style.width = `${Math.max(60, field.scrollWidth + 8)}px`; field.style.height = `${field.scrollHeight}px` }
    field.addEventListener('input', fit)
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); event.stopPropagation(); commitText() }
    })
    field.addEventListener('blur', () => commitText())
    editingText = { field, drawingId, itemId, target }
    fit()
    field.focus()
  }
  function commitText() {
    if (!editingText) return
    const { field, drawingId, itemId, target } = editingText
    editingText = null
    const hadFocus = document.activeElement === field
    field.remove()
    if (hadFocus) host.focus({ preventScroll: true }) // Esc and Undo keep working after the text is done
    target.style.visibility = ''
    const entry = drawingById(drawingId)
    if (!entry) return
    const text = field.value.replace(/\s+$/, '')
    const item = entry.items.find((each) => each.id === itemId)
    if (!item || item.text === text) { if (item && !text) removeItem(entry, itemId); return }
    if (!text) { removeItem(entry, itemId); return }
    view.dispatch({ effects: updateDrawing.of({ id: drawingId, items: entry.items.map((each) => (each.id === itemId ? { ...each, text } : each)) }), annotations: isolateHistory.of('full') })
  }
  function removeItem(entry, itemId) {
    const rest = [...(entry.strokes ?? []), ...(entry.items ?? []).filter((each) => each.id !== itemId)]
    view.dispatch({ effects: eraseInk.of({ strokes: [{ drawing: entry.id, id: itemId }], drawings: rest.length ? [] : [entry.id] }) })
  }

  // ---------- link and fold (F-044) ----------
  function setLinking(id) {
    linking = id
    host.classList.toggle('page-linking', Boolean(id))
  }
  // A drawing linked to a word moves under that word's paragraph, and the word becomes its handle.
  function linkDrawing(drawingId, word) {
    const doc = view.state.doc
    const line = doc.lineAt(word.from)
    const under = line.number < doc.lines ? { pos: line.to + 1, side: -1 } : { pos: doc.length, side: 1 }
    view.dispatch({ effects: updateDrawing.of({ id: drawingId, ...under, folded: false, link: { pos: word.from, end: word.to, quote: quoteAt(doc, word.from, word.to) } }), annotations: isolateHistory.of('full') })
    glide()
  }
  // While a drawing opens or folds the page moves under the marks: keep repainting them until the slide ends.
  let gliding = 0
  function glide(ms = 700) {
    const until = performance.now() + ms
    cancelAnimationFrame(gliding)
    const tick = () => { paint(); if (performance.now() < until) gliding = requestAnimationFrame(tick); else { gliding = 0; view.requestMeasure() } }
    gliding = requestAnimationFrame(tick)
  }
  function fold(ids, folded) {
    if (!ids.length) return
    view.dispatch({ effects: foldDrawing.of({ ids, folded }), annotations: Transaction.addToHistory.of(false) })
    glide()
  }
  const linkedDrawings = () => view.state.field(drawingField).filter((entry) => entry.link)
  function syncFoldAll() {
    const linked = linkedDrawings()
    const button = toolbar.querySelector('[data-fold-all]')
    button.hidden = !linked.length
    button.textContent = linked.length && linked.every((entry) => entry.folded) ? 'Unfold all drawings' : 'Fold all drawings'
  }
  on(paper, 'click', (event) => {
    const linkButton = event.target.closest?.('[data-drawing-link]')
    if (linkButton) {
      event.preventDefault()
      const entry = drawingById(linkButton.dataset.drawingLink)
      if (!entry) return
      if (entry.link) view.dispatch({ effects: updateDrawing.of({ id: entry.id, link: null, folded: false }), annotations: isolateHistory.of('full') })
      else setLinking(entry.id)
      return
    }
    const foldButton = event.target.closest?.('[data-drawing-fold]')
    if (foldButton) { event.preventDefault(); fold([foldButton.dataset.drawingFold], true); return }
    const word = event.target.closest?.('.page-link-word')
    if (word && !drawMode && view.state.selection.main.empty) {
      const entry = drawingById(word.dataset.drawing)
      if (entry) fold([entry.id], !entry.folded)
    }
  })
  on(view.contentDOM, 'transitionend', (event) => { if (event.target.classList?.contains('page-drawing')) { view.requestMeasure(); paint() } })

  // ---------- modes and tools ----------
  function setMode(draw) {
    drawMode = draw
    host.classList.toggle('page-drawing-mode', draw)
    toolbar.querySelector('[data-page-mode="write"]').setAttribute('aria-pressed', String(!draw))
    toolbar.querySelector('[data-page-mode="draw"]').setAttribute('aria-pressed', String(draw))
    toolbar.querySelectorAll('[data-page-tool]').forEach((button) => button.setAttribute('aria-pressed', String(draw && button.dataset.pageTool === tool)))
    toolbar.querySelector('.page-text-sizes').hidden = !(draw && tool === 'text')
    if (!draw) {
      if (tool === 'eraser' || tool === 'text' || SHAPES[tool]) tool = 'pen'
      commitText()
      view.focus()
    }
  }
  on(toolbar, 'click', (event) => {
    if (event.target.closest('[data-fold-all]')) {
      const linked = linkedDrawings()
      fold(linked.map((entry) => entry.id), !linked.every((entry) => entry.folded))
      return
    }
    const mode = event.target.closest('[data-page-mode]')
    if (mode) setMode(mode.dataset.pageMode === 'draw')
    const pick = event.target.closest('[data-page-tool]')
    if (pick) { tool = pick.dataset.pageTool; setMode(true) }
    const size = event.target.closest('[data-text-size]')
    if (size) {
      textSize = size.dataset.textSize
      toolbar.querySelectorAll('[data-text-size]').forEach((button) => button.setAttribute('aria-pressed', String(button === size)))
    }
  })
  on(host, 'keydown', (event) => {
    if (event.target.closest?.('.page-text-edit')) return
    if (event.key === 'Escape' && linking) { event.preventDefault(); setLinking(null); return }
    if (event.key === 'Escape' && drawMode) { event.preventDefault(); setMode(false); return }
    // Undo/redo while the keyboard isn't in the text (Draw mode): the same history the text uses.
    const meta = event.metaKey || event.ctrlKey
    if (meta && !view.hasFocus && event.key.toLowerCase() === 'z') { event.preventDefault(); (event.shiftKey ? redo : undo)(view) }
    else if (meta && !view.hasFocus && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(view) }
  })
  host.tabIndex = -1

  return {
    toolbar,
    paint,
    setMode,
    drawingElement,
    destroy() {
      cancelAnimationFrame(hoverFrame)
      cancelAnimationFrame(gliding)
      commitText()
      for (const off of listeners) off()
      art.remove()
      toolbar.remove()
    },
  }
}
