// F-030: memory and time per undo step on a 600-object note. `node --expose-gc scripts/benchmark-history.mjs`
import { createHistory } from '../src/core/document/history.js'

const geometry = (x, y) => ({ x, y, width: 220, height: 120, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 })
const objects = Array.from({ length: 600 }, (_, n) => ({ id: `o${n}`, type: 'sticky', z: n, content: `note ${n} ${'text '.repeat(20)}`, color: '#fff2a8', geometry: geometry((n % 30) * 240, Math.floor(n / 30) * 140), style: { fontFamily: 'Inter', fontSize: 18 } }))
const history = createHistory({ doc: { schemaVersion: 1, page: { columns: 4, rows: 4 }, objects, extras: {} }, maxSteps: 1000 })
const stat = (list) => { const sorted = [...list].sort((a, b) => a - b); return `median ${sorted[sorted.length >> 1].toFixed(3)} ms, p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(3)} ms, max ${sorted.at(-1).toFixed(3)} ms` }
const record = []
const undo = []
const redo = []
const heap = () => { globalThis.gc?.(); return process.memoryUsage().heapUsed }
const h0 = heap()
for (let n = 0; n < 200; n++) {
  const id = `o${(n * 7) % 600}`
  const before = history.doc.objects.find((o) => o.id === id)
  const t0 = performance.now()
  history.record({ changes: [{ id, before, after: { ...before, geometry: { ...before.geometry, x: before.geometry.x + 5 } } }] })
  record.push(performance.now() - t0)
}
const h1 = heap()
for (let n = 0; n < 200; n++) { const t0 = performance.now(); history.undo(); undo.push(performance.now() - t0) }
for (let n = 0; n < 200; n++) { const t0 = performance.now(); history.redo(); redo.push(performance.now() - t0) }
const { undoSteps, bytes } = history.stats()
console.log(`600 objects, ${undoSteps} steps recorded (one moved object each)`)
console.log(`record: ${stat(record)}`)
console.log(`undo:   ${stat(undo)}`)
console.log(`redo:   ${stat(redo)}`)
console.log(`estimated retained: ${(bytes / undoSteps).toFixed(0)} bytes per step; measured heap growth ${((h1 - h0) / undoSteps).toFixed(0)} bytes per step`)
console.log(`for comparison, a full JSON snapshot of this note is ${JSON.stringify({ objects }).length} bytes`)
