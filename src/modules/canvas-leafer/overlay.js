// What is drawn over (or under) the note while it is edited, none of it part of the note (F-032): the ghost of the page that would be added,
// the halo of a selected connector, the connect tool's outlines and draft arrow, and the layer a dragged object moves in. Leafer is
// imported here, in scene.js and in editing.js and nowhere else. The ghost sits with the page furniture (screen space, under the objects,
// like the Fabric path's before:render pass); everything else lives in the sky layer, in page space with the same view transform as the
// note, with strokes sized in screen pixels (divided by the zoom, as the Fabric path does).
import { Ellipse, Group, Path, Rect, Text } from 'leafer-ui'
import { arrowPathFrom } from './connectors.js'

const GHOST_LABEL_FONT = 'Geist, system-ui, sans-serif'

export function createOverlays({ app, chrome }) {
  // ---- the sky layer: page space, same view as the note
  const skyWorld = new Group({ hittable: false, hitChildren: false })
  app.sky.add(skyWorld)
  const dragLayer = new Group({ hittable: false, hitChildren: false }) // a dragged object (and its arrows) moves here, away from the 600 others
  const haloNode = new Path({ hittable: false, visible: false, path: 'M 0 0', strokeCap: 'round', strokeJoin: 'round', opacity: 0.4 })
  const outlines = [new Rect({ hittable: false, visible: false }), new Rect({ hittable: false, visible: false })]
  const draft = new Path({ hittable: false, visible: false, path: 'M 0 0', strokeCap: 'round', strokeJoin: 'round', opacity: 0.75 })
  const dots = [new Ellipse({ hittable: false, visible: false }), new Ellipse({ hittable: false, visible: false })]
  for (const node of [dragLayer, haloNode, ...outlines, draft, ...dots]) skyWorld.add(node)

  // ---- the ghost: in the page furniture, screen space
  const ghostGroup = new Group({ hittable: false, visible: false })
  const ghostPaper = new Rect({ hittable: false, opacity: 0.55 })
  const ghostEdge = new Rect({ hittable: false, dashPattern: [8, 6], strokeWidth: 1.5, strokeAlign: 'center' })
  const pill = new Rect({ hittable: false })
  const plus = new Path({ hittable: false, strokeWidth: 2, strokeCap: 'round', path: 'M 0 0' })
  const label = new Text({ hittable: false, fontFamily: GHOST_LABEL_FONT, fontSize: 11.5, fontWeight: 500, lineHeight: 11.5, textWrap: 'none', text: '' })
  for (const node of [ghostPaper, ghostEdge, pill, plus, label]) ghostGroup.add(node)
  chrome.add(ghostGroup)

  let view = { x: 0, y: 0, scale: 1 }
  let colors = { paper: '#fbfaf5', accent: '#4D839C', accentInk: '#ffffff' }
  let ghost = null
  let halo = null
  let connect = null

  function drawGhost() {
    ghostGroup.visible = Boolean(ghost)
    if (!ghost) return
    const { left, top, width, height } = ghost.rect
    const x = view.x + left * view.scale
    const y = view.y + top * view.scale
    const w = width * view.scale
    const h = height * view.scale
    ghostPaper.set({ x, y, width: w, height: h, fill: colors.paper })
    ghostEdge.set({ x, y, width: w, height: h, stroke: colors.accent })
    label.set({ text: `Page ${ghost.pageNumber}`, fill: colors.accentInk })
    const textWidth = label.getBounds('box', 'inner').width
    const pillHeight = 26
    const pillWidth = textWidth + 34
    const pillX = x + 16
    const pillY = y + 16
    const middle = pillY + pillHeight / 2
    pill.set({ x: pillX, y: pillY, width: pillWidth, height: pillHeight, cornerRadius: pillHeight / 2, fill: colors.accent })
    plus.set({ x: 0, y: 0, stroke: colors.accentInk, path: `M ${pillX + 10} ${middle} L ${pillX + 18} ${middle} M ${pillX + 14} ${middle - 4} L ${pillX + 14} ${middle + 4}` })
    label.set({ x: pillX + 24, y: middle - 11.5 / 2 + 0.5 })
  }

  function drawHalo() {
    haloNode.visible = Boolean(halo)
    if (!halo) return
    haloNode.set({ x: halo.x, y: halo.y, path: halo.path, stroke: colors.accent, fill: colors.accent, strokeWidth: halo.lineWidth + 7 })
  }

  function drawConnect() {
    const scale = view.scale
    const spec = connect
    for (const node of [...outlines, draft, ...dots]) node.visible = false
    if (!spec) return
    const pad = 4 / scale
    spec.outlines.forEach((box, index) => {
      outlines[index].set({ visible: true, x: box.left - pad, y: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2, stroke: colors.accent, strokeWidth: 2 / scale })
    })
    if (spec.arrow) draft.set({ visible: true, path: arrowPathFrom(spec.arrow.start, spec.arrow.end), stroke: colors.accent, fill: colors.accent, strokeWidth: 2.6 })
    spec.dots.forEach((point, index) => {
      dots[index].set({ visible: true, x: point.x - 5 / scale, y: point.y - 5 / scale, width: 10 / scale, height: 10 / scale, fill: colors.accent, stroke: '#ffffff', strokeWidth: 1.5 / scale })
    })
  }

  return {
    skyWorld,
    dragLayer,
    // `view` places the page furniture (the grid's frame); `noteView` the note's own layer (the same, unless a drag has added pages on the
    // top or left and the nodes have not moved yet).
    setView(next, noteView = next) {
      view = { ...next }
      skyWorld.set({ x: noteView.x, y: noteView.y, scaleX: noteView.scale, scaleY: noteView.scale })
      drawGhost()
      drawConnect()
    },
    setColors(next) { colors = { ...colors, ...next }; drawGhost(); drawHalo(); drawConnect() },
    // { rect: { left, top, width, height } (page space), pageNumber } or null.
    showGhost(next) { ghost = next; drawGhost() },
    // The selected connector: { path (in its own box frame), x, y, lineWidth } or null.
    showHalo(next) { halo = next; drawHalo() },
    // The connect tool: { outlines: [box], dots: [point], arrow: { start, end } | null } (page space) or null.
    showConnect(next) { connect = next; drawConnect() },
    destroy() { skyWorld.destroy?.() },
  }
}
