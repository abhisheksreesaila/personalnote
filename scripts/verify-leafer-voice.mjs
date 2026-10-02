// F-035 checks (voice and Prettify), in the real app on Leafer (Vite dev server on port 4810, mocked in-memory /api, headless Chromium with a
// fake microphone, and a mocked local transcription service on ws://127.0.0.1:8080/v1/realtime that answers audio with scripted words):
//   - the voice and Prettify buttons are live on the Leafer canvas
//   - dictation with nothing selected makes a new text; interim words show in the text being edited, final words stay; one undo step
//   - dictation continues the words of a text being edited (the overlay stays open when the voice button is pressed)
//   - a failing transcription service says so and leaves the note intact
//   - no audio is persisted anywhere (no IndexedDB, nothing in storage, nothing in any save)
//   - Prettify on the document model gives the same text the Fabric path gives (the same prettifySelection), as one undo step; with a
//     selection in the editor only the selection changes
//
//   TMPDIR=/var/tmp/x node scripts/verify-leafer-voice.mjs
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { readJsonCanvas } from '../src/core/document/jsoncanvas.js'
import { prettifySelection } from '../src/modules/editor/prettify.js'

const PORT = 4810
const now = new Date().toISOString()
const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/documents/app-all-tools.json', import.meta.url), 'utf8'))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }

const MESSY = 'res_00000000000040008000000000000091'
const MESSY_STICKY = 'res_00000000000040008000000000000092'
const clone = (object, changes) => ({ ...structuredClone(object), ...changes })
const messyText = '#Heading   \n- one  \n* two\n\n\n\nafter   '
fixture.content.objects.push(
  clone(fixture.content.objects[1], { type: 'Textbox', semanticId: MESSY, text: messyText, left: 420, top: 1010, width: 300, height: 120 }),
  clone(fixture.content.objects.find((o) => o.type === 'Sticky'), { semanticId: MESSY_STICKY, text: '+ item   \n\n\n\nend', left: 700, top: 840 }),
)
let stored = { content: fixture.content, pageState: fixture.pageState, revision: 1 }
const puts = []

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4819' } }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })

async function mock(page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^\/api/, '')
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    const summary = { id: 1, resourceId: 'r1', revision: stored.revision, noteType: 'canvas', title: 'Voice', notebookId: 1, createdAt: now, updatedAt: now }
    if (p === '/notebooks') return json([{ id: 1, resourceId: 'nb', revision: 1, name: 'N', color: '#76669a', noteCount: 1 }])
    if (p === '/notes' && req.method() === 'GET') return json([summary])
    if (p === '/changes') return json({ sequence: 1, changes: [], agents: [] })
    if (p === '/voice/status') return json({ state: 'unsupported' }) // not the download path: the page goes straight to the (mocked) local service
    if (p === '/notes/1' && req.method() === 'GET') return json({ ...summary, content: stored.content, pageState: stored.pageState })
    if (p === '/notes/1' && req.method() === 'PUT') {
      const body = JSON.parse(req.postData())
      puts.push(body)
      stored = { content: body.content, pageState: body.pageState, revision: stored.revision + 1 }
      return json({ revision: stored.revision, resourceId: 'r1' })
    }
    return json({})
  })
}

// The mocked transcription service: each burst of audio answers with the next scripted utterance (interim words, then the final sentence).
// `fail` makes it report an error instead.
let script = []
let fail = false
let audioFrames = 0
async function mockService(page) {
  await page.routeWebSocket('ws://127.0.0.1:8080/v1/realtime', (ws) => {
    let said = false
    ws.onMessage((message) => {
      if (typeof message === 'string') return
      audioFrames += 1
      if (said) return
      said = true
      if (fail) { ws.send(JSON.stringify({ type: 'error', error: { message: 'engine stopped' } })); return }
      const [interim, final] = script.shift() ?? ['', '']
      setTimeout(() => ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: interim })), 50)
      setTimeout(() => ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: final })), 700)
    })
  })
}

