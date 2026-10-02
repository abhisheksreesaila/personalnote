import { chromium } from 'playwright'
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'
const dir = path.dirname(new URL(import.meta.url).pathname)
const srv = http.createServer((q, r) => { const f = path.join(dir, q.url.split('?')[0]); r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(fs.readFileSync(f)) }).listen(8766)
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
await p.goto('http://localhost:8766/index.html?mode=full&caching=1')
await p.evaluate(() => bench.setup())
console.log(JSON.stringify(await p.evaluate(() => {
  const c = window.__target.canvas; const ctx = c.getContext(); const all = c.getObjects()
  const t0 = performance.now(); c.clearContext(ctx); const clear = performance.now() - t0
  const per = {}; for (const o of all) { const t = performance.now(); ctx.save(); ctx.transform(...c.viewportTransform); o.render(ctx); ctx.restore(); const d = performance.now() - t; const k = o.type; per[k] = per[k] || { n: 0, ms: 0, max: 0 }; per[k].n++; per[k].ms += d; per[k].max = Math.max(per[k].max, d) }
  const t1 = performance.now(); c.renderAll(); const full = performance.now() - t1
  const t2 = performance.now(); c.renderTop(); const top = performance.now() - t2
  return { clear, per, full, top }
})))
await b.close(); srv.close()
