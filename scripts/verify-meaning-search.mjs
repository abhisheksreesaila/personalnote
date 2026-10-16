// F-080 search finds by meaning in the omnibar, in the real app: Vite dev server on PN_VERIFY_PORT (default 4870) with a real API on the next port over a
// scratch database, headless Chromium, real keyboard and touch. The meaning answers are played by the browser (what the server would send, with delays);
// the "not installed" case talks to the real server. Run one at a time; it stops everything it starts and removes only its own scratch folder.
//   PN_VERIFY_PORT=4880 node scripts/verify-meaning-search.mjs        (PN_SHOT=/path/shot.png also saves pictures)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const UI_PORT = Number(process.env.PN_VERIFY_PORT || 4870)
const API_PORT = UI_PORT + 1
const API = `http://127.0.0.1:${API_PORT}`
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-meaning-'))
const python = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], { env: { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db'), PERSONAL_NOTE_SEARCH_DIR: path.join(scratch, 'search') }, stdio: 'ignore' })
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
const headers = { 'content-type': 'application/json', 'x-personal-note': '1' }
const call = async (method, url, body) => {
  const response = await fetch(`${API}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}
let browser
try {
  await apiUp()
  await server.listen()
  const travel = (await call('POST', '/api/notebooks', { name: 'Travel', color: '#2f9d8f', category: 'projects' })).body
  const home = (await call('POST', '/api/notebooks', { name: 'Home', color: '#d9822b', category: 'areas' })).body
  const makeNote = async (title, markdown, notebookId) => {
    const created = (await call('POST', '/api/notes', { title, notebookId, noteType: 'page' })).body
    const saved = (await call('PUT', `/api/notes/${created.id}`, { title, notebookId, revision: created.revision, pageState: { columns: 1, rows: 1 }, content: { markdown } })).body
    return { id: created.id, revision: saved.revision }
  }
  const tide = await makeNote('Tide tables', 'Low tide at 6:42 so the pools are open before breakfast', travel.id)
  const packing = await makeNote('Packing list', 'Bring the lighthouse key and a paper map', travel.id)
  const sleep = await makeNote('Sleep log', 'Woke at four, tired all day', home.id)
  const shelves = await makeNote('Kitchen shelves', 'Two shelves, oak, hidden brackets', home.id)
  const cards = await makeNote('Card numbers', 'ZEBRA-CARD-4111 quokkaphrase', home.id)
  await call('POST', `/api/notes/${cards.id}/secure`, { revision: cards.revision, passphrase: 'correct horse battery' })
  await call('POST', '/api/secure/lock')

  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  // What the server would answer for a query: [id, title, notebook] per note, and how long it takes (ms). The secure note is sent on purpose: the page must still hide it.
  const answers = {
    lighthouse: { delay: 0, hits: [[packing.id, 'Packing list', 'Travel'], [sleep.id, 'Sleep log', 'Home'], [shelves.id, 'Kitchen shelves', 'Home'], [cards.id, 'Card numbers', 'Home']] },
    slow: { delay: 900, hits: [[sleep.id, 'Sleep log', 'Home']] },
    kitchen: { delay: 0, hits: [[tide.id, 'Tide tables', 'Travel']] },
    hang: { delay: 7000, hits: [] },
    nomatch: { delay: 0, hits: [[tide.id, 'Tide tables', 'Travel'], [shelves.id, 'Kitchen shelves', 'Home']] },
    late: { delay: 6800, hits: [[sleep.id, 'Sleep log', 'Home']] },
  }
  const wire = async (context, log) => {
    await context.route('**/api/search-meaning/status', (route) => route.fulfill({ json: { state: 'ready', supported: true } }))
    await context.route('**/api/search/meaning*', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('q')
      log.push(query)
      const answer = answers[query] || { delay: 0, hits: [] }
      await new Promise((r) => setTimeout(r, answer.delay))
      await route.fulfill({ json: answer.hits.map(([id, title, notebook]) => ({ id, title, notebook, score: 0.7 })) }).catch(() => {})
    })
  }
  const boot = async (page) => {
    await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
    await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
    await page.waitForFunction(() => !window.__personalNote.state.loading && !window.__personalNote.state.creatingNote, null, { timeout: 30000 })
    await page.waitForTimeout(800)
  }

  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const requests = []
  await wire(context, requests)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await boot(page)
  const shot = async (name, target = page) => { if (process.env.PN_SHOT) await target.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${name}.png`) }) }
  const titles = () => page.locator('.omni-row .omni-title').allTextContents()
  const groups = () => page.locator('.omni-group h4').allTextContents()
  const meaningTitles = () => page.locator('.omni-group[aria-label="By meaning"] .omni-title').allTextContents()
  const active = () => page.evaluate(() => window.__personalNote.state.activeNoteId)
  const selected = () => page.evaluate(() => document.querySelector('.omni-row.sel .omni-title')?.textContent)
  const closed = () => page.waitForSelector('#search-backdrop', { state: 'hidden', timeout: 3000 }).then(() => true, () => false)
  await page.evaluate((id) => window.__personalNote.selectNote(id), tide.id)
  await page.waitForFunction((id) => window.__personalNote.state.activeNoteId === id && !window.__personalNote.state.loading, tide.id, { timeout: 30000 })
  await page.waitForTimeout(600)

  // ---- word matches first, then "By meaning" ----
  await page.keyboard.press('Control+k')
  await page.waitForSelector('#search-backdrop.open')
  await page.keyboard.type('lighthouse', { delay: 40 })
  await page.waitForSelector('.omni-group[aria-label="In your words"]', { timeout: 5000 })
  const yBefore = await page.locator('.omni-row').first().evaluate((row) => row.getBoundingClientRect().top)
  await page.waitForSelector('.omni-group[aria-label="By meaning"]', { timeout: 5000 })
  const yAfter = await page.locator('.omni-row').first().evaluate((row) => row.getBoundingClientRect().top)
  check('the word matches come first and "By meaning" below them', (await groups()).join() === 'In your words,By meaning', (await groups()).join())
  check('it lists the closest notes not already shown (the word match is not repeated, the secure note never listed)', (await meaningTitles()).join() === 'Sleep log,Kitchen shelves', (await meaningTitles()).join())
  check('a meaning row names its notebook', (await page.locator('.omni-group[aria-label="By meaning"] .omni-sub').allTextContents()).join() === 'Home,Home')
  check('typing 10 letters at 40 ms asks the server once, for the whole query (debounced)', requests.join() === 'lighthouse', requests.join())
  check('the rows already on screen did not move when the group arrived', yBefore === yAfter, `${yBefore} ${yAfter}`)
  check('no "Searching" row is shown while waiting', !(await page.locator('#search-results').textContent()).includes('Searching'))
  await shot('1-groups')

  // ---- the keyboard flows across the groups; Enter opens the note ----
  check('the first row (a word match) is selected', (await selected()) === 'Packing list', await selected())
  await page.keyboard.press('ArrowDown')
  check('ArrowDown goes into "By meaning"', (await selected()) === 'Sleep log', await selected())
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  check('and wraps back to the top', (await selected()) === 'Packing list', await selected())
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  check('ArrowUp goes back up through the groups', (await selected()) === 'Sleep log', await selected())
  await page.keyboard.press('Enter')
  await page.waitForFunction((id) => window.__personalNote.state.activeNoteId === id && !window.__personalNote.state.loading, sleep.id, { timeout: 15000 })
  check('Enter opens the note and closes the omnibar', (await active()) === sleep.id && (await closed()))

  // ---- a fast second query: the first one's late answer is dropped ----
  requests.length = 0
  await page.keyboard.press('Control+k')
  await page.waitForSelector('#search-backdrop.open')
  await page.keyboard.type('slow')
  await page.waitForTimeout(500) // past the pause: the first request is out, and takes 900 ms
  check('while the answer is on its way a query with no other match says no "Nothing matches", has no spinner, and offers New note', (await page.locator('.omni-none').count()) === 0 && (await titles()).join() === 'New note \u201cslow\u201d', (await titles()).join())
  await page.keyboard.press('Control+a')
  await page.keyboard.type('kitchen')
  await page.waitForSelector('.omni-group[aria-label="By meaning"]', { timeout: 5000 })
  await page.waitForTimeout(1200) // long after the first answer would have landed
  check('only the second query\'s meaning matches are shown', (await meaningTitles()).join() === 'Tide tables' && (await groups()).join() === 'Notes,By meaning', `${await groups()} ${await meaningTitles()}`)
  check('both queries were asked, once each', requests.join() === 'slow,kitchen', requests.join())
  await page.keyboard.press('Escape')
  await closed()

  // ---- Enter on an otherwise-empty list creates the note at once, however long the meaning answer takes ----
  await page.keyboard.press('Control+k')
  await page.waitForSelector('#search-backdrop.open')
  await page.keyboard.type('hang')
  await page.waitForSelector('.omni-row')
  const askedAt = Date.now()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__personalNote.state.notes.some((n) => n.title === 'hang'), null, { timeout: 4000 }).catch(() => {})
  check('Enter creates the note at once while the meaning answer is still out (never waits for it)', (await page.evaluate(() => window.__personalNote.state.notes.filter((n) => n.title === 'hang').length)) === 1 && Date.now() - askedAt < 3000, String(Date.now() - askedAt))
  await closed()
  await page.waitForTimeout(1500) // the new note settles (it takes the typing focus)

  // ---- meaning matches and nothing else: they come first, the selection moves to them, New note is last ----
  await page.keyboard.press('Control+k')
  await page.waitForSelector('#search-backdrop.open')
  await page.keyboard.type('nomatch')
  await page.waitForSelector('.omni-group[aria-label="By meaning"]', { timeout: 5000 })
  check('with only meaning matches, they are listed first and New note last', (await titles()).join() === 'Tide tables,Kitchen shelves,New note \u201cnomatch\u201d', (await titles()).join())
  check('and the first meaning match is selected, not New note', (await selected()) === 'Tide tables', await selected())
  await page.keyboard.press('ArrowUp')
  check('ArrowUp from the top wraps to New note', (await selected()) === 'New note \u201cnomatch\u201d', await selected())
  await page.keyboard.press('Escape')
  await closed()

  // ---- an answer after the 6 s wait is dropped: it never swaps the list under the cursor ----
  requests.length = 0
  await page.keyboard.press('Control+k')
  await page.waitForSelector('#search-backdrop.open')
  await page.keyboard.type('late')
  await page.waitForTimeout(6500)
  check('after the wait the list says nothing matches and offers New note', (await page.locator('.omni-none strong').count()) === 1 && (await titles()).join() === 'New note \u201clate\u201d', (await titles()).join())
  await page.waitForTimeout(1200) // the answer (6.8 s after the request) lands now
  check('the late answer changes nothing', (await groups()).join() === '' && (await titles()).join() === 'New note \u201clate\u201d', `${await groups()} ${await titles()}`)
  await page.keyboard.press('Escape')
  await closed()

  // ---- closing while an answer is on its way drops it ----
  requests.length = 0
  await page.keyboard.press('Control+k')
  await page.waitForSelector('#search-backdrop.open')
  await page.keyboard.type('slow')
  await page.waitForTimeout(450)
  await page.keyboard.press('Escape')
  await closed()
  await page.waitForTimeout(900)
  await page.keyboard.press('Control+k')
  await page.waitForSelector('#search-backdrop.open')
  check('nothing from the dropped answer shows when the omnibar is opened again', (await groups()).join() === 'Recent,Actions', (await groups()).join())
  await page.keyboard.press('Escape')
  await closed()

  // ---- without the download the omnibar is exactly as before (the real server answers) ----
  const bare = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const bareRequests = []
  bare.on('request', (request) => { if (request.url().includes('/api/search/meaning')) bareRequests.push(request.url()) })
  const barePage = await bare.newPage()
  const bareErrors = []
  barePage.on('pageerror', (error) => bareErrors.push(error.message))
  await boot(barePage)
  const answer = await barePage.evaluate(async () => { const response = await fetch('/api/search/meaning?q=lighthouse'); return [response.status, await response.json()] })
  check('the real server answers an empty list when search by meaning is not installed', JSON.stringify(answer) === '[200,[]]', JSON.stringify(answer))
  await barePage.keyboard.press('Control+k')
  await barePage.waitForSelector('#search-backdrop.open')
  await barePage.keyboard.type('lighthouse')
  await barePage.waitForSelector('.omni-group[aria-label="In your words"]', { timeout: 5000 })
  await barePage.waitForTimeout(900)
  const resultsText = await barePage.locator('#search-results').textContent()
  check('without it the groups are today\'s and nothing about meaning shows', (await barePage.locator('.omni-group h4').allTextContents()).join() === 'In your words' && !/meaning|Searching/i.test(resultsText), resultsText)
  await barePage.keyboard.press('Control+a')
  await barePage.keyboard.type('zzzzzz')
  const noneShown = await barePage.waitForSelector('.omni-none', { timeout: 700 }).then(() => true, () => false)
  check('without it "Nothing matches" appears at once, as before (no waiting for a meaning answer)', noneShown)
  check('a query with no matches still says "Nothing matches" and offers a new note', (await barePage.locator('.omni-none strong').textContent()) === 'Nothing matches “zzzzzz”' && (await barePage.locator('.omni-row').count()) === 1)
  check('the page asked the server quietly and got nothing', bareRequests.length >= 1)
  check('no page errors without the download', bareErrors.length === 0, bareErrors.join(' | '))

  // ---- a phone: the same group in the full-screen search ----
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const phoneRequests = []
  await wire(phoneContext, phoneRequests)
  const phone = await phoneContext.newPage()
  const phoneErrors = []
  phone.on('pageerror', (error) => phoneErrors.push(error.message))
  await boot(phone)
  await phone.evaluate((id) => window.__personalNote.selectNote(id), tide.id) // a locked secure note's cover would sit over the search button
  await phone.waitForFunction((id) => window.__personalNote.state.activeNoteId === id && !window.__personalNote.state.loading, tide.id, { timeout: 30000 })
  await phone.waitForTimeout(600)
  await phone.tap('#search-button')
  await phone.waitForFunction(() => document.querySelector('#search-backdrop')?.classList.contains('open') && getComputedStyle(document.querySelector('.spotlight')).opacity === '1', null, { timeout: 3000 })
  await phone.keyboard.type('lighthouse')
  await phone.waitForSelector('.omni-group[aria-label="By meaning"]', { timeout: 5000 })
  const phoneGroups = await phone.locator('.omni-group h4').allTextContents()
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  check('on a phone the same groups show in the full-screen search, without overflow', phoneGroups.join() === 'In your words,By meaning' && overflow <= 0, `${phoneGroups} ${overflow}`)
  const tapHeight = await phone.locator('.omni-group[aria-label="By meaning"] .omni-row').first().evaluate((row) => row.getBoundingClientRect().height)
  check('its rows are tall enough to tap (48 px or more)', tapHeight >= 48, String(tapHeight))
  await shot('2-phone', phone)
  await phone.tap('.omni-group[aria-label="By meaning"] .omni-row')
  await phone.waitForFunction((id) => window.__personalNote.state.activeNoteId === id, sleep.id, { timeout: 15000 })
  check('tapping a meaning row opens that note', (await phone.evaluate(() => window.__personalNote.state.activeNoteId)) === sleep.id)
  check('no page errors on the phone', phoneErrors.length === 0, phoneErrors.join(' | '))
  check('no page errors', errors.length === 0, errors.join(' | '))
} catch (error) {
  console.error(error)
  results.push(false)
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch {}
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
