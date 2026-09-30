import { Textbox, classRegistry } from 'fabric'
import { STICKY_MIN_HEIGHT, STICKY_PADDING } from './objects.js'

export const STICKY_TYPE = 'Sticky'
const CORNERS = [4, 4, 24, 4]

// A coloured handwriting note. It is an ordinary Textbox (so its text is editable in place, searchable and
// exported like any other text) that paints its own paper-like background and inset padding, which keeps
// the object's bounding box equal to what you see, so connectors and page growth treat it as a whole note.
export class Sticky extends Textbox {
  static type = STICKY_TYPE

  static ownDefaults = {
    objectCaching: false,
    lockScalingY: true,
    stickyColor: '#ffd60a',
    splitByGrapheme: false,
  }

  static getDefaults() {
    return { ...super.getDefaults(), ...Sticky.ownDefaults }
  }

  constructor(text, options) {
    super(text, { ...Sticky.ownDefaults, ...options })
  }

  calcTextHeight() {
    return Math.max(super.calcTextHeight() + STICKY_PADDING * 2, STICKY_MIN_HEIGHT)
  }

  _wrapText(lines, desiredWidth) {
    return super._wrapText(lines, desiredWidth - STICKY_PADDING * 2)
  }

  _getLeftOffset() {
    return super._getLeftOffset() + STICKY_PADDING
  }

  _getTopOffset() {
    return super._getTopOffset() + STICKY_PADDING
  }

  _renderBackground(ctx) {
    ctx.save()
    ctx.shadowColor = 'rgba(0, 0, 0, .26)'
    ctx.shadowBlur = 16
    ctx.shadowOffsetY = 9
    ctx.fillStyle = this.stickyColor
    ctx.beginPath()
    ctx.roundRect(-this.width / 2, -this.height / 2, this.width, this.height, CORNERS)
    ctx.fill()
    ctx.restore()
  }

  toObject(propertiesToInclude = []) {
    return { ...super.toObject(propertiesToInclude), stickyColor: this.stickyColor }
  }
}

classRegistry.setClass(Sticky, STICKY_TYPE)
