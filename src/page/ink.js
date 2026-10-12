// The ink layer on a page note (F-042..F-044): the toolbar, drawing with a mouse, pen or Apple Pencil, and painting marks and drawings
// over the Markdown. The state lives in ink-state.js (inside CodeMirror's state); this module only reads it and dispatches effects.
//
// Who gets a press: a pen always draws and a finger always scrolls. A mouse types on words and draws on empty space (margins, blank
// lines, past a line's end, below the text); in Draw mode, or with Alt held, it draws everywhere. Esc goes back to writing.
import { EditorSelection, StateEffect } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import { isolateHistory, undo, redo } from '@codemirror/commands'
import { addMark, eraseInk, markField, quoteAt } from './ink-state.js'

const SVG = 'http://www.w3.org/2000/svg'
export const TOOLS = {
  pen: { label: 'Pen', color: '#1d3f9e', width: 2.4, opacity: 1 },
  red: { label: 'Red', color: '#d23b26', width: 2.6, opacity: 1 },
  highlight: { label: 'Highlighter', color: '#ffd400', width: 16, opacity: 0.38 },
}
const INK_EFFECTS = [addMark, eraseInk]
export const isInkTransaction = (tr) => tr.effects.some((effect) => INK_EFFECTS.some((type) => effect.is(type)))

// A smooth path through the points (quadratic curves through the midpoints).
export function pathOf(points) {
  if (!points.length) return ''
  const [x0, y0] = points[0]
  if (points.length === 1) return `M${x0} ${y0} l0.1 0`
  let d = `M${x0} ${y0}`
  for (let i = 1; i < points.length - 1; i += 1) {
    const [x, y] = points[i]
    const [nx, ny] = points[i + 1]
    d += ` Q${x} ${y} ${round((x + nx) / 2)} ${round((y + ny) / 2)}`
  }
  const [xl, yl] = points[points.length - 1]
  return `${d} L${xl} ${yl}`
}
const round = (value) => Math.round(value * 10) / 10

export function strokeElement(tool, points) {
  const style = TOOLS[tool] ?? TOOLS.pen
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', pathOf(points))
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', style.color)
  path.setAttribute('stroke-width', style.width)
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  path.setAttribute('opacity', style.opacity)
  if (tool === 'highlight') path.style.mixBlendMode = 'multiply'
  return path
}

const bounds = (points) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  return { minX, minY, maxX, maxY }
}

const TOOLBAR = `
  <div class="page-toolbar" role="toolbar" aria-label="Page tools">
    <div class="page-tool-group" role="group" aria-label="Mode">
      <button type="button" data-page-mode="write" aria-pressed="true">Write</button>
      <button type="button" data-page-mode="draw" aria-pressed="false">Draw</button>
    </div>
    <div class="page-tool-group" role="group" aria-label="Ink">
      ${Object.entries(TOOLS).map(([id, tool]) => `<button type="button" data-page-tool="${id}" aria-pressed="false" title="${tool.label}"><span class="page-swatch" style="background:${tool.color}"></span>${tool.label}</button>`).join('')}
      <button type="button" data-page-tool="eraser" aria-pressed="false">Eraser</button>
    </div>
    <div class="page-tool-group page-tool-extra" role="group" aria-label="More"></div>
  </div>
  <div class="page-draw-hint" role="status">Drawing. Press Esc or Write to type again.</div>`

