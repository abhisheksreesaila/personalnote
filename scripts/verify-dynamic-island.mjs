// F-084 checks, in the real app (Vite dev server on PN_VERIFY_PORT, mocked /api, headless Chromium with a fake microphone and a mocked local
// transcription service), the dynamic island playing each of its moments with the real mouse and keyboard:
//   - a routine save never changes the island (no new face, no measure, no frame, same size), however long you type
//   - a save still out after 3 s: Saving, then Saved for a moment, then the title again at its old size
//   - a failed save stays (danger edge, reason, Try again) until a save works
//   - voice: a dark face with bars that move to the sound, a clock that runs and a Stop that really stops; then "Added N words", then the title
//   - an agent at work shows on the island (the chip is gone); a notice lasts 4 s
//   - a voice or search download shows its name and percent from the Settings status poll, then "... is ready"
//   - focus mode: the island wears the focus face
//   - the search circle grows leftward into the field in place and shrinks back on Esc, on a pick and on a click away
//   - nothing runs at rest: no island timer, no frame, no animation, and the speed meter's numbers are the speed test's business
//   - Crayon, Paper, Night and a phone: pictures of every face
//
//   PN_VERIFY_PORT=4896 node scripts/verify-dynamic-island.mjs      (PN_SHOT=/var/tmp/f084/di also saves pictures)
import { createServer } from 'vite'
import { chromium } from 'playwright'

const PORT = Number(process.env.PN_VERIFY_PORT || 4896)
if (PORT === 3137) throw new Error('never the real app port')
const now = new Date().toISOString()
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(40) } return false }

