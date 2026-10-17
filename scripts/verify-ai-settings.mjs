// F-093: Settings → AI in the real app: Vite dev server on PN_VERIFY_PORT (never 3137) with the real API on the next port and a fake
// OpenAI-compatible (Azure-shaped) model server on loopback on the one after, headless Chromium, a scratch database and AI folder.
// It enters Azure fields and a key, saves, reloads (the key shows as saved and never appears in the page), Test succeeds, a wrong
// key shows the error in place, Remove key brings the key field back, and nothing but the keychain file holds the key. Phone width
// (44px targets) and desktop. With PN_REAL_CLAUDE=1 it also runs Test with the Claude Code provider on this machine and prints the time.
//   PN_VERIFY_PORT=4900 node scripts/verify-ai-settings.mjs        (PN_SHOT=/path/shot.png also saves pictures)
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { assertPortsFree, basePort } from './lib/ports.mjs'

const UI_PORT = basePort(4900)
if ([UI_PORT, UI_PORT + 1, UI_PORT + 2].includes(3137)) throw new Error('Never use the real app port (3137)')
const API_PORT = UI_PORT + 1
const MODEL_PORT = UI_PORT + 2
await assertPortsFree([UI_PORT, API_PORT, MODEL_PORT])
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : detail}`) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-verify-ai-'))
const aiDir = path.join(scratch, 'ai')
const python = path.resolve(fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3')
const GOOD_KEY = 'verify-good-key-4f9a1c7e22b0'
const WRONG_KEY = 'verify-wrong-key-77d3e0aa19c4'

// ---- the fake model service: answers only to the good key, remembers what it was asked
const asked = []
const model = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    asked.push({ url: request.url, key: request.headers['api-key'], body })
    const good = request.headers['api-key'] === GOOD_KEY
    setTimeout(() => {
      response.writeHead(good ? 200 : 401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(good ? { choices: [{ message: { content: '{"ok": true}' } }] } : { error: 'bad key' }))
    }, 250)
  })
})
model.listen(MODEL_PORT, '127.0.0.1')

const env = { ...process.env, PERSONAL_NOTE_DB: path.join(scratch, 'verify.db'), PERSONAL_NOTE_AI_DIR: aiDir }
delete env.PERSONAL_NOTE_JAM_API_KEY // a key in the environment would override the saved one
const API = `http://127.0.0.1:${API_PORT}`
const api = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], { env, stdio: 'ignore' })
const apiUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${API}/api/notebooks`)).ok) return } catch {} await new Promise((r) => setTimeout(r, 150)) } throw new Error('API did not start') }
const server = await createServer({ server: { port: UI_PORT, strictPort: true, host: '127.0.0.1', proxy: { '/api': API } }, logLevel: 'error' })
let browser
try {
  await apiUp()
  await server.listen()
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const errors = []
  for (const [label, viewport] of [['phone', { width: 390, height: 780 }], ['desktop', { width: 1360, height: 900 }]]) {
    const page = await (await browser.newContext({ viewport })).newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    const shot = async (name) => { if (process.env.PN_SHOT) { await page.locator('#ai-save').scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.PN_SHOT.replace('.png', `-${label}-${name}.png`) }) } }
    const open = async () => {
      await page.goto(`http://127.0.0.1:${UI_PORT}/notes`)
      await page.waitForFunction(() => window.__personalNote?.state?.activeNoteId, null, { timeout: 60000 })
      await page.click('#share-button')
      await page.click('#top-properties')
      await page.waitForTimeout(500) // the panel slides in
      await page.locator('#ai-provider').waitFor()
    }
    const status = page.locator('#ai-status')
    await open()

    if (label === 'phone') check(`[${label}] before anything is saved the choice is Claude Code, with Sonnet, and the section says whether Claude Code is installed`,
      (await page.inputValue('#ai-provider')) === 'claude-code' && (await page.inputValue('#ai-claude-model')) === 'sonnet' && /Claude Code (is installed here|was not found)/.test(await page.locator('#ai-claude-note').textContent()))
    if (label === 'phone') check(`[${label}] no key field for Claude Code`, await page.locator('#ai-key').isHidden())
    await shot('claude')

    // Azure: fill it in by keyboard and mouse, save
    await page.selectOption('#ai-provider', 'azure')
    check(`[${label}] Azure shows endpoint, deployment, API version (default 2024-10-21) and the key field`,
      (await page.inputValue('#ai-api-version')) === '2024-10-21' && await page.locator('#ai-endpoint').isVisible() && await page.locator('#ai-key').isVisible() && await page.locator('#ai-base-url').isHidden())
    await page.fill('#ai-endpoint', `http://127.0.0.1:${MODEL_PORT}`)
    await page.fill('#ai-deployment', 'gpt-4o')
    await page.fill('#ai-key', GOOD_KEY)
    if (label === 'phone') {
      const heights = await page.evaluate(() => [...document.querySelectorAll('#ai-settings button, #ai-settings select, #ai-settings input')].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height)))
      check('[phone] every visible button, select and field in the section is at least 44px tall', heights.length === 7 && heights.every((h) => h >= 44), JSON.stringify(heights))
      const box = await page.locator('#ai-save').boundingBox()
      check('[phone] the buttons sit inside the panel', box.x >= 0 && box.x + box.width <= viewport.width)
    }
    await page.focus('#ai-save')
    await page.keyboard.press('Enter') // by keyboard
    await status.filter({ hasText: 'Saved.' }).waitFor({ timeout: 10000 })
    check(`[${label}] Save by keyboard says Saved., the key field is replaced by "Key saved" and the typed key is gone from the field`,
      await page.locator('#ai-key-saved').isVisible() && await page.locator('#ai-key').isHidden() && (await page.inputValue('#ai-key')) === '')
    await shot('saved')

    await open()
    const where = await page.evaluate(() => ({ html: document.documentElement.outerHTML, values: [...document.querySelectorAll('input')].map((i) => i.value).join('|'), storage: JSON.stringify([localStorage, sessionStorage]) }))
    check(`[${label}] after a reload the choice is still Azure with the same endpoint and deployment, and "Key saved · Replace · Remove" shows`,
      (await page.inputValue('#ai-provider')) === 'azure' && (await page.inputValue('#ai-endpoint')) === `http://127.0.0.1:${MODEL_PORT}` && (await page.inputValue('#ai-deployment')) === 'gpt-4o'
      && await page.locator('#ai-key-saved').isVisible() && await page.locator('#ai-replace-key').isVisible() && await page.locator('#ai-remove-key').isVisible())
    check(`[${label}] the key is nowhere in the page (markup, field values, storage)`, ![where.html, where.values, where.storage].some((text) => text.includes(GOOD_KEY)))

    asked.length = 0
    await page.click('#ai-test')
    await status.filter({ hasText: /^Answered in/ }).waitFor({ timeout: 20000 })
    check(`[${label}] Test shows "Answered in N.N s" and the model service got one call to the Azure deployment path with the saved key`,
      /^Answered in \d+\.\d s$/.test(await status.textContent()) && asked.length === 1 && asked[0].url === '/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21' && asked[0].key === GOOD_KEY, JSON.stringify(asked))
    await shot('answered')

    // a wrong key shows the model service's refusal in place
    await page.click('#ai-replace-key')
    check(`[${label}] Replace brings the key field back and puts focus in it`, await page.locator('#ai-key').isVisible() && await page.evaluate(() => document.activeElement.id) === 'ai-key')
    await page.fill('#ai-key', WRONG_KEY)
    await page.click('#ai-test')
    await status.filter({ hasText: /refused the request/ }).waitFor({ timeout: 20000 })
    check(`[${label}] a wrong key shows the plain error in place`, (await status.textContent()) === 'The model service refused the request (HTTP 401).' && await status.evaluate((e) => e.classList.contains('error')), await status.textContent())
    await shot('error')

    // a new address does not inherit the saved key
    await page.click('#ai-replace-key')
    await page.fill('#ai-key', GOOD_KEY)
    await page.click('#ai-save')
    await status.filter({ hasText: 'Saved.' }).waitFor({ timeout: 10000 })
    asked.length = 0
    await page.fill('#ai-endpoint', `http://localhost:${MODEL_PORT}`)
    await page.click('#ai-test')
    await status.filter({ hasText: /Key removed because the address changed/ }).waitFor({ timeout: 10000 })
    check(`[${label}] changing the address drops the saved key, says so, shows the key field again and sends nothing`, await page.locator('#ai-key').isVisible() && await page.locator('#ai-key-saved').isHidden() && asked.length === 0 && !fs.existsSync(path.join(aiDir, 'api-key.secret')))
    await page.fill('#ai-key', GOOD_KEY)
    await page.click('#ai-save')
    await status.filter({ hasText: 'Saved.' }).waitFor({ timeout: 10000 })

    // remove the key
    await page.click('#ai-remove-key')
    await status.filter({ hasText: 'Key removed.' }).waitFor({ timeout: 10000 })
    check(`[${label}] Remove key brings the key field back and nothing is kept`, await page.locator('#ai-key').isVisible() && await page.locator('#ai-key-saved').isHidden() && !fs.existsSync(path.join(aiDir, 'api-key.secret')))
    await page.click('#ai-test')
    await status.filter({ hasText: /No API key/ }).waitFor({ timeout: 20000 })
    check(`[${label}] Test without a key says so`, /^No API key: add one in Settings/.test(await status.textContent()))

    // a bad address is refused with a plain message
    await page.fill('#ai-endpoint', 'http://example.com')
    await page.click('#ai-save')
    await status.filter({ hasText: /must start with https/ }).waitFor({ timeout: 10000 })
    check(`[${label}] a plain-http address that is not this computer is refused in place`, /Azure endpoint must start with https/.test(await status.textContent()))

    if (label === 'desktop') {
      await page.selectOption('#ai-provider', 'openai')
      check('[desktop] OpenAI-compatible shows base URL and model, not the Azure fields', await page.locator('#ai-base-url').isVisible() && await page.locator('#ai-model').isVisible() && await page.locator('#ai-endpoint').isHidden())
      for (const skin of ['crayon', 'paper', 'night']) {
        await page.evaluate((name) => document.documentElement.setAttribute('data-skin', name), skin)
        await shot(`skin-${skin}`)
      }
      if (process.env.PN_REAL_CLAUDE === '1') {
        await page.selectOption('#ai-provider', 'azure')
        await page.fill('#ai-endpoint', '')
        await page.selectOption('#ai-provider', 'claude-code')
        await page.click('#ai-test')
        await status.filter({ hasText: /^(Answered in|Claude Code|The model|No API)/ }).waitFor({ timeout: 60000 })
        console.log(`INFO  real Claude Code test: ${await status.textContent()}`)
      }
    }
    await page.context().close()
  }

  // where the key lives: only the keychain file; not the settings file, the database, or the AI folder's other files
  const secrets = fs.readdirSync(aiDir)
  const settingsText = fs.readFileSync(path.join(aiDir, 'ai-settings.json'), 'utf8')
  check('the settings file holds the choices and not the key', settingsText.includes('"provider"') && !settingsText.includes(GOOD_KEY) && !settingsText.includes(WRONG_KEY), settingsText)
  const database = fs.readFileSync(path.join(scratch, 'verify.db'))
  check('the notes database holds neither key', !database.includes(GOOD_KEY) && !database.includes(WRONG_KEY))
  check('no key left behind after Remove (only the settings file remains in the AI folder)', JSON.stringify(secrets) === JSON.stringify(['ai-settings.json']), JSON.stringify(secrets))
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser?.close()
  await server.close()
  api.kill()
  model.close()
  fs.rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter((ok) => !ok).length
console.log(failed ? `\n${failed} FAILED` : `\nAll ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
