import { createServer } from 'vite'
import { chromium } from 'playwright'
const PORT = Number(process.env.PN_VERIFY_PORT || 4921)
const now = new Date().toISOString()
let content = { objects: [] }
const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
try {
  const context = await browser.newContext({ viewport: { width: Number(process.env.W || 1280), height: Number(process.env.H || 800) } })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()) })
  await context.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const summary = (id) => ({ id, resourceId: `r${id}`, revision: 1, noteType: 'canvas', title: 'Kitchen renovation', notebookId: 1, createdAt: now, updatedAt: now })
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'Home', category: 'projects', color: '#76669a', noteCount: 1 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary(1)])
    const m = p.match(/^\/notes\/(\d+)$/)
    if (m && req.method() === 'GET') return json({ ...summary(1), content, pageState: { columns: 1, rows: 1 } })
    if (m && req.method() === 'PUT') return json({ revision: 2, resourceId: 'r1' })
    if (p.startsWith('/changes')) return json({ sequence: 1, changes: [], agents: [] })
    return json({})
  })
  await page.goto(`http://127.0.0.1:${PORT}/notes${process.env.SKIN ? '' : ''}`)
  if (process.env.SKIN) await page.evaluate((s) => { document.documentElement.dataset.skin = s }, process.env.SKIN)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(500)
  const out = process.env.OUT || '/var/tmp/pn-f084-look'
  await page.screenshot({ path: `${out}-rest.png` })
  await page.click('#share-button')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${out}-card.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.click('#search-button')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${out}-search.png` })
} finally {
  await browser.close()
  await server.close()
}
