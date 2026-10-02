// The F-002 benchmark note (600 objects, 12 pages): seeded, so every run builds the same note.
// Shared by the canvas benchmark and the document-model fixtures.
import { connectorBox, connectorEndpoints } from '../src/modules/editor/connectors.js'

export const PAGE_WIDTH = 860
export const PAGE_HEIGHT = 1080
export const COLUMNS = 3
export const ROWS = 4

let seed = 7
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

function inkPath(x, y) {
  const commands = [['M', x, y]]
  let px = x
  let py = y
  for (let i = 0; i < 120; i += 1) {
    const nx = px + (random() - 0.4) * 8
    const ny = py + (random() - 0.5) * 8
    commands.push(['Q', px, py, (px + nx) / 2, (py + ny) / 2])
    px = nx
    py = ny
  }
  return {
    type: 'Path', version: '7.4.0', left: x, top: y, originX: 'left', originY: 'top',
    fill: null, stroke: '#223', strokeWidth: 2.5, strokeLineCap: 'round', strokeLineJoin: 'round',
    path: commands, isInk: true,
  }
}

export function generateNote({ connectors: withConnectors = true } = {}) {
  seed = 7
  const place = () => ({
    x: Math.floor(random() * COLUMNS) * PAGE_WIDTH + 40 + random() * (PAGE_WIDTH - 640),
    y: Math.floor(random() * ROWS) * PAGE_HEIGHT + 40 + random() * (PAGE_HEIGHT - 480),
  })
  const objects = []
  const rects = []
  const texts = ['Meeting notes: ship the export', 'Idea: spatial search\nacross pages', 'TODO\n- draw\n- link\n- review']
  for (let i = 0; i < 300; i += 1) {
    const { x, y } = place()
    objects.push({
      type: 'IText', version: '7.4.0', originX: 'left', originY: 'top', left: x, top: y, text: texts[i % 3], fontSize: 20 + (i % 3) * 4,
      fontFamily: 'Source Serif 4', fill: '#222', lineHeight: 1.45, padding: 8,
    })
  }
  for (let i = 0; i < 240; i += 1) { const { x, y } = place(); objects.push(inkPath(x, y)) }
  for (let i = 0; i < 60; i += 1) {
    const { x, y } = place()
    const width = 120 + random() * 160
    const height = 80 + random() * 120
    rects.push({ left: x, top: y, width, height })
    objects.push({
      type: 'Rect', version: '7.4.0', semanticId: `res_rect_${i}`, originX: 'left', originY: 'top', left: x, top: y, width, height,
      fill: 'rgba(80,120,200,0.15)', stroke: '#4a6fb0', strokeWidth: 2, rx: 6, ry: 6,
    })
  }
  // Connector scenario: rect 3 (the one the drag scenarios move) carries several arrows, and
  // 40 more link other rects. Geometry is recomputed from the endpoints on load.
  const links = [[3, 4], [3, 5], [6, 3], [3, 7], [8, 3], [3, 9]]
  for (let i = 10; i < 50; i += 1) links.push([i, i + 1])
  // Saved geometry is real (edge to edge), so the fixture loads exactly as a saved note would.
  if (withConnectors) links.forEach(([from, to], index) => {
    const ends = connectorEndpoints(rects[from], rects[to])
    if (!ends.visible) return
    const box = connectorBox(ends.start, ends.end)
    objects.push({
      type: 'Connector', version: '7.4.0', semanticId: `res_conn_${index}`, fromId: `res_rect_${from}`, toId: `res_rect_${to}`,
      originX: 'center', originY: 'center', left: box.left + box.width / 2, top: box.top + box.height / 2, width: box.width, height: box.height,
      reverseX: box.reverseX, reverseY: box.reverseY, fill: null, strokeWidth: 0, lineWidth: 2.6, color: '#223',
    })
  })
  return { version: '7.4.0', objects }
}
