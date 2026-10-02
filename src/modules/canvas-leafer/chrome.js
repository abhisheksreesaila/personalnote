// The desk furniture of a canvas note, as plain primitives in SCREEN pixels: the page tiles with their shadow, edge and paper,
// the dashed fold lines between pages and the "Page N" labels. Every metric below is a constant number of screen pixels (the former
// Fabric engine drew the same things in world units divided by the zoom).
// Pure, so the rules are tested without a canvas; scene.js turns the primitives into Leafer nodes.
import { shadowBands } from '../editor/viewport.js'

export const FOLD_COLOR = 'rgba(31, 27, 22, .13)' // paper is light in every skin
export const FOLD_DASH = [6, 5]
export const FOLD_WIDTH = 1.5
export const LABEL_FONT_SIZE = 10.5
export const LABEL_FONT_FAMILY = '"Geist Mono", ui-monospace, monospace'
export const SHADOW_STEPS = 32
const LABEL_LIMIT = 400

// view = { x, y, scale }: where the page frame's origin is on screen, and the zoom.
export function pageChrome({ view, viewW, viewH, columns, rows, pageW, pageH, colors }) {
  const s = view.scale
  const left = view.x
  const top = view.y
  const width = columns * pageW * s
  const height = rows * pageH * s
  if (!(width > 0) || !(height > 0)) return { shadows: [], edge: null, paper: null, folds: [], labels: [] }

  const shadows = []
  for (const layer of colors.shadows ?? []) {
    for (const band of shadowBands({ blur: layer.blur, spread: layer.spread, alpha: layer.peak }, SHADOW_STEPS)) {
      shadows.push({
        x: left - band.grow + layer.x, y: top - band.grow + layer.y,
        width: width + band.grow * 2, height: height + band.grow * 2,
        fill: layer.rgb, alpha: band.alpha,
      })
    }
  }

  const hairline = 1
  const radius = colors.radius
  const edge = { x: left - hairline, y: top - hairline, width: width + hairline * 2, height: height + hairline * 2, radius: radius + hairline, fill: colors.edge }
  const paper = { x: left, y: top, width, height, radius, fill: colors.paper }

  const folds = []
  for (let column = 1; column < columns; column += 1) folds.push({ x1: left + column * pageW * s, y1: top, x2: left + column * pageW * s, y2: top + height })
  for (let row = 1; row < rows; row += 1) folds.push({ x1: left, y1: top + row * pageH * s, x2: left + width, y2: top + row * pageH * s })

  // "Page N" under each page of the bottom row; upper rows touch the page below, so theirs sit inside the corner.
  const labels = []
  if (columns * rows <= LABEL_LIMIT) {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const pageLeft = left + column * pageW * s
        const pageBottom = top + (row + 1) * pageH * s
        if (pageLeft > viewW || pageLeft + pageW * s < 0 || pageBottom > viewH + 40 || pageBottom < -40) continue
        const last = row === rows - 1
        labels.push({ text: `Page ${row * columns + column + 1}`, x: pageLeft + (last ? 0 : 14), y: pageBottom + (last ? 11 : -26) })
      }
    }
  }
  return { shadows, edge, paper, folds, labels }
}
