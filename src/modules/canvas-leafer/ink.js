// The pen, the highlighter and the eraser on the Leafer canvas (F-031). A surface over the note takes the pointer; the stroke being
// drawn lives on a small canvas of its own (drawn a segment per pointer event, never the whole note again), and when the pen lifts
// the stroke becomes a model object, a Leafer node and one undo step. The eraser changes nodes as it passes and records the whole
// pass as one step. No Leafer import: the scene (scene.js) is reached through the few ink* methods it offers.
//
//   createInk({ host, scene, getDoc, getBrush, getPages, growPages, restore, cursor })
//     getBrush()    -> { tool: 'pen' | 'highlight', color: '#rrggbb', width }
//     getPages()    -> the page grid now ({ columns, rows }); growPages(point) adds a page when the pen goes past the edge, true if it did
//     restore()     -> draw the note again from the document (an erase pass that was cancelled)
//   ink.setTool(tool)   shows the surface for 'pen', 'highlight' and 'eraser', hides it for anything else
import { createEraser, drawOp, HIGHLIGHT_ALPHA, inkObject, topZ } from './ink-model.js'

export function createInk({ host, scene, getDoc, getBrush, getPages, growPages, restore, cursor }) {
  const surface = document.createElement('div')
  surface.className = 'ink-surface'
  surface.hidden = true
  const liveCanvas = document.createElement('canvas')
  liveCanvas.className = 'ink-live'
  surface.append(liveCanvas)
  host.append(surface)

  let tool = null
  let gesture = null
  let ctx = null

  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

  function prepareLive(brush) {
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1)
    const width = Math.max(1, Math.round(surface.clientWidth * ratio))
    const height = Math.max(1, Math.round(surface.clientHeight * ratio))
    if (liveCanvas.width !== width || liveCanvas.height !== height) { liveCanvas.width = width; liveCanvas.height = height; ctx = null }
    ctx ||= liveCanvas.getContext('2d', { desynchronized: true })
    // The stroke is drawn opaque and the whole canvas is shown at the highlighter's opacity: overlapping segments never darken.
    liveCanvas.style.opacity = brush.tool === 'highlight' ? String(HIGHLIGHT_ALPHA) : '1'
    liveCanvas.style.visibility = 'visible'
    transform(ratio)
    ctx.clearRect(0, 0, width, height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = brush.width
    ctx.strokeStyle = brush.color
    ctx.fillStyle = brush.color
    return ratio
  }

  function transform(ratio) {
    const view = scene.view()
    ctx.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y)
  }

  function drawDot(point) {
    ctx.beginPath()
    ctx.arc(point.x, point.y, gesture.brush.width / 2, 0, Math.PI * 2)
    ctx.fill()
  }

  // The segment that the newest point adds, through the same quadratic midpoints the saved path uses.
  function drawSegment(points) {
    const last = points.length - 1
    const from = points[last - 1]
    const to = points[last]
    const start = last >= 2 ? midpoint(points[last - 2], from) : from
    const end = midpoint(from, to)
    ctx.beginPath()
    ctx.moveTo(start.x, start.y)
    ctx.quadraticCurveTo(from.x, from.y, end.x, end.y)
    ctx.stroke()
  }

  // The view changed under a stroke (the page grid grew): draw what there is again in the new view.
  function redrawLive() {
    transform(gesture.ratio)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height)
    ctx.restore()
    drawDot(gesture.points[0])
    for (let count = 2; count <= gesture.points.length; count += 1) drawSegment(gesture.points.slice(0, count))
  }

  const toPage = (event) => {
    const view = scene.view()
    return { x: (event.clientX - gesture.rect.left - view.x) / view.scale, y: (event.clientY - gesture.rect.top - view.y) / view.scale }
  }

  function showCursor(event) {
    if (tool !== 'eraser' || !cursor) return
    cursor.hidden = false
    cursor.style.left = `${event.clientX}px`
    cursor.style.top = `${event.clientY}px`
  }
  const hideCursor = () => { if (cursor) cursor.hidden = true }

  function applyErase(change) {
    if (!change) return
    scene.inkRemove(change.removed)
    scene.inkAdd(change.added)
  }

  function hideLive() {
    liveCanvas.style.visibility = 'hidden'
  }

  function pagesOp() {
    const now = getPages()
    const before = getDoc().page
    if (!now || (now.columns === before.columns && now.rows === before.rows)) return null
    return { before: { ...before }, after: { ...before, columns: now.columns, rows: now.rows } }
  }

  function begin(event) {
    const brush = getBrush()
    gesture = { pointerId: event.pointerId, tool, brush: { ...brush, tool }, rect: surface.getBoundingClientRect(), points: [] }
    const point = toPage(event)
    if (tool === 'eraser') {
      gesture.eraser = createEraser(getDoc())
      gesture.last = point
      applyErase(gesture.eraser.at(point))
      return
    }
    gesture.ratio = prepareLive(gesture.brush)
    gesture.points.push(point)
    drawDot(point)
  }

  function extend(event) {
    const events = (event.getCoalescedEvents?.() ?? []).filter(Boolean)
    let point = null
    for (const item of events.length ? events : [event]) {
      point = toPage(item)
      if (gesture.tool === 'eraser') {
        applyErase(gesture.eraser.between(gesture.last, point))
        gesture.last = point
        continue
      }
      const previous = gesture.points.at(-1)
      if (previous.x === point.x && previous.y === point.y) continue
      gesture.points.push(point)
      drawSegment(gesture.points)
    }
    if (gesture.tool !== 'eraser' && point && growPages?.(point)) redrawLive()
  }

  function finish() {
    const done = gesture
    gesture = null
    if (done.tool === 'eraser') {
      const op = done.eraser.plan()
      if (op) scene.inkCommit(op)
      return
    }
    const doc = getDoc()
    const object = inkObject({ points: done.points, tool: done.tool, color: done.brush.color, width: done.brush.width, z: topZ(doc), scale: scene.view().scale })
    scene.inkAdd([object]) // on screen first, then the step: the pen lifts and the stroke is already the note's own
    scene.flush()
    hideLive()
    scene.inkCommit(drawOp(object, pagesOp()))
  }

  // A stroke the system took away (a second finger for a pinch, the window lost the pointer): nothing is kept.
  function cancel() {
    if (!gesture) return
    const done = gesture
    gesture = null
    hideLive()
    if (done.tool === 'eraser' && done.eraser.changed) restore()
  }

  surface.addEventListener('pointerdown', (event) => {
    if (!tool || gesture || event.button > 0 || !event.isPrimary) return
    event.preventDefault()
    try { surface.setPointerCapture(event.pointerId) } catch { /* a synthetic or already-ended pointer: the stroke still works */ }
    begin(event)
  })
  surface.addEventListener('pointermove', (event) => {
    showCursor(event)
    if (!gesture || event.pointerId !== gesture.pointerId) return
    event.preventDefault()
    extend(event)
  })
  const up = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    event.preventDefault()
    extend(event)
    finish()
  }
  // Capture: the touch pan and pinch handlers (main.js) stop a touch's pointerup for themselves; a stroke must still see it end.
  surface.addEventListener('pointerup', up, { capture: true })
  surface.addEventListener('pointercancel', (event) => { if (gesture && event.pointerId === gesture.pointerId) cancel() }, { capture: true })
  surface.addEventListener('pointerleave', () => { if (!gesture) hideCursor() })
  surface.addEventListener('contextmenu', (event) => event.preventDefault())

  return {
    surface,
    setTool(next) {
      tool = next === 'pen' || next === 'highlight' || next === 'eraser' ? next : null
      cancel()
      surface.hidden = !tool
      surface.dataset.tool = tool ?? ''
      if (tool !== 'eraser') hideCursor()
    },
    cancel,
    get active() { return Boolean(gesture) },
  }
}
