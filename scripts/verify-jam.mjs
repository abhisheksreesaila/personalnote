// F-092 checks: jam sessions in the real app. The Vite dev server on PN_VERIFY_PORT (never 3137) in front of the real API on the next port
// (scripts/verify_jam_server.py: the real app with a scripted brain, a scratch database and a scratch plugins folder), headless Chromium with a
// fake microphone and a mocked local transcription service. Phone width first, then desktop. The brain is a script, so a turn is exact; what a
// real Claude turn does is scripts/jam_spike.py's business.
//   - Jam is off until it is switched on in Settings → Plugins; then "New jam" is in the new-note menu and the omnibar; off again, both go
//     and the jam code is not even requested after a reload
//   - New jam: a mind map whose centre idea is its title, with the island saying "Hold the mic and talk"
//   - hold the mic: the words are the live line in the island (not a text box); Jam sends them as one turn (the prompt holds the map and the words)
//   - Thinking: the map stays editable; the answer adds branches (emoji, a colour per main branch), thumbs with a reason on hover and on tap,
//     faint dashed ghosts with Yes and No; the person's own branches stay exactly where they were
//   - one turn is one undo step (and redo brings it back); Yes makes a ghost a branch, No fades it; "yes" by voice accepts the newest
//   - "jam" at the end of speech sends the turn, without the word
//   - branch text and emoji are text, never HTML; a brain error says so plainly and Try again works; no brain points at Settings → AI
//   - what is saved is an ordinary mind map (emoji, thumbs, jam mode; no ghosts) that reopens as a jam
//   - phone: the Yes and No pills are at least 48px high
//
//   PN_VERIFY_PORT=4930 node scripts/verify-jam.mjs        (PN_SHOT=/path/shot.png also saves pictures)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { closeSettings, showSection } from './lib/settings.mjs'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4930)
const API_PORT = UI_PORT + 1
await assertPortsFree([UI_PORT, API_PORT])
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await wait(50) } return false }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-jam-'))
const scriptFile = path.join(scratch, 'brain.json')
const promptsFile = `${scriptFile}.prompts`
fs.writeFileSync(promptsFile, '')
const setScript = (entries) => fs.writeFileSync(scriptFile, JSON.stringify(entries))
let skipPrompts = 0 // (each leg counts its own turns)
const prompts = () => fs.readFileSync(promptsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).slice(skipPrompts)
setScript([{ error: 'no turn scripted yet' }])
const python = path.resolve(fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : fs.existsSync('../../../.venv/bin/python') ? '../../../.venv/bin/python' : 'python3')
const env = { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db'), PERSONAL_NOTE_PLUGINS_DIR: path.join(scratch, 'plugins'), PERSONAL_NOTE_AI_DIR: path.join(scratch, 'ai'), PN_JAM_SCRIPT: scriptFile, PN_JAM_PORT: String(API_PORT) }
const API = `http://127.0.0.1:${API_PORT}`
const api = spawn(python, ['scripts/verify_jam_server.py'], { env, stdio: process.env.PN_DEBUG ? 'inherit' : 'ignore' })
const call = async (method, url, body) => { const r = await fetch(`${API}/api${url}`, { method, headers: { 'content-type': 'application/json', 'x-personal-note': '1' }, body: body && JSON.stringify(body) }); const text = await r.text(); let parsed; try { parsed = JSON.parse(text) } catch { parsed = { raw: text.slice(0, 80) } } return { status: r.status, body: parsed } }
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await wait(150) } throw new Error('API did not start') }
const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })

// What the person says, as the mocked transcription service hears it: each press of the mic answers with the next utterance.
let said = []
async function mockVoice(page) {
  await page.route('**/api/voice/status', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ state: 'unsupported' }) })) // straight to the (mocked) local service
  await page.routeWebSocket('ws://127.0.0.1:8080/v1/realtime', (ws) => {
    let answered = false
    ws.onMessage((message) => {
      if (typeof message === 'string' || answered) return
      answered = true
      const [interim, final] = said.shift() ?? ['', '']
      setTimeout(() => ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: interim })), 50)
      setTimeout(() => ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: final })), 900)
    })
  })
}

