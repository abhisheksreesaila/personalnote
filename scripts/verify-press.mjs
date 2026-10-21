// F-104 check, in the real app (Vite dev server on PN_VERIFY_PORT, mocked in-memory /api, headless Chromium, real mouse):
// one press for everything: a button squashes on pointer-down (icon-size 0.90, the rest 0.96) and springs back to scale 1 on release;
// a draggable row, a disabled button and [data-nopress] never press; with prefers-reduced-motion nothing scales and the panel distance is 0.
//   PN_VERIFY_PORT=4897 node scripts/verify-press.mjs
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const PORT = basePort(4897)
await assertPortsFree([PORT])
const now = new Date().toISOString()
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': `http://127.0.0.1:${PORT + 1}` } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
try {
  const open = async (reducedMotion) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion })
    const page = await context.newPage()
    await context.route('**/api/**', async (route) => {
      const req = route.request()
      const p = new URL(req.url()).pathname.replace(/^\/api/, '')
      const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
      const summary = (id) => ({ id, resourceId: `r${id}`, revision: 1, noteType: 'canvas', title: `Note ${id}`, notebookId: 1, createdAt: now, updatedAt: now })
      if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'Garden', category: 'projects', color: '#76669a', noteCount: 2 }])
      if (p === '/notes' && req.method() === 'GET') return json([1, 2].map(summary))
      const m = p.match(/^\/notes\/(\d+)$/)
      if (m && req.method() === 'GET') return json({ ...summary(Number(m[1])), content: { objects: [] } })
      if (m && req.method() === 'PUT') return json({ revision: 2, resourceId: `r${m[1]}` })
      if (p.startsWith('/changes')) return json({ sequence: 1, changes: [], agents: [] })
      return json({})
    })
    await page.goto(`http://127.0.0.1:${PORT}/notes`)
    await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
    await page.click('#toggle-sidebar')
    await page.waitForTimeout(500)
    return { context, page }
  }
  // scale held while the mouse is down, then 500 ms after release (the spring is 300 ms)
  const press = async (page, selector) => {
    const target = page.locator(selector).first()
    const box = await target.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(250)
    const down = await target.evaluate((el) => getComputedStyle(el).scale)
    await page.mouse.up()
    await page.waitForTimeout(500)
    const up = await target.evaluate((el) => getComputedStyle(el).scale)
    return { down, up }
  }
  const isOne = (s) => s === 'none' || s === '1'

  const { context, page } = await open('no-preference')
  const quick = await press(page, '.quick-note')
  check('a 258px button squashes to 0.96 on pointer-down', Math.abs(Number(quick.down) - 0.96) < 0.005, quick.down)
  check('and springs back to scale 1 after release', isOne(quick.up), quick.up)
  const icon = await press(page, '#toggle-sidebar')
  check('an icon-size button squashes to 0.90', Math.abs(Number(icon.down) - 0.9) < 0.005, icon.down)
  check('and springs back to scale 1', isOne(icon.up), icon.up)
  const row = await press(page, '.note-list-item[draggable="true"]')
  check('a draggable row never presses', isOne(row.down), row.down)
  await page.evaluate(() => document.querySelector('.quick-note').setAttribute('data-nopress', ''))
  const nopress = await press(page, '.quick-note')
  check('[data-nopress] opts a button out', isOne(nopress.down), nopress.down)
  await page.evaluate(() => { const b = document.querySelector('.quick-note'); b.removeAttribute('data-nopress'); b.disabled = true })
  const box = await page.locator('.quick-note').boundingBox()
  await page.mouse.move(box.x + 20, box.y + 15)
  await page.mouse.down()
  await page.waitForTimeout(200)
  check('a disabled button never presses', isOne(await page.locator('.quick-note').evaluate((el) => getComputedStyle(el).scale)))
  await page.mouse.up()
  await context.close()

  const reduced = await open('reduce')
  const r = await press(reduced.page, '.quick-note')
  check('reduced motion: a pressed button does not scale', isOne(r.down), r.down)
  const rIcon = await press(reduced.page, '#toggle-sidebar')
  check('reduced motion: an icon button does not scale either', isOne(rIcon.down), rIcon.down)
  check('reduced motion: panels settle with no distance', await reduced.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--settle-y').trim()) === '0px')
  await reduced.context.close()
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `\n${failed} FAILED` : '\nAll press checks passed')
process.exit(failed ? 1 : 0)
