// The new-notebook dialog always lets you back out (Vite dev server on PN_VERIFY_PORT, default 4870, mocked /api, headless Chromium).
//   (the section + now names a notebook in place; Shift+click on it opens this dialog)
//   - with the name still empty, Cancel closes it, the X closes it, and Esc closes it; none of them makes a notebook
//   - Create with an empty name keeps it open; Create with a name makes the notebook and closes it
//
//   TMPDIR=/var/tmp/x node scripts/verify-notebook-dialog.mjs   (PN_VERIFY_BROWSER=webkit for the Mac app's engine)
import { createServer } from 'vite'
import { chromium, webkit } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4870)
await assertPortsFree([UI_PORT])
const now = new Date().toISOString()
const posts = []
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const engine = process.env.PN_VERIFY_BROWSER === 'webkit' ? webkit : chromium // webkit: the engine of the Mac app
const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ['--disable-dev-shm-usage'] } : {}) })
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.addInitScript(() => localStorage.setItem('pn.notesPanelOpen', '1')) // (F-074: the notes panel is closed by default; this check works inside it)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/notebooks' && req.method() === 'POST') {
      const body = JSON.parse(req.postData())
      posts.push(body)
      return json({ id: 10 + posts.length, resourceId: `nb${posts.length}`, revision: 1, noteCount: 0, ...body })
    }
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', category: 'projects', noteCount: 1 }])
    if (p === '/notes' && req.method() === 'GET') return json([{ id: 1, resourceId: 'r1', revision: 1, noteType: 'canvas', title: 'One', notebookId: 1, createdAt: now, updatedAt: now }])
    if (p === '/notes/1') return json({ id: 1, resourceId: 'r1', revision: 1, noteType: 'canvas', title: 'One', notebookId: 1, createdAt: now, updatedAt: now, content: null, pageState: {} })
    return json({})
  })
  await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
  await page.waitForSelector('[data-new-notebook="projects"]', { timeout: 60000 })
  const dialogOpen = () => page.evaluate(() => document.querySelector('#notebook-dialog').open)
  const openDialog = async () => { await page.click('[data-new-notebook="projects"]', { modifiers: ['Shift'] }); await page.waitForTimeout(150) }

  await openDialog()
  check('the + opens the new-notebook dialog', await dialogOpen())
  await page.click('#notebook-dialog .dialog-cancel')
  await page.waitForTimeout(150)
  check('Cancel closes it while the name is empty', !(await dialogOpen()))

  await openDialog()
  await page.click('#notebook-dialog .dialog-heading-row .icon-button')
  await page.waitForTimeout(150)
  check('the X closes it while the name is empty', !(await dialogOpen()))

  await openDialog()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  check('Esc closes it while the name is empty', !(await dialogOpen()))
  check('backing out makes no notebook', posts.length === 0, JSON.stringify(posts))

  await openDialog()
  await page.click('#save-notebook')
  await page.waitForTimeout(150)
  check('Create with an empty name keeps it open', await dialogOpen())
  await page.fill('#notebook-name', 'Garden')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  check('Enter with a name makes the notebook and closes it', !(await dialogOpen()) && posts.length === 1 && posts[0].name === 'Garden', JSON.stringify(posts))
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
process.exit(results.every(Boolean) ? 0 : 1)