const TURN_ONE = { edits: [
  { op: 'add_branch', parent_id: 'root', text: 'Customers', emoji: '🐕', id: 'n1' },
  { op: 'add_branch', parent_id: 'root', text: 'Stock', emoji: '', id: 'n2' },
  { op: 'add_branch', parent_id: 'n1', text: 'Dog owners' },
  { op: 'react', node_id: 'n1', vote: 'up', reason: 'Clear first audience' },
  { op: 'ghost', parent_id: 'root', text: 'Delivery', why: 'Heavy food is a pain to carry' },
  { op: 'ghost', parent_id: 'n2', text: 'Subscriptions', why: 'Owners reorder every month' },
] }
const TURN_TWO = { edits: [{ op: 'ghost', parent_id: 'root', text: 'Loyalty card', why: 'Regulars like a reward' }] }
const TURN_HTML = { edits: [{ op: 'add_branch', parent_id: 'root', text: '<img src=x onerror=window.__pwned=1>', emoji: '🦄', id: 'x1' }] }
const TURN_REACT = { edits: [{ op: 'react', node_id: 'root', vote: 'down', reason: 'Too broad for one shop' }] }
const NOT_INSTALLED = 'Claude Code is not installed here. Install it and sign in, or pick another brain in Settings.'
const SLOW = 'Claude Code took longer than 90 seconds; try again.'

