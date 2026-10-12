// The stress note (F-034), for the benchmark script and for the speed test inside the app: a seeded, JSON Canvas note with stickies (the F-002 benchmark note has none), a mix like a real busy desk
// (37% text, 21% stickies, 16% shapes, 26% pen lines, plus arrows between neighbouring shapes), spread over a grid of pages.
// `generateStressDocument(5400)` is the 5,000+ object note the performance numbers use. Seeded, so every run builds the same note.
import { writeJsonCanvas } from '../../core/document/jsoncanvas.js'

const PAGE_WIDTH = 860
const PAGE_HEIGHT = 1080
const UPRIGHT = { rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 }
const STICKY_COLORS = ['#ffd60a', '#ffb4a2', '#a8e6a1', '#a2d2ff', '#e0b0ff']
const TEXTS = ['Meeting notes: ship the export', 'Idea: spatial search across pages', 'TODO - draw - link - review', 'Call back about the invoice', 'Chapter 3 outline']

export function generateStressDocument(count = 5400, { columns = 4, rows = 4 } = {}) {
  let seed = 11
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const objects = []
  let z = 0
  const spot = (width, height) => ({
    x: Math.floor(random() * columns) * PAGE_WIDTH + 20 + random() * (PAGE_WIDTH - width - 40),
    y: Math.floor(random() * rows) * PAGE_HEIGHT + 20 + random() * (PAGE_HEIGHT - height - 40),
  })
  const shapes = []
  const total = Math.round(count / 1.1) // a tenth more are arrows
  for (let i = 0; i < total; i += 1) {
    const pick = random()
    if (pick < 0.37) {
      const width = 180 + random() * 120
      const height = 60 + random() * 50
      const at = spot(width, height)
      objects.push({ id: `t${i}`, type: 'text', mode: 'box', z: z++, content: TEXTS[i % TEXTS.length], style: { fontFamily: 'Source Serif 4', fontSize: 18 + (i % 3) * 3, color: '#222222', lineHeight: 1.45 }, geometry: { ...at, width, height, ...UPRIGHT } })
    } else if (pick < 0.58) {
      const at = spot(220, 170)
      objects.push({ id: `s${i}`, type: 'sticky', z: z++, content: TEXTS[(i + 2) % TEXTS.length], color: STICKY_COLORS[i % STICKY_COLORS.length], style: { fontFamily: 'Geist', fontSize: 18, color: '#292202', lineHeight: 1.4 }, geometry: { ...at, width: 220, height: 170, ...UPRIGHT } })
    } else if (pick < 0.74) {
      const width = 120 + random() * 160
      const height = 80 + random() * 120
      const at = spot(width, height)
      const shape = { id: `r${i}`, type: 'shape', kind: 'rect', z: z++, cornerRadius: 6, fill: 'rgba(80,120,200,0.15)', stroke: '#4a6fb0', strokeWidth: 2, geometry: { ...at, width, height, ...UPRIGHT } }
      shapes.push(shape)
      objects.push(shape)
    } else {
      const at = spot(240, 90)
      let px = 0
      let py = 45
      const path = [['M', px, py]]
      const points = [{ x: px, y: py }]
      for (let k = 0; k < 60; k += 1) {
        const nx = px + 4 + random() * 4
        const ny = Math.max(2, Math.min(88, py + (random() - 0.5) * 12))
        path.push(['Q', px, py, (px + nx) / 2, (py + ny) / 2])
        points.push({ x: nx, y: ny })
        px = nx
        py = ny
      }
      objects.push({ id: `i${i}`, type: 'ink', z: z++, kind: 'stroke', tool: 'pen', color: '#223344', width: 2.5, cap: 'round', join: 'round', path, points, geometry: { ...at, width: Math.ceil(px), height: 90, ...UPRIGHT } })
    }
  }
  // arrows between shapes that are neighbours in the list (their stored box is wrong on purpose: the app works it out again when the note opens)
  for (let i = 0; i + 1 < shapes.length && objects.length < count; i += 2) {
    objects.push({ id: `c${i}`, type: 'connector', z: z++, fromId: shapes[i].id, toId: shapes[i + 1].id, color: '#20201e', lineWidth: 2.6, reverseX: false, reverseY: false, geometry: { x: 1, y: 1, width: 5, height: 5, ...UPRIGHT } })
  }
  return { schemaVersion: 1, page: { columns, rows }, objects, extras: {} }
}

// What the mocked /api serves for a note: JSON Canvas content and its page grid.
export function generateStressNote(count, grid) {
  const doc = generateStressDocument(count, grid)
  return { content: writeJsonCanvas(doc, { derived: 'omit' }), pageState: { columns: doc.page.columns, rows: doc.page.rows }, objects: doc.objects.length }
}
