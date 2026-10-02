// Throwaway Fabric.js stress harness mirroring Personal Note's page growth.
// Query: ?mode=full|viewport&caching=1|0&skip=1|0
const q = new URLSearchParams(location.search)
const MODE = q.get('mode') || 'full'          // full = current app (canvas sized to all pages, DOM scroll)
const CACHING = q.get('caching') !== '0'
const SKIP = q.get('skip') !== '0'
const SHADOW = q.get('shadow') !== '0'
const W = 860, H = 1080, OVERSCAN = 48, MARGIN = 24
const f = fabric
f.FabricObject.ownDefaults.objectCaching = CACHING

const ws = document.getElementById('workspace')
const paper = document.getElementById('paper')
const pages = { cols: 3, rows: 4 }            // 12 pages
let zoom = 1
const canvas = new f.Canvas('c', {
  width: 100, height: 100, backgroundColor: 'transparent', preserveObjectStacking: false,
  renderOnAddRemove: q.get('rar') === '1', skipOffscreen: SKIP,
})

// random but deterministic
let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

function resizePaper() {
  if (MODE === 'full') {
    const w = (pages.cols * W + OVERSCAN) * zoom, h = (pages.rows * H + OVERSCAN) * zoom
    canvas.setDimensions({ width: w, height: h })
    canvas.setViewportTransform([zoom, 0, 0, zoom, 0, 0])
    paper.style.width = w + 'px'; paper.style.height = h + 'px'
    paper.style.setProperty('--pw', W * zoom + 'px'); paper.style.setProperty('--ph', H * zoom + 'px')
  } else {
    canvas.setDimensions({ width: ws.clientWidth, height: ws.clientHeight })
    paper.style.width = ws.clientWidth + 'px'; paper.style.height = ws.clientHeight + 'px'
  }
}
if (MODE === 'viewport') {
  ws.style.overflow = 'hidden'
  canvas.on('before:render', ({ ctx }) => {
    const v = canvas.viewportTransform
    ctx.save(); ctx.fillStyle = '#e8e6e0'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5])
    for (let c = 0; c < pages.cols; c++) for (let r = 0; r < pages.rows; r++) {
      ctx.fillStyle = '#fff'; ctx.fillRect(c * W + 1, r * H + 1, W - 2, H - 2)
    }
    ctx.restore()
  })
}

function inkPath(x, y, n) {
  let px = x, py = y, d = `M ${px} ${py}`
  for (let i = 0; i < n; i++) {
    const nx = px + (rnd() - 0.4) * 8, ny = py + (rnd() - 0.5) * 8
    d += ` Q ${px} ${py} ${(px + nx) / 2} ${(py + ny) / 2}`; px = nx; py = ny
  }
  return new f.Path(d, { stroke: '#223', strokeWidth: 2.5, fill: '', strokeLineCap: 'round', strokeLineJoin: 'round' })
}
function imageEl() {
  const c = document.createElement('canvas'); c.width = 600; c.height = 400
  const g = c.getContext('2d')
  for (let i = 0; i < 60; i++) { g.fillStyle = `hsl(${rnd() * 360},60%,60%)`; g.fillRect(rnd() * 600, rnd() * 400, 80, 60) }
  return c
}
const texts = ['Meeting notes: ship the export', 'Idea — spatial search\nacross pages', 'TODO\n- draw\n- link\n- review', 'A longer paragraph of handwritten-ish notes that wraps a little.']
const nodes = []
const connectors = []
function place() {
  const pc = Math.floor(rnd() * pages.cols), pr = Math.floor(rnd() * pages.rows)
  return { x: pc * W + 40 + rnd() * (W - 300), y: pr * H + 40 + rnd() * (H - 300) }
}
function buildScene() {
  const objs = []
  for (let i = 0; i < 180; i++) { const p = place(); objs.push(new f.IText(texts[i % 4], { left: p.x, top: p.y, fontSize: 18 + (i % 3) * 4, fontFamily: 'serif', fill: '#222', lineHeight: 1.45 })) }
  for (let i = 0; i < 150; i++) { const p = place(); objs.push(inkPath(p.x, p.y, 200)) }
  for (let i = 0; i < 70; i++) { const p = place(); objs.push(new f.Rect({ left: p.x, top: p.y, width: 120 + rnd() * 160, height: 80 + rnd() * 120, fill: 'rgba(80,120,200,0.15)', stroke: '#4a6fb0', strokeWidth: 2, rx: 6, ry: 6 })) }
  for (let i = 0; i < 90; i++) {
    const p = place()
    const g = new f.Group([
      new f.Rect({ width: 170, height: 130, fill: '#ffe98a', shadow: SHADOW && new f.Shadow({ color: 'rgba(0,0,0,.2)', blur: 8, offsetY: 3 }) }),
      new f.Textbox('Sticky ' + i + '\nfollow up', { width: 150, left: 10, top: 10, fontSize: 16, fontFamily: 'sans-serif' }),
    ], { left: p.x, top: p.y })
    objs.push(g); nodes.push(g)
  }
  for (let i = 0; i < 10; i++) { const p = place(); objs.push(new f.FabricImage(imageEl(), { left: p.x, top: p.y, scaleX: 0.5, scaleY: 0.5 })) }
  // 50 connectors (line + arrowhead) between stickies, same or neighbouring pages
  const target = nodes[0]; target.set({ left: W + 200, top: H + 200 }); target.setCoords()
  const ends = [nodes[1], nodes[2], nodes[3]]
  ends.forEach((n, i) => { n.set({ left: W + 50 + i * 220, top: H + 600 }); n.setCoords() })
  const pairs = ends.map((b) => [target, b])
  for (let i = 0; pairs.length < 50; i++) pairs.push([nodes[4 + (i % 80)], nodes[5 + ((i * 7) % 84)]])
  for (const [a, b] of pairs) {
    const line = new f.Line([0, 0, 1, 1], { stroke: '#555', strokeWidth: 2, selectable: false, evented: false, objectCaching: false })
    const head = new f.Triangle({ width: 12, height: 14, fill: '#555', originX: 'center', originY: 'center', selectable: false, evented: false })
    const c = { a, b, line, head }; connectors.push(c); updateConnector(c)
    objs.push(line, head)
  }
  canvas.add(...objs)
  window.__target = target
  return objs.length
}
function updateConnector(c) {
  const a = c.a.getCenterPoint(), b = c.b.getCenterPoint()
  c.line.set({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }); c.line.setCoords()
  c.head.set({ left: b.x, top: b.y, angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 90 }); c.head.setCoords()
}
const byNode = new Map()
function indexConnectors() { for (const c of connectors) for (const n of [c.a, c.b]) { if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push(c) } }