let content = { objects: [] }
let putDelay = 0
let failSave = false
let agents = []
let voiceStatus = { state: 'unsupported' }
let meaningStatus = { state: 'not-installed' }
let saves = 0
const script = [['hello wor', 'hello world']]

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': `http://127.0.0.1:${PORT + 1}` } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] })
  // What the island does, counted from the page: its timers and frames (by who asked for them), and every time a face is measured.
  await context.addInitScript(() => {
    const calls = { timers: 0, frames: 0, measures: 0 }
    window.__island = calls
    const mine = () => /modules\/island\//.test(new Error().stack || '')
    for (const name of ['setTimeout', 'setInterval']) { const original = window[name]; window[name] = function (...args) { if (mine()) calls.timers += 1; return original.apply(this, args) } }
    const frame = window.requestAnimationFrame
    window.requestAnimationFrame = function (...args) { if (mine()) calls.frames += 1; return frame.apply(this, args) }
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { if (this.classList?.contains('isl-face')) calls.measures += 1; return width.get.call(this) } })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error' && !/WebSocket|8080|Disk is full|Request failed|status of 5/.test(message.text())) errors.push(message.text()) })
  await context.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const summary = { id: 1, resourceId: 'r1', revision: 1, noteType: 'canvas', title: 'Kitchen renovation', notebookId: 1, createdAt: now, updatedAt: now }
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'Home', category: 'projects', color: '#76669a', noteCount: 1 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary])
    if (p === '/notes/1' && req.method() === 'GET') return json({ ...summary, content, pageState: { columns: 1, rows: 1 } })
    if (p === '/notes/1' && req.method() === 'PUT') {
      saves += 1
      if (putDelay) await wait(putDelay)
      if (failSave) return json({ error: 'Disk is full' }, 500)
      const body = JSON.parse(req.postData() || '{}')
      if (body.content) content = body.content
      return json({ revision: 2, resourceId: 'r1' })
    }
    if (p === '/changes') return json({ sequence: 1, changes: [], agents })
    if (p === '/voice/status') return json(voiceStatus)
    if (p === '/search-meaning/status') return json(meaningStatus)
    if (p.startsWith('/search')) return json([])
    return json({})
  })
  await page.routeWebSocket('ws://127.0.0.1:8080/v1/realtime', (ws) => {
    let said = false
    ws.onMessage((message) => {
      if (typeof message === 'string' || said) return
      said = true
      const [interim, final] = script.shift() ?? ['', '']
      setTimeout(() => ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: interim })), 50)
      setTimeout(() => ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: final })), 1800)
    })
  })

  const shotDir = process.env.PN_SHOT
  const shot = async (name) => { if (shotDir) await page.screenshot({ path: `${shotDir}-${name}.png` }) }
  const rect = (selector) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && { x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height } }, selector)
  const face = () => page.evaluate(() => document.querySelector('#island').dataset.face)
  const text = () => page.evaluate(() => [...document.querySelectorAll('#island .isl-face:not([hidden])')].map((f) => f.innerText).join(' ').replace(/\s+/g, ' ').trim())
  const calls = () => page.evaluate(() => ({ ...window.__island }))
  const settle = () => page.waitForFunction(() => document.querySelector('#island').getAnimations({ subtree: true }).every((a) => a.effect.getComputedTiming().iterations === Infinity), null, { timeout: 5000 })
  const waitFace = (name, ms = 8000) => page.waitForFunction((n) => document.querySelector('#island').dataset.face === n, name, { timeout: ms })
  const widthNow = async () => { await settle(); return (await rect('#island')).w }
  const pn = (fn, arg) => page.evaluate(fn, arg)
  const searchSettled = () => page.waitForFunction(() => document.querySelector('#search-backdrop').classList.contains('open') && document.querySelector('.spotlight').getAnimations().length === 0)
  let first = null
  const type = async (words) => { // (the first time a click on the page starts a text; after that the same text is written on, from the keyboard)
    if (!first) {
      const host = await rect('#leafer-host')
      await page.mouse.click(host.x + 500, host.y + 250)
      await wait(350)
      first = 'made'
    } else {
      await pn(() => { const o = window.__personalNote.leaferEdits.doc.objects.find((x) => x.type === 'text'); window.__personalNote.leaferCanvas().editText(o.id) })
      await page.waitForSelector('.leafer-text-editor')
      await page.keyboard.press('Control+End')
    }
    await page.keyboard.type(words, { delay: 25 })
    await page.keyboard.press('Escape') // (the words become an edit, and a save goes out after its short wait)
  }

  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await wait(600)
  await settle()
  const W0 = await widthNow()
  check('at rest the island is only the title', (await face()) === 'rest' && (await text()) === 'Kitchen renovation', await text())

  // --- a routine save never changes the island
  const c0 = await calls()
  const savesBefore = saves
  await type('Quotes from three builders by the end of the month, then the plumbing for the island sink.')
  await wait(1200)
  const c1 = await calls()
  check('typing and saving (a real save went out) changes nothing about the island: same face, same size', saves > savesBefore && (await face()) === 'rest' && (await widthNow()) === W0 && c1.measures === c0.measures, JSON.stringify({ c0, c1, saves: saves - savesBefore, face: await face() }))
  check('and it asked for no frame at all while you typed', c1.frames === c0.frames, JSON.stringify({ c0, c1 }))
  check('and at most one timer per save (the 3 s wait), never one per key', c1.timers - c0.timers <= saves - savesBefore, JSON.stringify({ c0, c1, saves: saves - savesBefore }))

  // --- nothing runs at rest
  await page.keyboard.press('Escape')
  await wait(500)
  const r0 = await calls()
  await wait(2500)
  const r1 = await calls()
  const rest = await pn(() => ({ island: document.querySelector('#island').getAnimations({ subtree: true }).length, running: document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.effect?.target?.className || a.effect?.target?.tagName) }))
  check('at rest the island starts no timer and no frame, measures nothing and animates nothing', r1.timers === r0.timers && r1.frames === r0.frames && r1.measures === r0.measures && rest.island === 0, JSON.stringify({ r0, r1, rest }))
  await shot('crayon-or-paper-rest')

  // --- a save still out after 3 s
  putDelay = 4200
  await type(' More words to save slowly.')
  const slowStart = Date.now()
  await waitFace('saving', 9000)
  const slowAfter = Date.now() - slowStart
  await settle()
  const saving = { text: await text(), spinner: await pn(() => Boolean(document.querySelector('#island .saving-spinner')) ), width: await widthNow() }
  check('a save still pending after about 3 s shows Saving with a spinner', saving.text === 'Saving' && saving.spinner && slowAfter >= 2000, JSON.stringify({ saving, slowAfter }))
  check('the island changed size to fit it', saving.width !== W0, JSON.stringify({ W0, saving }))
  await shot('slow-saving')
  await waitFace('saved', 8000)
  check('when the save lands it says Saved', (await text()).includes('Saved'))
  await waitFace('rest', 4000)
  await settle()
  check('then it is the title again, at its old size', (await text()) === 'Kitchen renovation' && Math.abs((await widthNow()) - W0) <= 1, JSON.stringify({ t: await text(), w: await widthNow(), W0 }))
  putDelay = 0

  // --- a failed save stays
  failSave = true
  await type(' And one more.')
  await waitFace('error', 8000)
  await settle()
  const err = await pn(() => { const i = document.querySelector('#island'); return { text: i.innerText.replace(/\s+/g, ' ').trim(), edge: getComputedStyle(i).borderColor, retry: Boolean(i.querySelector('[data-island-action="retry"]')), modal: Boolean(document.querySelector('dialog[open]')) } })
  check('a failed save says Couldn’t save, why, and offers Try again', /Couldn’t save/.test(err.text) && /Disk is full/.test(err.text) && err.retry && !err.modal, JSON.stringify(err))
  check('the island grew for it and has a danger edge', (await widthNow()) > W0 && err.edge !== (await pn(() => getComputedStyle(document.querySelector('.search-button')).borderColor)), JSON.stringify(err))
  await shot('error')
  await wait(2500)
  check('it stays until the save works', (await face()) === 'error')
  failSave = false
  await page.click('[data-island-action="retry"]')
  await waitFace('saved', 8000)
  await waitFace('rest', 4000)
  await settle()
  check('Try again saves it; then the title again', (await text()) === 'Kitchen renovation' && Math.abs((await widthNow()) - W0) <= 1, JSON.stringify({ t: await text(), w: await widthNow(), W0 }))

  // --- voice: the recording face, level bars, a clock and a Stop that stops
  const before = await calls()
  await page.click('#voice-button')
  await waitFace('recording', 8000)
  await settle()
  const dark = await pn(() => { const i = document.querySelector('#island'); return { bg: getComputedStyle(i).backgroundColor, ink: (() => { const p = document.createElement('i'); p.style.color = 'var(--sk-ink)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c })(), text: i.innerText.replace(/\s+/g, ' ').trim(), bars: i.querySelectorAll('.isl-wave i').length, stop: Boolean(i.querySelector('[data-island-action="stop"]')) } })
  check('recording: a dark face with a dot, bars, Listening, a clock and Stop', dark.bg === dark.ink && /Listening/.test(dark.text) && /0:0\d/.test(dark.text) && dark.bars >= 7 && dark.stop, JSON.stringify(dark))
  check('the island grew for it', (await widthNow()) > W0)
  await shot('recording')
  const levels = await until(async () => pn(() => { const v = [...document.querySelectorAll('#island .isl-wave i')].map((b) => b.style.getPropertyValue('--l')).filter(Boolean); return v.length && v.some((x) => Number(x) > 0) ? v : false }), 5000)
  check('the bars move to the sound (levels from the microphone reach them)', Boolean(levels), JSON.stringify(levels))
  await wait(1300)
  const clockText = await pn(() => document.querySelector('#island .isl-clock').textContent)
  check('the clock runs', clockText !== '0:00', clockText)
  const during = await calls()
  check('while recording it asked for no animation frame', during.frames === before.frames, JSON.stringify({ before, during }))
  await page.click('[data-island-action="stop"]')
  check('Stop really stops: the app is not listening', await until(() => pn(() => !window.__personalNote.state.listening), 8000))
  await waitFace('added', 8000)
  check('then it says how many words were added', (await text()).includes('Added 2 words'), await text())
  await waitFace('rest', 4000)
  await settle()
  check('and the title is back at its size', Math.abs((await widthNow()) - W0) <= 1, JSON.stringify({ w: await widthNow(), W0 }))
  const afterVoice = await pn(() => ({ bars: document.querySelectorAll('#island .isl-wave').length, anims: document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.target?.closest?.('#island')).length }))
  check('the bars and the clock are gone with it', afterVoice.bars === 0 && afterVoice.anims === 0, JSON.stringify(afterVoice))
  await pn(() => window.__personalNote.leaferCanvas().finishTextEdit())

  // --- an agent at work, and a notice
  agents = [{ agent: 'Claude Code', action: 'writing', noteId: 1, noteTitle: 'Kitchen renovation' }]
  await waitFace('agent', 10000)
  await settle()
  check('an agent shows on the island (and there is no chip)', (await text()) === 'Claude Code is writing' && (await pn(() => !document.querySelector('#agent-chip'))), await text())
  check('it grew for it', (await widthNow()) > W0)
  await shot('agent')
  agents = []
  await waitFace('rest', 10000)
  await pn(() => window.__personalNote.island.agentNotice('New text from an agent was added next to your edits'))
  await waitFace('agent')
  const noticeAt = Date.now()
  await waitFace('rest', 8000)
  const noticeFor = Date.now() - noticeAt
  check('an agent notice shows for about 4 s, then the title', noticeFor >= 3000 && noticeFor <= 5500, String(noticeFor))

  // --- downloads: from the Settings status poll
  voiceStatus = { state: 'downloading', percent: 12, phase: 'model' }
  await page.click('#share-button')
  await page.click('#top-properties')
  await waitFace('download', 8000)
  await settle()
  const dl = await pn(() => ({ text: document.querySelector('#island').innerText.replace(/\s+/g, ' ').trim(), bar: document.querySelector('#island .isl-bar i').style.transform }))
  check('a voice download shows its name, a bar and its percent', /Voice model/.test(dl.text) && /12%/.test(dl.text) && dl.bar === 'scaleX(0.12)', JSON.stringify(dl))
  check('the island grew for it', (await widthNow()) > W0)
  await shot('download')
  const m0 = (await calls()).measures
  voiceStatus = { state: 'downloading', percent: 64, phase: 'model' }
  await pn(() => 0)
  await until(() => pn(() => /64%/.test(document.querySelector('#island').innerText)), 6000)
  check('the percent moves in place, with no new measure', (await calls()).measures === m0 && (await pn(() => document.querySelector('#island .isl-bar i').style.transform)) === 'scaleX(0.64)', JSON.stringify(await calls()))
  voiceStatus = { state: 'ready', running: true }
  await waitFace('ready', 6000)
  check('when it finishes it says it is ready', (await text()).includes('Voice model is ready'), await text())
  await waitFace('rest', 4000)
  meaningStatus = { state: 'downloading', percent: 30, phase: 'model' }
  await page.click('#close-properties')
  await page.click('#share-button')
  await page.click('#top-properties')
  await waitFace('download', 8000)
  check('a search-by-meaning download shows the same way', /Search by meaning/.test(await text()) && /30%/.test(await text()), await text())
  meaningStatus = { state: 'not-installed' }
  await until(async () => (await face()) !== 'download', 6000)
  check('a cancelled download just leaves', (await face()) !== 'download')
  await waitFace('rest', 4000)
  await page.click('#close-properties')

  // --- focus: the island wears the focus face
  await page.click('#share-button')
  await page.click('#share-focus')
  await wait(900)
  check('in focus mode the island wears the focus face: title, words, Leave focus', (await face()) === 'focus' && /Kitchen renovation/.test(await text()) && /\d+ words?/.test(await text()) && /Leave focus/.test(await text()), await text())
  await page.keyboard.press('Escape')
  await wait(900)
  await waitFace('rest', 3000)
  check('leaving focus puts the title back', (await text()) === 'Kitchen renovation')

  // --- the search circle
  const circle = await rect('#search-button')
  check('the search circle is 44px, round, at the top right', circle.w === 44 && circle.h === 44 && circle.r === 1264 && circle.y === 16 && (await pn(() => getComputedStyle(document.querySelector('#search-button')).borderRadius)) === '50%', JSON.stringify(circle))
  await page.click('#search-button')
  await pn(() => 0)
  const grow = []
  for (let i = 0; i < 8; i += 1) { grow.push(Math.round((await rect('.spotlight')).w)); await wait(25) }
  await searchSettled()
  const open = await rect('.spotlight')
  check('it grows out of the circle (44px at first, then wider), anchored at the same top right corner', grow[0] <= 200 && open.w >= 370 && Math.abs(open.r - circle.r) <= 1 && Math.abs(open.y - circle.y) <= 1 && grow.some((w, i) => i && w > grow[i - 1]), JSON.stringify({ grow, open, circle }))
  check('the field is focused and results are below it', await pn(() => document.activeElement.id === 'search-input' && document.querySelectorAll('.omni-row').length > 0))
  await shot('search-open')
  const closedBy = async (how, run) => {
    await run()
    const shrink = []
    for (let i = 0; i < 8; i += 1) { shrink.push(Math.round((await rect('.spotlight'))?.w ?? 0)); await wait(25) }
    const hidden = await page.waitForSelector('#search-backdrop', { state: 'hidden', timeout: 3000 }).then(() => true, () => false)
    const back = await rect('#search-button')
    check(`${how} shrinks it back to the circle`, hidden && shrink.some((w) => w < open.w - 20) && Math.abs(back.w - 44) < 1 && back.r === 1264, JSON.stringify({ shrink, hidden, back }))
  }
  await closedBy('Esc', () => page.keyboard.press('Escape'))
  await page.click('#search-button')
  await searchSettled()
  await closedBy('a click away', () => page.mouse.click(300, 600))
  await page.click('#search-button')
  await searchSettled()
  await page.keyboard.press('Control+k')
  await page.waitForSelector('#search-backdrop', { state: 'hidden' })
  check('Ctrl+K toggles it', true)
  await page.keyboard.press('Control+k')
  await searchSettled()
  await page.keyboard.type('Kitchen')
  await page.waitForSelector('.omni-row')
  await closedBy('picking a result', () => page.keyboard.press('Enter'))

  // --- every skin, and a phone
  for (const skin of ['crayon', 'paper', 'night']) {
    await pn((s) => document.documentElement.setAttribute('data-skin', s), skin)
    await wait(500)
    await settle()
    await shot(`${skin}-rest`)
    await pn(() => window.__personalNote.island.saveFailed('Couldn’t save', 'Disk is full', true))
    await waitFace('error')
    await settle()
    await shot(`${skin}-error`)
    await pn(() => window.__personalNote.island.saveDone())
    await waitFace('rest', 4000)
    await pn(() => window.__personalNote.island.recording(true, Date.now()))
    await waitFace('recording')
    await settle()
    await shot(`${skin}-recording`)
    await pn(() => window.__personalNote.island.recording(false, 0))
    await waitFace('rest')
    await page.click('#island')
    await settle()
    await shot(`${skin}-card`)
    await page.keyboard.press('Escape')
    await page.click('#search-button')
    await searchSettled()
    await shot(`${skin}-search`)
    await page.keyboard.press('Escape')
    await wait(300)
  }
  await pn(() => document.documentElement.setAttribute('data-skin', 'paper'))
  await page.setViewportSize({ width: 390, height: 844 })
  await wait(600)
  await settle()
  const phoneRest = await rect('#island')
  check('on a phone the island is 40px high between the two circles', phoneRest.h === 40 && phoneRest.x >= 56 && phoneRest.r <= 390 - 56, JSON.stringify(phoneRest))
  const springy = await pn(() => { const c = getComputedStyle(document.querySelector('#island')); return { curve: c.transitionTimingFunction, time: c.transitionDuration } })
  check('on a phone it moves with a spring (overshooting curve, 420ms)', /cubic-bezier\(0\.28, 1\.32, 0\.5, 1\)/.test(springy.curve) && springy.time.includes('0.42s'), JSON.stringify(springy))
  await shot('phone-rest')
  await pn(() => window.__personalNote.island.saveFailed('Couldn’t save', 'Disk is full', true))
  await waitFace('error')
  await settle()
  const phoneError = await rect('#island')
  check('an error face on a phone stays between the circles', phoneError.x >= 56 && phoneError.r <= 390 - 56, JSON.stringify(phoneError))
  await shot('phone-error')
  await pn(() => window.__personalNote.island.saveDone())
  await waitFace('rest', 4000)
  await pn(() => window.__personalNote.island.recording(true, Date.now()))
  await waitFace('recording')
  await settle()
  const phoneRec = await rect('#island')
  check('a recording face on a phone fits the window', phoneRec.x >= 0 && phoneRec.r <= 390, JSON.stringify(phoneRec))
  await shot('phone-recording')
  await pn(() => window.__personalNote.island.recording(false, 0))
  await waitFace('rest')
  await page.click('#island')
  await settle()
  await shot('phone-card')
  await page.keyboard.press('Escape')
  await page.click('#search-button')
  await wait(500)
  await shot('phone-search')
  await page.keyboard.press('Escape')

  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} of ${results.length} FAILED` : `all ${results.length} passed`)
process.exit(failed ? 1 : 0)