let browser
try {
  await apiUp()
  await server.listen()
  // A jam map left from before: it is open when the page loads with Jam off, so switching Jam on has to find it.
  const SEED = { version: 1, title: 'Seeded jam', rootId: 'root', jam: true, defaultPresentation: 'box', nodes: [
    { id: 'root', parentId: null, text: 'Seeded jam', x: 0, y: 0, color: '#ef684b', fontSize: 28, bold: true, font: 'hand', presentation: 'box', curve: 78 },
    { id: 'old', parentId: 'root', text: 'Old branch', x: 260, y: 0, color: '#efad28', fontSize: 20, bold: false, font: 'hand', presentation: 'box', curve: 78 },
  ] }
  const made = await call('POST', '/notes', { title: 'Seeded jam', noteType: 'mindmap' })
  const put = await call('PUT', `/notes/${made.body.id}`, { title: 'Seeded jam', content: SEED, revision: made.body.revision })
  if (put.status !== 200) throw new Error('could not seed the jam map: ' + JSON.stringify(put))
  const seededId = made.body.id
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
  const errors = []
  for (const [label, viewport] of [['phone', { width: 390, height: 780 }], ['desktop', { width: 1360, height: 900 }]].filter(([name]) => !process.env.PN_ONLY || process.env.PN_ONLY === name)) { // (PN_ONLY=desktop runs one)
    const phone = label === 'phone'
    skipPrompts = fs.readFileSync(promptsFile, 'utf8').split('\n').filter(Boolean).length
    await call('POST', '/plugins/jam', { enabled: false })
    const context = await browser.newContext({ viewport, permissions: ['microphone'], hasTouch: false })
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
    if (process.env.PN_DEBUG) page.on('console', (m) => console.log('CONSOLE', label, m.type(), m.text().slice(0, 200)))
    page.on('console', (message) => { if (message.type() === 'error' && !/WebSocket|8080|status of 409|status of 502/.test(message.text())) errors.push(`${label}: ${message.text()}`) })
    let jamCode = []
    page.on('request', (request) => { if (/\/src\/modules\/jam\//.test(request.url())) jamCode.push(request.url()) })
    await mockVoice(page)
    const shot = async (name) => { await page.waitForTimeout(500); if (process.env.PN_SHOT) await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${label}-${name}.png`) }) }
    const open = async (noteId) => {
      await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
      await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
      if (noteId) await pick(noteId)
    }
    const pick = async (id) => { await page.evaluate((n) => window.__personalNote.selectNote(n), id); await page.waitForFunction((n) => window.__personalNote.state.activeNoteId === n && !window.__personalNote.state.loading, id, { timeout: 15000 }) }
    const openSettings = async () => {
      if (!(await page.locator('#properties-panel').evaluate((e) => e.classList.contains('open')))) { if (!(await page.locator('#top-properties').isVisible())) { await page.waitForTimeout(400); await page.locator('#island .isl-face:not([hidden]) :is(#share-button, .isl-hit)').last().click() } await page.click('#top-properties'); await page.waitForTimeout(500) }
      await showSection(page, 'plugins')
    }
    const switchJam = async (on) => { await openSettings(); await page.locator('#plugin-jam').setChecked(on); await page.waitForFunction((want) => document.querySelector('#plugin-jam').checked === want, on); await page.waitForTimeout(700); await closeSettings(page); await page.waitForTimeout(300) }
    // Where a new jam can be started: the omnibar's actions (phone and desktop) and, on desktop, the new-note menu (a phone has none).
    const omniTitles = async () => { await page.click('#search-button'); await page.waitForSelector('.omni-row'); return page.locator('.omni-group[aria-label="Actions"] .omni-row .omni-title').allTextContents() }
    const closeOmni = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
    const menuEntries = async () => {
      if (phone) return { entries: ['new-jam'].filter(() => false), shown: false }
      const wasOpen = (await page.locator('#toggle-sidebar').getAttribute('aria-expanded')) === 'true'
      if (!wasOpen) { await page.click('#toggle-sidebar'); await page.waitForTimeout(500) }
      await page.locator('#rail-new-note').click({ button: 'right' })
      await page.waitForTimeout(250)
      const shown = await page.locator('#note-create-menu').evaluate((e) => !e.hidden)
      const entries = shown ? await page.locator('#note-create-menu [data-entry-id]').evaluateAll((els) => els.map((e) => e.dataset.entryId)) : []
      if (shown) await page.keyboard.press('Escape')
      await page.mouse.click(viewport.width - 4, viewport.height - 4)
      return { shown, entries }
    }
    const island = () => page.evaluate(() => { const i = document.querySelector('#island'); const face = i.dataset.face; return { face, line: i.querySelector('.isl-line')?.textContent ?? null, text: i.querySelector('.isl-face:not([hidden])')?.textContent ?? '' } })
    const islandIs = (test, ms) => until(async () => test(await island()), ms)
    const nodes = () => page.$$eval('g.map-node', (els) => els.map((e) => ({ id: e.dataset.nodeId, text: e.getAttribute('aria-label'), at: e.getAttribute('transform'), label: e.querySelector('text')?.textContent })))
    const ghosts = () => page.$$eval('.map-ghost', (els) => els.map((e) => ({ id: e.dataset.ghostId, text: e.querySelector('text').textContent, why: e.querySelector('title').textContent })))
    const hasNode = async (text) => (await nodes()).some((n) => n.text === text)
    const saved = async (id) => (await call('GET', `/notes/${id}`)).body
    const mic = phone ? '#mobile-speak' : '#voice-button'
    // Talk: the mic is held (a phone) or tapped (desktop: it keeps listening) until the mocked service has heard the audio and sent the words.
    const press = () => page.locator(mic).dispatchEvent('pointerdown', { button: 0, pointerId: 1 })
    const release = () => page.locator(mic).dispatchEvent('pointerup', { button: 0, pointerId: 1 })
    const listening = () => page.evaluate(() => window.__personalNote.state.listening)
    const talk = async (utterance) => {
      said = [utterance]
      await press()
      if (!phone) await release()
      await until(() => said.length === 0, 10000)
      await wait(1300) // (the final words come a moment after the interim ones)
    }
    const stopTalking = async () => {
      if (phone) await release()
      else if (await listening()) { await press(); await wait(60); await release() }
      await until(async () => !(await listening()), 9000)
      await wait(300)
    }
    const pressJam = () => page.locator('#island .isl-face:not([hidden]) [data-island-action="jam"]').click()

    // The map can be wider than a phone: pan it with a real drag on the empty canvas until the pill is on screen, then tap it as a finger would.
    const reveal = async (action, text) => {
      const target = page.locator(`.map-ghost:has(text:text-is("${text}")) [data-ghost-action="${action}"]`)
      for (let i = 0; i < 4; i += 1) {
        const box = await target.boundingBox()
        if (box.x >= 0 && box.y >= 70 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height - 90) break
        const dx = Math.max(-170, Math.min(170, viewport.width / 2 - (box.x + box.width / 2)))
        const dy = Math.max(-170, Math.min(170, viewport.height / 2 - (box.y + box.height / 2)))
        await page.mouse.move(viewport.width / 2 - dx / 2, 150 - dy / 2)
        await page.mouse.down()
        await page.mouse.move(viewport.width / 2 + dx / 2, 150 + dy / 2, { steps: 6 })
        await page.mouse.up()
        await page.waitForTimeout(150)
      }
      return target
    }
    const tap = async (action, text) => { await (await reveal(action, text)).click(); await page.waitForTimeout(150) } // (a pill answers when the finger lifts)

    // ---- Jam is off until it is switched on
    await open(seededId)
    check(`${label}: Jam sessions starts off (a Settings row, no New jam entry)`, !(await page.evaluate(async () => (await (await fetch('/api/plugins')).json()).plugins.jam)))
    let titles = await omniTitles()
    check(`${label}: with Jam off the omnibar has no New jam`, !titles.includes('New jam'), JSON.stringify(titles))
    await closeOmni()
    let menu = await menuEntries()
    check(`${label}: with Jam off the new-note menu has no New jam`, !menu.entries.includes('new-jam'), JSON.stringify(menu))
    check(`${label}: with Jam off its code is never requested`, jamCode.length === 0, jamCode.join())
    await switchJam(true)
    check(`${label}: switched on while a jam map is open, that map gets the jam face at once`, await islandIs((f) => f.face === 'jam' && f.text.includes('Hold the mic and talk')), JSON.stringify(await island()))
    titles = await omniTitles()
    check(`${label}: switched on in Settings, the omnibar offers New jam`, titles.includes('New jam'), JSON.stringify(titles))
    await closeOmni()
    if (!phone) {
      menu = await menuEntries()
      check('desktop: and so does the new-note menu', menu.entries.includes('new-jam'), JSON.stringify(menu))
    }

    // ---- New jam
    await omniTitles()
    const was = await page.evaluate(() => window.__personalNote.state.activeNoteId)
    await page.waitForTimeout(400) // (the bar finishes growing)
    await page.locator('.omni-group[aria-label="Actions"] .omni-row', { hasText: 'New jam' }).click()
    await page.waitForFunction((old) => window.__personalNote.state.activeNoteId !== old && window.__personalNote.state.activeNoteType === 'mindmap' && !window.__personalNote.state.loading, was, { timeout: 15000 })
    const noteId = await page.evaluate(() => window.__personalNote.state.activeNoteId)
    await page.waitForSelector('g.map-node')
    check(`${label}: New jam makes a mind map whose centre idea is its title`, (await nodes()).length === 1 && (await nodes())[0].text === 'New jam' && (await page.inputValue('#note-title')) === 'New jam', JSON.stringify(await nodes()))
    check(`${label}: the island invites you to talk`, await islandIs((f) => f.face === 'jam' && f.text.includes('Hold the mic and talk')), JSON.stringify(await island()))
    check(`${label}: the mic is there on the map`, await page.locator(mic).isVisible())
    await shot('1-new-jam')

    // ---- hold the mic: the words are the live line
    said = [['we could sell', 'we could sell food to dog owners']]
    await press()
    if (!phone) await release()
    check(`${label}: while you talk, the island shows the words as you say them`, await islandIs((f) => f.face === 'jam' && f.line === 'we could sell'), JSON.stringify(await island()))
    await until(() => said.length === 0, 10000)
    await wait(1300)
    await stopTalking()
    check(`${label}: the finished sentence stays as the live line, ready for Jam`, await islandIs((f) => f.face === 'jam' && f.line === 'we could sell food to dog owners'), JSON.stringify(await island()))
    check(`${label}: no text box was made on the map`, (await page.locator('.mindmap-node-editor, .leafer-text-editor').count()) === 0)
    await shot('2-live-line')

    // ---- Jam: one turn, the map stays editable while it thinks
    setScript([{ answer: TURN_ONE, delay: 2 }])
    const root = (await nodes())[0]
    await pressJam()
    check(`${label}: Jam shows Thinking…`, await islandIs((f) => f.face === 'jam' && f.text.includes('Thinking…'), 1500), JSON.stringify(await island()))
    await shot('3-thinking')
    await page.locator('g.map-node').first().click()
    await page.keyboard.press('Tab') // the map is still yours: a new branch of your own while Claude thinks
    await page.waitForSelector('.mindmap-node-editor')
    await page.keyboard.type('Mine')
    await page.keyboard.press('Enter')
    check(`${label}: the map stays editable while Claude thinks`, await until(async () => hasNode('Mine'), 3000), JSON.stringify(await nodes()))
    const mine = (await nodes()).find((n) => n.text === 'Mine')
    check(`${label}: the turn arrives: Claude's branches, emoji and two ghosts`, await until(async () => (await ghosts()).length === 2 && (await hasNode('Customers')), 8000), JSON.stringify([await nodes(), await ghosts()]))
    await wait(500) // (the view settles on the grown map)
    const after = await nodes()
    check(`${label}: branches carry their emoji and a main branch gets its own colour`, after.find((n) => n.text === 'Customers')?.label === '🐕 Customers' && (await page.$$eval('.map-branch-ribbon', (els) => new Set(els.map((e) => e.getAttribute('fill'))).size)) >= 3, JSON.stringify(after))
    check(`${label}: your own branches did not move or change`, after.find((n) => n.id === root.id)?.at === root.at && after.find((n) => n.id === mine.id)?.at === mine.at && after.find((n) => n.id === mine.id)?.text === 'Mine')
    check(`${label}: the prompt held the map and the words said`, prompts().length === 1 && prompts()[0].includes('we could sell food to dog owners') && prompts()[0].includes('"text": "New jam"'), prompts()[0])
    check(`${label}: the words are used up, the live line is clear`, await islandIs((f) => f.face === 'jam' && f.text.includes('Hold the mic and talk')), JSON.stringify(await island()))
    const thumb = page.locator('[data-vote="up"]')
    check(`${label}: a thumb sits on Customers and its reason is the tooltip`, (await thumb.count()) === 1 && (await thumb.locator('title').textContent()) === 'Clear first audience')
    await thumb.click({ force: true })
    check(`${label}: tapping the thumb shows the reason`, await until(() => page.evaluate(() => { const t = document.querySelector('.mindmap-toast'); return t.classList.contains('visible') && t.textContent === 'Clear first audience' }), 2000))
    await wait(500) // (a phone's zoom into the tapped branch has to finish first)
    await page.evaluate(() => document.querySelector('[data-map-action="zoom-reset"]').click()) // (a phone zooms into a branch you tap; this shows the whole map again)
    const ghostOne = (await ghosts()).find((g) => g.text === 'Delivery')
    check(`${label}: a ghost says why on hover and is dashed`, ghostOne?.why === 'Heavy food is a pain to carry' && (await page.$$('.map-ghost rect[stroke-dasharray]')).length === 2 && (await page.$$('.map-ghost-branch')).length === 2)
    if (phone) {
      const heights = await page.$$eval('[data-ghost-action] rect', (els) => els.map((e) => e.getBoundingClientRect().height))
      check('phone: the Yes and No pills are at least 48px high', heights.length === 4 && heights.every((h) => h >= 47.5), JSON.stringify(heights))
    }
    await shot('4-turn-one')

    // ---- one turn is one undo step
    const beforeUndo = (await nodes()).length
    await page.evaluate(() => document.querySelector('[data-map-action="undo"]').click())
    const undone = await nodes()
    check(`${label}: one undo takes back the whole turn and nothing of yours`, undone.length === 2 && undone.some((n) => n.text === 'Mine') && !undone.some((n) => n.text === 'Customers') && (await ghosts()).length === 0 && (await page.locator('[data-vote]').count()) === 0, JSON.stringify(undone))
    await page.evaluate(() => document.querySelector('[data-map-action="redo"]').click())
    check(`${label}: redo brings the turn back`, (await nodes()).length === beforeUndo && (await ghosts()).length === 2)

    // ---- a drag that starts on a pill is a pan, not an answer
    const yesBox = await (await reveal('yes', 'Delivery')).boundingBox()
    const startX = yesBox.x + yesBox.width / 2
    const startY = yesBox.y + yesBox.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX - 30, startY - 30, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    check(`${label}: a drag starting on a Yes pill does not accept the ghost`, !(await hasNode('Delivery')) && (await ghosts()).some((g) => g.text === 'Delivery') && (await ghosts()).length === 2, JSON.stringify(await ghosts()))

    // ---- Yes and No on ghosts
    await tap('yes', 'Delivery')
    check(`${label}: Yes makes the ghost a real branch`, (await hasNode('Delivery')) && !(await ghosts()).some((g) => g.text === 'Delivery'))
    await page.evaluate(() => document.querySelector('[data-map-action="undo"]').click())
    check(`${label}: and that was its own undo step (the ghost is back)`, !(await hasNode('Delivery')) && (await ghosts()).some((g) => g.text === 'Delivery'))
    await tap('yes', 'Delivery')
    await shot('5-after-yes')
    const countBefore = (await nodes()).length
    await tap('no', 'Subscriptions')
    check(`${label}: No fades the ghost away and adds nothing`, await until(async () => (await ghosts()).length === 0) && (await nodes()).length === countBefore)

    // ---- "jam" at the end of speech; "yes" by voice
    setScript([{ answer: TURN_TWO }])
    await talk(['and then', 'and then loyalty cards for regulars jam'])
    await stopTalking()
    check(`${label}: saying "jam" at the end sends the turn without the word`, await until(() => prompts().length === 2) && prompts()[1].includes('and then loyalty cards for regulars') && !/jam\W*"""/.test(prompts()[1]), prompts()[1])
    check(`${label}: the new ghost arrives`, await until(async () => (await ghosts()).some((g) => g.text === 'Loyalty card')))
    await talk(['', 'Yes.'])
    await stopTalking()
    check(`${label}: saying "yes" accepts the newest ghost`, await until(async () => (await hasNode('Loyalty card')) && (await ghosts()).length === 0), JSON.stringify([await nodes(), await ghosts()]))
    check(`${label}: and "yes" was not sent to Claude`, prompts().length === 2)

    // ---- text, never HTML
    setScript([{ answer: TURN_HTML }])
    await talk(['', 'something odd'])
    await stopTalking()
    await pressJam()
    const literal = '<img src=x onerror=window.__pwned=1>'
    check(`${label}: branch text is text, never HTML`, (await until(() => hasNode(literal))) && (await page.evaluate(() => window.__pwned === undefined && !document.querySelector('.mindmap-stage img'))), JSON.stringify(await nodes()))
    check(`${label}: and its emoji shows`, (await nodes()).find((n) => n.text === literal)?.label === `🦄 ${literal}`)

    // ---- a brain that fails, and none set up
    const stableCount = (await nodes()).length
    setScript([{ error: SLOW }, { answer: TURN_REACT }])
    await talk(['', 'what about the budget'])
    await stopTalking()
    await pressJam()
    check(`${label}: a failing brain is said plainly, with Try again`, await islandIs((f) => f.face === 'jam' && f.text.includes(SLOW) && f.text.includes('Try again')), JSON.stringify(await island()))
    check(`${label}: and the map is untouched`, (await nodes()).length === stableCount && (await page.locator('[data-vote="down"]').count()) === 0)
    await shot('5-error')
    await pressJam() // Try again
    check(`${label}: Try again sends the same words and works`, (await until(() => page.locator('[data-vote="down"]').count())) === 1 && prompts().at(-1).includes('what about the budget') && prompts().at(-2).includes('what about the budget'))
    setScript([{ setup: NOT_INSTALLED }])
    await talk(['', 'one more thing'])
    await stopTalking()
    await pressJam()
    check(`${label}: with no brain set up the island points to Settings → AI`, await islandIs((f) => f.face === 'jam' && f.text.includes('Set up a model in Settings → AI.') && f.text.includes('Open Settings')), JSON.stringify(await island()))
    await shot('6-setup')
    await page.locator('#island [data-island-action="jam-setup"]').click()
    await page.waitForTimeout(600)
    check(`${label}: Open Settings shows the AI section`, await page.locator('#properties-panel').evaluate((e) => e.classList.contains('open')) && await page.locator('#ai-settings').isVisible())

    // ---- what is saved is an ordinary map
    await until(async () => (await saved(noteId)).content?.nodes?.some((n) => n.text === 'Loyalty card'), 6000)
    const doc = (await saved(noteId)).content
    check(`${label}: the saved note is a plain mind map with emoji, thumbs and jam mode, and no ghosts`, doc.jam === true && !('ghosts' in doc) && doc.nodes.find((n) => n.text === 'Customers')?.emoji === '🐕' && doc.nodes.find((n) => n.text === 'Customers')?.vote === 'up' && doc.nodes.find((n) => n.text === 'Customers')?.reason === 'Clear first audience', JSON.stringify(doc).slice(0, 300))
    await open(noteId)
    await page.waitForSelector('g.map-node')
    check(`${label}: reopened, it is the same map and still a jam`, (await hasNode('Customers')) && (await islandIs((f) => f.face === 'jam')))
    await shot('7-reopened')

    // ---- the answer to a turn lands nowhere if you have moved to another note
    const calmBefore = (await saved(seededId)).content.nodes.map((n) => n.text).join('|')
    const jamBefore = (await saved(noteId)).content.nodes.map((n) => n.text).join('|')
    setScript([{ answer: { edits: [{ op: 'add_branch', parent_id: 'root', text: 'Lands nowhere', emoji: '', id: 'z1' }] }, delay: 2.5 }])
    await talk(['', 'a last thought'])
    await stopTalking()
    await pressJam()
    check(`${label}: Jam shows Thinking… before the note is switched`, await islandIs((f) => f.face === 'jam' && f.text.includes('Thinking…'), 1500))
    await pick(seededId)
    await wait(4000) // (the brain answers while the other note is open)
    const here = (await nodes()).map((n) => n.text).join('|')
    check(`${label}: the late answer changed neither the note left nor the note opened`, !here.includes('Lands nowhere') && (await ghosts()).length === 0 && (await saved(seededId)).content.nodes.map((n) => n.text).join('|') === calmBefore && (await saved(noteId)).content.nodes.map((n) => n.text).join('|') === jamBefore && !(await call('GET', `/notes/${noteId}`)).body.content.nodes.some((n) => n.text === 'Lands nowhere'), here)
    await pick(noteId)
    check(`${label}: and back on the first note it is not there either`, !(await hasNode('Lands nowhere')))

    // ---- off again
    await switchJam(false)
    titles = await omniTitles()
    await closeOmni()
    menu = await menuEntries()
    check(`${label}: switched off, New jam is gone and the island is just the title`, !titles.includes('New jam') && !menu.entries.includes('new-jam') && (await island()).face === 'rest', JSON.stringify([titles, menu, await island()]))
    check(`${label}: the jam is over: no jam mode on the shell, no mic on a desktop map, and the map is still an ordinary one`, !(await page.evaluate(() => document.querySelector('.app-shell').classList.contains('jam-active'))) && (phone || !(await page.locator(mic).isVisible())) && (await hasNode('Customers')))
    jamCode = []
    await open(noteId)
    await page.waitForSelector('g.map-node')
    check(`${label}: reloaded with Jam off, the jam code is not requested`, jamCode.length === 0, jamCode.join())
    await context.close()
  }
  const real = errors.filter((e) => e.trim())
  check('no page errors', real.length === 0, real.slice(0, 3).join(' | '))
} catch (error) {
  check(`script ran to the end (${error.message})`, false)
  console.error(error)
} finally {
  await browser?.close()
  await server.close()
  api.kill()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} FAILED of ${results.length}` : `all ${results.length} passed`)
process.exit(failed ? 1 : 0)
