// Wall-clock check for mind-map branch geometry: `node scripts/benchmark-branches.mjs`.
import { branchGeometry, ribbonPath } from '../src/mindmap/geometry.js'

const root = { x: 0, y: 0, hw: 105, hh: 38 }
const children = Array.from({ length: 200 }, (_, i) => ({ x: Math.cos(i * 0.07) * (260 + (i % 5) * 20), y: Math.sin(i * 0.07) * (260 + (i % 5) * 20), hw: 70, hh: 21 }))
const run = () => children.forEach((child) => ribbonPath(branchGeometry(root, child, { sourcePort: 'right', targetPort: 'left' }), { start: 34, end: 8 }))
for (let i = 0; i < 20; i++) run()
const started = performance.now()
for (let i = 0; i < 50; i++) run()
const each = (performance.now() - started) / 50
console.log(`200 branches (geometry + outline path): ${each.toFixed(2)} ms`)
process.exitCode = each < 5 ? 0 : 1
