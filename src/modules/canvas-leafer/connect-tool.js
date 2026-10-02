// The connect tool on the Leafer canvas (F-032): press on one object, drag to another, let go, and an arrow joins them. A surface over the
// note takes the pointer while the tool is on (like the pen's, ink.js); the preview (outline of the object under the pointer, a dot, the arrow
// being drawn) is the scene's, and the arrow is made by the scene as one undo step. No Leafer import: the scene is reached through
// connectTargetAt, connectPreview and createConnector.
export function createConnectTool({ host, scene, getColor = () => undefined, onCreated = () => {} }) {
  const surface = document.createElement('div')
  surface.className = 'connect-surface'
  surface.hidden = true
  host.append(surface)

  let active = false
  let gesture = null // { pointerId, source }
  let hover = null

  const toPage = (event) => {
    const view = scene.view()
    const rect = surface.getBoundingClientRect()
    return { x: (event.clientX - rect.left - view.x) / view.scale, y: (event.clientY - rect.top - view.y) / view.scale }
  }

  function preview(point) {
    if (gesture) scene.connectPreview({ source: gesture.source, hover, pointer: point })
    else scene.connectPreview(hover ? { hover } : null)
  }

  // Nothing is made: the preview goes. Returns true when an arrow was being drawn.
  function cancel() {
    const was = Boolean(gesture)
    gesture = null
    hover = null
    scene.connectPreview(null)
    return was
  }

  surface.addEventListener('pointerdown', (event) => {
    if (!active || gesture || event.button > 0 || !event.isPrimary) return
    const point = toPage(event)
    const source = scene.connectTargetAt(point)
    if (!source) return
    event.preventDefault()
    try { surface.setPointerCapture(event.pointerId) } catch { /* a synthetic or already-ended pointer: the arrow still works */ }
    gesture = { pointerId: event.pointerId, source }
    hover = null
    preview(point)
  })
  surface.addEventListener('pointermove', (event) => {
    if (!active) return
    if (gesture && event.pointerId !== gesture.pointerId) return
    const point = toPage(event)
    const next = scene.connectTargetAt(point, gesture?.source ?? null)
    if (next === hover && !gesture) return
    hover = next
    preview(point)
  })
  surface.addEventListener('pointerup', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    event.preventDefault()
    const { source } = gesture
    const target = scene.connectTargetAt(toPage(event), source)
    gesture = null
    hover = null
    scene.connectPreview(null)
    if (!target) return
    const id = scene.createConnector(source, target, getColor())
    if (id) onCreated(id)
  }, { capture: true })
  surface.addEventListener('pointercancel', (event) => { if (gesture && event.pointerId === gesture.pointerId) cancel() }, { capture: true })
  surface.addEventListener('pointerleave', () => { if (!gesture) { hover = null; scene.connectPreview(null) } })
  surface.addEventListener('contextmenu', (event) => event.preventDefault())

  return {
    surface,
    setTool(next) {
      active = next === 'connect'
      cancel()
      surface.hidden = !active
    },
    cancel,
    get active() { return Boolean(gesture) },
  }
}