const live = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__personalNote.leaferEdits.doc)))
const steps = (page) => page.evaluate(() => window.__personalNote.leaferEdits.stats().undoSteps)
const savedDoc = () => readJsonCanvas(puts.at(-1).content)
const waitForSave = async (before) => { for (let i = 0; i < 40 && puts.length <= before; i += 1) await new Promise((r) => setTimeout(r, 150)); await new Promise((r) => setTimeout(r, 100)); return puts.length > before }
const editorValue = (page) => page.evaluate(() => document.querySelector('.leafer-text-editor')?.value ?? null)
const objectOf = (doc, id) => doc.objects.find((object) => object.id === id)
const caption = (page) => page.evaluate(() => { const c = document.querySelector('#voice-caption'); return c.hidden ? null : document.querySelector('#voice-status').textContent })
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)) } return false }
const stopped = (page) => until(() => page.evaluate(() => !window.__personalNote.state.listening), 7000) // the service gets a moment to answer the end of the audio

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] })
  const page = await context.newPage()
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await mock(page)
  await mockService(page)
  await page.goto(`http://127.0.0.1:${PORT}/notes`)
  await page.waitForFunction(() => document.documentElement.dataset.leaferSettled, null, { timeout: 60000 })
  await page.waitForTimeout(400)

  // ---- the buttons are live
  const enabled = await page.evaluate(() => ['prettify', 'voice-button', 'mobile-speak'].map((id) => { const b = document.getElementById(id); return [id, !b.disabled, getComputedStyle(b).pointerEvents !== 'none'] }))
  check('the voice, speak and Prettify buttons are enabled on the Leafer canvas', enabled.every(([, on, reachable]) => on && reachable), JSON.stringify(enabled))

  const initial = await live(page)
  const T = initial.objects.filter((o) => o.type === 'text')[0].id

  // ---- dictation into a new text
  script = [['hello wor', 'hello world'], ['and more', 'and more words']]
  let before = await live(page)
  let stepsBefore = await steps(page)
  let n = puts.length
  await page.click('#voice-button')
  check('dictation opens the text editor over a new text', await until(() => page.evaluate(() => Boolean(document.querySelector('.leafer-text-editor')))))
  check('the interim words show in the text being edited', await until(async () => (await editorValue(page)) === 'hello wor'), String(await editorValue(page)))
  check('the final words replace the interim ones', await until(async () => (await editorValue(page)) === 'hello world'), String(await editorValue(page)))
  check('the listening caption shows', (await caption(page)) !== null)
  await page.click('#voice-button') // stop
  await stopped(page)
  let doc = await live(page)
  let made = doc.objects.filter((o) => !before.objects.some((old) => old.id === o.id))
  check('the dictated words are one new text in the document', made.length === 1 && made[0].type === 'text' && made[0].content === 'hello world', JSON.stringify(made.map((o) => o.content)))
  await page.evaluate(() => window.__personalNote.leaferCanvas().finishTextEdit())
  check('dictation is one undo step', (await steps(page)) === stepsBefore + 1, `${stepsBefore} -> ${await steps(page)}`)
  await waitForSave(n)
  check('the dictated text is saved', objectOf(savedDoc(), made[0]?.id)?.content === 'hello world')
  await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  check('one undo takes the dictated text away', (await live(page)).objects.length === before.objects.length)
  await page.evaluate(() => window.__personalNote.leaferEdits.redo())

  // ---- dictation continues the text being edited
  before = await live(page)
  stepsBefore = await steps(page)
  const original = objectOf(before, T).content
  await page.evaluate((id) => window.__personalNote.leaferCanvas().editText(id), T)
  await page.waitForSelector('.leafer-text-editor')
  await page.keyboard.press('Control+End')
  await page.click('#voice-button')
  check('pressing the voice button keeps the text editor open', await page.evaluate(() => Boolean(document.querySelector('.leafer-text-editor'))))
  check('the dictated words are added after the words already there', await until(async () => (await editorValue(page)) === `${original} and more words`), String(await editorValue(page)))
  await page.click('#voice-button')
  await stopped(page)
  await page.evaluate(() => window.__personalNote.leaferCanvas().finishTextEdit())
  doc = await live(page)
  check('the edited text now holds the old and the dictated words', objectOf(doc, T).content === `${original} and more words`, objectOf(doc, T)?.content)
  check('dictating into a text is one undo step with the typing session', (await steps(page)) === stepsBefore + 1, `${stepsBefore} -> ${await steps(page)}`)
  await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  check('undo brings the old words back', objectOf(await live(page), T).content === original)
  await page.evaluate(() => window.__personalNote.leaferEdits.redo())

  // ---- a failing service is said, and the note is intact
  fail = true
  before = await live(page)
  const texts = (d) => JSON.stringify(d.objects.map((o) => o.content ?? null))
  await page.click('#voice-button')
  const said = await until(async () => { const c = await caption(page); return c && /unavailable|stopped|could not|no audio/i.test(c) ? c : false }, 5000)
  check('a transcription failure is visible to the person', Boolean(said), String(await caption(page)))
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__personalNote.leaferCanvas().finishTextEdit())
  check('and the note is intact', texts(await live(page)) === texts(before), `${texts(await live(page)).length} vs ${texts(before).length}`)
  check('the listening state is off after a failure', await page.evaluate(() => !window.__personalNote.state.listening))
  fail = false

  // ---- no audio is persisted
  const storage = await page.evaluate(async () => ({
    dbs: (await indexedDB.databases?.())?.map((d) => d.name) ?? [],
    local: Object.keys(localStorage).concat(Object.keys(sessionStorage)),
    caches: await caches.keys(),
  }))
  check('audio was captured and sent to the service', audioFrames > 0, String(audioFrames))
  check('no IndexedDB database, cache or storage key holds audio', storage.dbs.length === 0 && storage.caches.length === 0 && storage.local.every((key) => !/audio|pcm|voice|record/i.test(key)), JSON.stringify(storage))
  check('no save carries audio', puts.every((body) => !/audio|pcm/i.test(JSON.stringify(body))))

  // ---- Prettify
  const expected = (value) => prettifySelection(value, 0, 0).text
  before = await live(page)
  stepsBefore = await steps(page)
  n = puts.length
  await page.evaluate(() => window.__personalNote.leaferCanvas().clearSelection())
  await page.click('#prettify')
  await waitForSave(n)
  doc = await live(page)
  const textual = before.objects.filter((o) => o.type === 'text' || o.type === 'sticky')
  const same = textual.every((o) => objectOf(doc, o.id).content === expected(o.content))
  check('Prettify gives every text and sticky the text the Fabric path gives', same, JSON.stringify(textual.map((o) => [objectOf(doc, o.id).content, expected(o.content)]).filter(([a, b]) => a !== b)))
  check('Prettify actually changed the messy ones', objectOf(doc, MESSY).content !== messyText && objectOf(doc, MESSY).content === expected(messyText) && objectOf(doc, MESSY_STICKY).content === expected('+ item   \n\n\n\nend') && objectOf(doc, MESSY).content.includes('• one'), JSON.stringify([objectOf(doc, MESSY).content, objectOf(doc, MESSY_STICKY).content]))
  check('Prettify is one undo step', (await steps(page)) === stepsBefore + 1, `${stepsBefore} -> ${await steps(page)}`)
  check('the prettified note is saved', puts.length > n && objectOf(savedDoc(), MESSY).content === objectOf(doc, MESSY).content)
  check('everything else is untouched', JSON.stringify(doc.objects.filter((o) => o.type !== 'text' && o.type !== 'sticky')) === JSON.stringify(before.objects.filter((o) => o.type !== 'text' && o.type !== 'sticky')))
  await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  const undone = await live(page)
  check('one undo restores every text', textual.every((o) => objectOf(undone, o.id).content === o.content))
  await page.evaluate(() => window.__personalNote.leaferEdits.redo())
  await page.click('#prettify')
  await page.waitForTimeout(200)
  check('Prettify on an already tidy note records nothing', (await steps(page)) === stepsBefore + 1)

  // with a selection in the editor, only the selection is tidied
  await page.evaluate(() => window.__personalNote.leaferEdits.undo())
  await page.evaluate((id) => window.__personalNote.leaferCanvas().editText(id), MESSY)
  await page.waitForSelector('.leafer-text-editor')
  await page.evaluate(() => { const a = document.querySelector('.leafer-text-editor'); a.setSelectionRange(0, 12) })
  await page.click('#prettify')
  const partial = await editorValue(page)
  check('with words selected in the editor only the selection is tidied', partial === prettifySelection(messyText, 0, 12).text && partial.endsWith('after   '), JSON.stringify(partial))
  check('the editor stays open after Prettify', await page.evaluate(() => Boolean(document.querySelector('.leafer-text-editor'))))
  await page.evaluate(() => window.__personalNote.leaferCanvas().finishTextEdit())

  const realErrors = errors.filter((e) => !/WebSocket|8080|status of 4/.test(e))
  check('no page errors', realErrors.length === 0, realErrors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
