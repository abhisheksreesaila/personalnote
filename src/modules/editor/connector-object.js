import { FabricObject, classRegistry } from 'fabric'
import { arrowHeadPoints, distanceToSegment, endpointsFromBox } from './connectors.js'

export const CONNECTOR_TYPE = 'Connector'
export const CONNECTOR_LINE_WIDTH = 2.6
const HEAD_SIZE = 15
const HIT_TOLERANCE = 9

// Draws a rounded-cap line with a filled arrowhead. Used by the canvas object, the
// print path (which reloads the same JSON into a StaticCanvas) and the live preview.
export function drawArrow(ctx, start, end, { color = '#20201e', width = CONNECTOR_LINE_WIDTH, halo = 0, haloColor = '#4D839C' } = {}) {
  const head = Math.min(HEAD_SIZE, Math.hypot(end.x - start.x, end.y - start.y) * 0.6)
  const [tip, wingA, wingB] = arrowHeadPoints(start, end, head)
  const base = { x: (wingA.x + wingB.x) / 2, y: (wingA.y + wingB.y) / 2 }
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (halo) {
    ctx.globalAlpha = 0.4
    ctx.strokeStyle = haloColor
    ctx.fillStyle = haloColor
    ctx.lineWidth = width + halo
    ctx.beginPath()
    ctx.moveTo(start.x, start.y)
    ctx.lineTo(base.x, base.y)
    ctx.moveTo(tip.x, tip.y)
    ctx.lineTo(wingA.x, wingA.y)
    ctx.lineTo(wingB.x, wingB.y)
    ctx.closePath()
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.lineTo(base.x, base.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(tip.x, tip.y)
  ctx.lineTo(wingA.x, wingA.y)
  ctx.lineTo(wingB.x, wingB.y)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

// An arrow between two canvas objects, stored as a box plus direction flags so
// translating the box translates the arrow. fromId / toId are the objects' semanticIds.
export class Connector extends FabricObject {
  static type = CONNECTOR_TYPE

  // Skin accent, set by the app whenever page colours refresh.
  static haloColor = '#4D839C'

  static ownDefaults = {
    originX: 'center',
    originY: 'center',
    strokeWidth: 0,
    fill: null,
    objectCaching: false,
    hasControls: false,
    lockMovementX: true,
    lockMovementY: true,
    lockScalingX: true,
    lockScalingY: true,
    lockRotation: true,
    hasBorders: false,
    hoverCursor: 'pointer',
    perPixelTargetFind: false,
    fromId: '',
    toId: '',
    reverseX: false,
    reverseY: false,
    lineWidth: CONNECTOR_LINE_WIDTH,
    color: '#20201e',
  }

  static getDefaults() {
    return { ...super.getDefaults(), ...Connector.ownDefaults }
  }

  constructor(options) {
    super()
    Object.assign(this, Connector.ownDefaults)
    this.setOptions(options)
  }

  // ConnectorIndex keys connectors by their stable semanticId.
  get id() { return this.semanticId }

  // Fabric positions by centre, so `left`/`top` hold the box centre.
  endpoints() {
    return endpointsFromBox({
      left: this.left - this.width / 2, top: this.top - this.height / 2, width: this.width, height: this.height,
      reverseX: this.reverseX, reverseY: this.reverseY,
    })
  }

  applyBox({ left, top, width, height, reverseX, reverseY }) {
    this.set({ left: left + width / 2, top: top + height / 2, width, height, reverseX, reverseY })
    this.setCoords()
    this.dirty = true
  }

  _render(ctx) {
    const { start, end } = this.endpoints()
    // Fabric has translated to the box centre; draw in box-local coordinates.
    const local = (p) => ({ x: p.x - this.left, y: p.y - this.top })
    const selected = this.canvas?.getActiveObject?.() === this
    drawArrow(ctx, local(start), local(end), { color: this.color, width: this.lineWidth, halo: selected ? 7 : 0, haloColor: Connector.haloColor })
  }

  // Only the line itself is clickable, not the whole diagonal bounding box.
  containsPoint(point) {
    const { start, end } = this.endpoints()
    const zoom = this.canvas?.getZoom?.() || 1
    return distanceToSegment(point, start, end) <= HIT_TOLERANCE / zoom
  }

  // Rubber-band selection never grabs connectors; click one to select it.
  intersectsWithRect() { return false }

  isContainedWithinRect() { return false }

  toObject(propertiesToInclude = []) {
    return {
      ...super.toObject(propertiesToInclude),
      fromId: this.fromId,
      toId: this.toId,
      reverseX: this.reverseX,
      reverseY: this.reverseY,
      lineWidth: this.lineWidth,
      color: this.color,
    }
  }
}

classRegistry.setClass(Connector, CONNECTOR_TYPE)