function contentBounds() {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
  for (const o of canvas.getObjects()) { const br = o.getBoundingRect(); l = Math.min(l, br.left); t = Math.min(t, br.top); r = Math.max(r, br.left + br.width); b = Math.max(b, br.top + br.height) }
  return { left: l, top: t, right: r, bottom: b }
}
let growths = 0
function expandDuringTransform() {           // same shape as main.js expandPagesDuringTransform
  const b = contentBounds(); let changed = false
  while (b.right > pages.cols * W - MARGIN) { pages.cols++; changed = true }
  while (b.bottom > pages.rows * H - MARGIN) { pages.rows++; changed = true }
  if (changed) { growths++; resizePaper() }
  canvas.requestRenderAll()
}
canvas.on('object:moving', (e) => { for (const c of byNode.get(e.target) || []) updateConnector(c); expandDuringTransform() })

// ---- timing ----
const renders = []
const origRender = canvas.renderAll.bind(canvas)
canvas.renderAll = function () { const t = performance.now(); origRender(); renders.push(performance.now() - t) }
function run(n, step) {
  return new Promise((resolve) => {
    let i = 0, last = null; const deltas = [], steps = []; renders.length = 0
    const tick = (now) => {
      if (last != null) deltas.push(now - last); last = now
      if (i >= n) return resolve({ deltas, steps, renders: renders.slice() })
      const t0 = performance.now(); step(i++); steps.push(performance.now() - t0); requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}
const stat = (a) => { const s = [...a].sort((x, y) => x - y); const p = (k) => s[Math.min(s.length - 1, Math.floor(k * s.length))] || 0; return { med: +p(0.5).toFixed(2), p95: +p(0.95).toFixed(2), max: +(s[s.length - 1] || 0).toFixed(2), n: s.length } }
function summarize(r, extra = {}) {
  return { frame: stat(r.deltas), step: stat(r.steps), render: stat(r.renders), jank: r.deltas.filter((d) => d > 20).length, ...extra,
    cols: pages.cols, rows: pages.rows, backingMpx: +(canvas.lowerCanvasEl.width * canvas.lowerCanvasEl.height / 1e6).toFixed(1) }
}

// synthetic pointer drag on the upper canvas, one move per frame
function client(pt) {
  const rect = canvas.upperCanvasEl.getBoundingClientRect(), v = canvas.viewportTransform
  return { x: rect.left + pt.x * v[0] + v[4], y: rect.top + pt.y * v[3] + v[5] }
}
function fire(type, el, p) {
  el.dispatchEvent(new MouseEvent(type.replace('pointer', 'mouse'), { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }))
}
function reveal(pt) {
  if (MODE === 'full') { ws.scrollLeft = pt.x * zoom - 500; ws.scrollTop = pt.y * zoom - 400 }
  else { canvas.setViewportTransform([zoom, 0, 0, zoom, 500 - pt.x * zoom, 400 - pt.y * zoom]) }
}
async function drag(n, dx, dy) {
  const t = window.__target, c0 = t.getCenterPoint(); reveal(c0); canvas.renderAll()
  let p = client(c0); fire('pointerdown', canvas.upperCanvasEl, p)
  const r = await run(n, (i) => { p = { x: p.x + dx, y: p.y + dy }; fire('pointermove', document, p) })
  fire('pointerup', document, p)
  return summarize(r, { moved: +(t.getCenterPoint().x - c0.x).toFixed(0), growths })
}

window.bench = {
  async setup() {
    resizePaper()
    const n = buildScene(); indexConnectors()
    await document.fonts.ready
    expandDuringTransform(); growths = 0
    let t = performance.now(); canvas.renderAll(); const cold = performance.now() - t
    t = performance.now(); canvas.renderAll(); const warm = performance.now() - t
    return { objects: n, coldRender: +cold.toFixed(1), warmRender: +warm.toFixed(1), mode: MODE, caching: CACHING, skip: SKIP, dpr: devicePixelRatio }
  },
  dragConnected: () => drag(120, 3, 2),
  idle: async () => summarize(await run(120, () => {})),
  async byType() {
    const out = {}; const all = canvas.getObjects()
    for (const T of ['IText', 'Path', 'Rect', 'Group', 'FabricImage', 'Line', 'Triangle']) {
      const sub = all.filter((o) => o.constructor.name === T || o.type === T.toLowerCase())
      canvas._objects = sub; canvas.renderAll(); const t = performance.now(); for (let k = 0; k < 5; k++) canvas.renderAll(); out[T] = { n: sub.length, ms: +((performance.now() - t) / 5).toFixed(1) }
    }
    canvas._objects = all; return out
  },                       // (a) stays inside page 5
  async dragAcrossEdge() {                                    // (b) push past right edge of the grid -> growth
    const t = window.__target; t.set({ left: pages.cols * W - 400 }); t.setCoords()
    for (const c of byNode.get(t)) updateConnector(c)
    return drag(120, 4, 0)
  },
  async pan() {                                               // (c1) pan whole canvas diagonally
    const r = await run(150, (i) => {
      if (MODE === 'full') { ws.scrollTop = i * 25; ws.scrollLeft = i * 8 }
      else { canvas.setViewportTransform([zoom, 0, 0, zoom, -i * 8, -i * 25]); canvas.requestRenderAll() }
    })
    return summarize(r)
  },
  async zoom() {                                              // (c2) pinch zoom 0.75 -> 2.5 -> 0.75
    const r = await run(120, (i) => {
      const k = i < 60 ? i / 59 : (119 - i) / 59; zoom = 0.75 + k * 1.75
      if (MODE === 'full') { resizePaper(); canvas.requestRenderAll() }
      else { canvas.setViewportTransform([zoom, 0, 0, zoom, -300 * zoom, -300 * zoom]); canvas.requestRenderAll() }
    })
    return summarize(r)
  },
  async zoomMaxProbe() {                                      // does the canvas still paint at zoom 2.5?
    zoom = 2.5; resizePaper(); canvas.renderAll()
    const t = window.__target, v = canvas.viewportTransform, c = t.getCenterPoint(), d = devicePixelRatio
    const px = canvas.getContext().getImageData((c.x * v[0] + v[4]) * d, (c.y * v[3] + v[5]) * d, 1, 1).data
    return { backingMpx: +(canvas.lowerCanvasEl.width * canvas.lowerCanvasEl.height / 1e6).toFixed(1), pixelAlpha: px[3] }
  },
  async deleteCollapse() {                                    // (d) delete everything on the bottom row, pages collapse
    const cut = (pages.rows - 1) * H
    const doomed = canvas.getObjects().filter((o) => { const b = o.getBoundingRect(); return b.top + b.height > cut })
    const startRows = pages.rows; let i = 0; const costs = []
    const r = await run(doomed.length + 5, () => {
      const o = doomed[i++]; if (!o) return
      const t0 = performance.now()
      const gone = [o]; for (const c of byNode.get(o) || []) gone.push(c.line, c.head)
      canvas.remove(...gone)
      const b = contentBounds()
      if (pages.rows > 1 && b.bottom < (pages.rows - 1) * H) { pages.rows--; resizePaper() }
      canvas.requestRenderAll(); costs.push(performance.now() - t0)
    })
    return summarize(r, { deleted: doomed.length, startRows, reconcile: stat(costs) })
  },
}
