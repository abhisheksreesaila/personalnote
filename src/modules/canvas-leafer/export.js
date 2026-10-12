// Print sheets and the note as a picture, from the Leafer render (F-033). The page grid is columns x rows pages of PAGE.width x PAGE.height
// page pixels; a print sheet is one page at twice that resolution on white paper, exactly what the Fabric sheets were, and the picture
// of the whole note is the same grid in one image. The drawing itself is scene.renderRegion; this file decides what to ask it for.
import { PAGE } from '../../core/document/index.js'

export const SHEET_PIXEL_RATIO = 2
const MAX_PICTURE_PIXELS = 16_000_000 // the most a canvas can hold in every web view (Safari's limit)

// The pages of a grid in reading order: row by row, left to right.
export function sheetCells({ columns, rows }) {
  const cells = []
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) cells.push({ column, row, index: row * columns + column })
  return cells
}

export const sheetRegion = ({ column, row }) => ({ x: column * PAGE.width, y: row * PAGE.height, width: PAGE.width, height: PAGE.height })

export const noteRegion = ({ columns, rows }) => ({ x: 0, y: 0, width: columns * PAGE.width, height: rows * PAGE.height })

// Twice the page resolution, less for a grid too big for one canvas.
export function pictureScale({ columns, rows }) {
  const area = columns * PAGE.width * rows * PAGE.height
  return Math.min(SHEET_PIXEL_RATIO, Math.sqrt(MAX_PICTURE_PIXELS / area))
}

// One print sheet as a PNG blob. `scene` is the Leafer canvas.
export const renderSheet = (scene, cell) => scene.renderRegion(sheetRegion(cell), { pixelRatio: SHEET_PIXEL_RATIO, type: 'image/png' })

// The whole note as one PNG blob.
export const renderNotePicture = (scene, pages) => scene.renderRegion(noteRegion(pages), { pixelRatio: pictureScale(pages), type: 'image/png' })