export function mountInkLayer({ view, host, paper, desk }) {
  host.querySelector('.page-desk').insertAdjacentHTML('afterbegin', TOOLBAR)
  const toolbar = host.querySelector('.page-toolbar')
  const art = document.createElementNS(SVG, 'svg')
  art.setAttribute('class', 'page-ink')
  art.setAttribute('aria-hidden', 'true')
  paper.append(art)

  let tool = 'pen'
  let drawMode = false
  let drawing = null
  const placed = new Map() // mark id -> its stroke's top-left on the paper, as last painted (for the eraser)
  const listeners = []
  const on = (target, type, handler, options) => { target.addEventListener(type, handler, options); listeners.push(() => target.removeEventListener(type, handler, options)) }

  // ---------- where things are, in paper pixels ----------
  const paperPoint = (clientX, clientY) => { const box = paper.getBoundingClientRect(); return [round(clientX - box.left), round(clientY - box.top)] }
  const column = () => {
    const box = paper.getBoundingClientRect()
    const content = view.contentDOM.getBoundingClientRect()
    return { left: content.left - box.left, right: content.right - box.left }
  }
  function originOf(mark, box, col) {
    if (mark.anchor?.pos == null) return null
    const at = view.coordsAtPos(Math.min(mark.anchor.pos, view.state.doc.length), 1)
    if (!at) return null
    return { x: mark.margin ? col.left : at.left - box.left, y: at.top - box.top }
  }

  // ---------- painting ----------
  const paint = () => view.requestMeasure({
    key: 'page-ink',
    read: () => {
      const box = paper.getBoundingClientRect()
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
  const painter = ViewPlugin.define(() => ({ update: (update) => { if (update.docChanged || update.geometryChanged || update.viewportChanged || update.transactions.some((tr) => tr.effects.length)) paint() } }))
  view.dispatch({ effects: StateEffect.appendConfig.of(painter) })
  paint()

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
  const wantsDraw = (event) => event.pointerType === 'pen' || drawMode || tool === 'eraser' || event.altKey || !onText(event.clientX, event.clientY)

  // ---------- turning a stroke into a mark ----------
  function markFor(points) {
    const { minX, minY, maxX, maxY } = bounds(points)
    const box = paper.getBoundingClientRect()
    const col = column()
    const margin = maxX < col.left + 4 || minX > col.right - 4
    // Underlines are flat: their words are just above them. Everything else is anchored to the word under its middle.
    const flat = maxY - minY < 16 && maxX - minX > 24
    const probeX = margin ? (maxX < col.left ? col.left + 2 : col.right - 2) : (minX + maxX) / 2
    const probeY = flat ? minY - 10 : (minY + maxY) / 2
    const pos = view.posAtCoords({ x: box.left + probeX, y: box.top + probeY }, false)
    const word = view.state.wordAt(pos)
    const from = word ? word.from : pos
    const to = word ? word.to : Math.min(pos + 1, view.state.doc.length)
    const mark = { id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, tool, points: points.map(([x, y]) => [round(x - minX), round(y - minY)]), anchor: { pos: from, end: to, quote: quoteAt(view.state.doc, from, to) }, dx: 0, dy: 0 }
    if (margin) mark.margin = true
    const origin = originOf(mark, box, col)
    mark.dx = round(minX - origin.x)
    mark.dy = round(minY - origin.y)
    return mark
  }

  // ---------- pointer ----------
  on(paper, 'pointerdown', (event) => {
    if (event.pointerType === 'touch') return // fingers scroll
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target.closest?.('button, input, textarea, .page-text-object')) return
    if (!wantsDraw(event)) return
    event.preventDefault()
    event.stopPropagation()
    paper.setPointerCapture(event.pointerId)
    const point = paperPoint(event.clientX, event.clientY)
    if (tool === 'eraser' || event.buttons === 32) { drawing = { erase: true }; eraseAt(point); return }
    const live = strokeElement(tool, [point])
    art.append(live)
    drawing = { points: [point], live }
  }, true)
  on(paper, 'pointermove', (event) => {
    if (!drawing) { hover(event); return }
    const events = event.getCoalescedEvents?.() ?? []
    for (const each of events.length ? events : [event]) {
      const point = paperPoint(each.clientX, each.clientY)
      if (drawing.erase) eraseAt(point)
      else drawing.points.push(point)
    }
    if (drawing.erase) return
    drawing.live.setAttribute('d', pathOf(drawing.points))
    const last = drawing.points[drawing.points.length - 1]
    if (last[1] > paper.offsetHeight - 160) growTo(paper.offsetHeight + 300) // the page grows as you draw past its bottom
    const area = desk.getBoundingClientRect()
    if (event.clientY > area.bottom - 40) desk.scrollTop += 14
    else if (event.clientY < area.top + 40) desk.scrollTop -= 14
  }, true)
  const finish = () => {
    if (!drawing) return
    const done = drawing
    drawing = null
    if (done.erase) return
    done.live.remove()
    if (done.points.length < 2) return
    view.dispatch({ effects: addMark.of(markFor(done.points)), annotations: isolateHistory.of('full') })
  }
  on(paper, 'pointerup', finish, true)
  on(paper, 'pointercancel', finish, true)
  // Apple Pencil on iPad: keep the page still under the pen while fingers still scroll.
  on(paper, 'touchstart', (event) => { if ([...event.touches].some((touch) => touch.touchType === 'stylus')) event.preventDefault() }, { passive: false })

  let hoverFrame = 0
  function hover(event) {
    if (hoverFrame || event.pointerType !== 'mouse') return
    hoverFrame = requestAnimationFrame(() => { hoverFrame = 0; paper.classList.toggle('page-draw-cursor', wantsDraw(event)) })
  }

  function eraseAt([x, y]) {
    const hit = []
    for (const mark of view.state.field(markField)) {
      const at = placed.get(mark.id)
      if (at && mark.points.some(([px, py]) => Math.hypot(at.x + px - x, at.y + py - y) < 12)) hit.push(mark.id)
    }
    if (hit.length) view.dispatch({ effects: eraseInk.of({ marks: hit }), annotations: isolateHistory.of('full') })
  }

  // ---------- modes and tools ----------
  function setMode(draw) {
    drawMode = draw
    host.classList.toggle('page-drawing', draw)
    toolbar.querySelector('[data-page-mode="write"]').setAttribute('aria-pressed', String(!draw))
    toolbar.querySelector('[data-page-mode="draw"]').setAttribute('aria-pressed', String(draw))
    toolbar.querySelectorAll('[data-page-tool]').forEach((button) => button.setAttribute('aria-pressed', String(draw && button.dataset.pageTool === tool)))
    if (!draw) {
      if (tool === 'eraser') tool = 'pen'
      view.focus()
    }
  }
  on(toolbar, 'click', (event) => {
    const mode = event.target.closest('[data-page-mode]')
    if (mode) setMode(mode.dataset.pageMode === 'draw')
    const pick = event.target.closest('[data-page-tool]')
    if (pick) { tool = pick.dataset.pageTool; setMode(true) }
  })
  on(host, 'keydown', (event) => {
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
    destroy() {
      cancelAnimationFrame(hoverFrame)
      for (const off of listeners) off()
      art.remove()
      toolbar.remove()
    },
  }
}
