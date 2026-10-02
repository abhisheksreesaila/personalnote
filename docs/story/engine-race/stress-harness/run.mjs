import { chromium } from 'playwright'
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'
const dir = path.dirname(new URL(import.meta.url).pathname)
const srv = http.createServer((q, r) => { const f = path.join(dir, q.url.split('?')[0]); r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(fs.readFileSync(f)) }).listen(8765)
const configs = JSON.parse(process.argv[2] || '[{"mode":"full","caching":1,"skip":1,"dpr":1}]')
const scenarios = (process.argv[3] || 'dragConnected,dragAcrossEdge,pan,zoom,zoomMaxProbe,deleteCollapse').split(',')
const browser = await chromium.launch({ headless: true, args: (process.env.ARGS || '').split(' ').filter(Boolean) })
const out = []
for (const c of configs) {
  for (const s of scenarios) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: c.dpr })
    const page = await ctx.newPage(); page.on('pageerror', (e) => console.error('ERR', e.message))
    await page.goto(`http://localhost:8765/index.html?mode=${c.mode}&caching=${c.caching}&skip=${c.skip}&shadow=${c.shadow ?? 1}&rar=${c.rar ?? 0}`)
    const setup = await page.evaluate(() => bench.setup())
    const res = await page.evaluate((s) => bench[s](), s)
    const row = { ...c, scenario: s, ...res, setup }
    console.log(JSON.stringify(row)); out.push(row)
    await ctx.close()
  }
}
fs.writeFileSync(path.join(dir, 'results-' + Date.now() + '.json'), JSON.stringify(out, null, 1))
await browser.close(); srv.close()
