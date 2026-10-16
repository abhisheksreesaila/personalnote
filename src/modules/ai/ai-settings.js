// Settings → AI (F-093): pick the model once for every AI feature. The server (ai_settings.py) keeps the choices and the key; this module
// draws the form and turns the server's answers into words. The key goes up once, in a password field, and is never shown again:
// the page only learns `keySaved`.

const PROVIDERS = { 'claude-code': 'Claude Code on this computer', azure: 'Azure OpenAI', openai: 'OpenAI-compatible service' }
const TEST_TIMEOUT_MS = 45000 // the server gives the model 30 seconds

export function describeAI(view) {
  const provider = PROVIDERS[view?.provider] ? view.provider : 'claude-code'
  return {
    provider,
    claudeNote: view?.claudeCodeFound
      ? 'Claude Code is installed here. It uses your own sign-in; nothing else is needed.'
      : 'Claude Code was not found on this computer. Install it and sign in, or pick another service.',
  }
}

export const describeTest = (result) => (result?.ok ? `Answered in ${Number(result.seconds).toFixed(1)} s` : result?.error || 'The test did not work.')

const MARKUP = `
  <p class="settings-section-label" id="ai-label">AI</p>
  <label class="setting-row"><span>Use</span><select id="ai-provider">${Object.entries(PROVIDERS).map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label>
  <div data-provider="claude-code" hidden>
    <label class="setting-row"><span>Model</span><select id="ai-claude-model"><option value="sonnet">Sonnet (balanced)</option><option value="haiku">Haiku (fastest)</option><option value="opus">Opus (deepest)</option></select></label>
    <p class="portability-help" id="ai-claude-note"></p>
  </div>
  <div data-provider="azure" hidden>
    <label class="setting-row"><span>Endpoint</span><input id="ai-endpoint" type="url" placeholder="https://name.openai.azure.com" autocomplete="off" spellcheck="false" maxlength="300" /></label>
    <label class="setting-row"><span>Deployment</span><input id="ai-deployment" placeholder="deployment name" autocomplete="off" spellcheck="false" maxlength="100" /></label>
    <label class="setting-row"><span>API version</span><input id="ai-api-version" autocomplete="off" spellcheck="false" maxlength="100" /></label>
  </div>
  <div data-provider="openai" hidden>
    <label class="setting-row"><span>Base URL</span><input id="ai-base-url" type="url" placeholder="https://api.openai.com/v1" autocomplete="off" spellcheck="false" maxlength="300" /></label>
    <label class="setting-row"><span>Model</span><input id="ai-model" placeholder="model name" autocomplete="off" spellcheck="false" maxlength="100" /></label>
  </div>
  <div id="ai-key-area" hidden>
    <label class="setting-row" id="ai-key-row"><span>API key</span><input id="ai-key" type="password" autocomplete="off" spellcheck="false" maxlength="600" placeholder="paste the key" /></label>
    <div id="ai-key-saved" hidden>
      <div class="setting-row"><span>Key saved</span><small>in the system keychain</small></div>
      <div class="portability-actions"><button type="button" id="ai-replace-key"><span>Replace key</span></button><button type="button" id="ai-remove-key"><span>Remove key</span></button></div>
    </div>
  </div>
  <div class="portability-actions"><button type="button" id="ai-save"><span>Save</span></button><button type="button" id="ai-test"><span>Test</span></button></div>
  <p class="portability-status" id="ai-status" role="status" aria-live="polite"></p>`

export function mountAISettings(root, request) {
  root.innerHTML = MARKUP
  const $ = (id) => root.querySelector(`#ai-${id}`)
  const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error) }
  const fields = { claudeModel: 'claude-model', endpoint: 'endpoint', deployment: 'deployment', apiVersion: 'api-version', baseUrl: 'base-url', model: 'model' }
  let replacing = false
  let keySaved = false

  function layout() {
    const provider = $('provider').value
    for (const panel of root.querySelectorAll('[data-provider]')) panel.hidden = panel.dataset.provider !== provider
    $('key-area').hidden = provider === 'claude-code'
    $('key-saved').hidden = !keySaved || replacing
    $('key-row').hidden = keySaved && !replacing
  }

  function show(view) {
    const d = describeAI(view)
    $('provider').value = d.provider
    for (const [name, id] of Object.entries(fields)) if (typeof view?.[name] === 'string') $(id).value = view[name]
    $('claude-note').textContent = d.claudeNote
    keySaved = Boolean(view?.keySaved)
    layout()
  }

  const body = () => ({ provider: $('provider').value, ...Object.fromEntries(Object.entries(fields).map(([name, id]) => [name, $(id).value])), apiKey: $('key').value })

  async function run(button, work) {
    button.disabled = true
    try { await work() } catch (error) { status(error.message, true) } finally { button.disabled = false }
  }

  async function save() {
    const view = await request('/ai/settings', { method: 'POST', body: JSON.stringify(body()) })
    $('key').value = ''
    replacing = false
    show(view)
    return view
  }

  $('provider').addEventListener('change', () => { status(''); layout() })
  $('replace-key').addEventListener('click', () => { replacing = true; layout(); $('key').focus() })
  $('remove-key').addEventListener('click', () => run($('remove-key'), async () => { show(await request('/ai/key', { method: 'DELETE' })); status('Key removed.') }))
  $('save').addEventListener('click', () => run($('save'), async () => { await save(); status('Saved.') }))
  $('test').addEventListener('click', () => run($('test'), async () => {
    status('Testing…')
    await save() // what is on screen is what gets tested
    const result = await request('/ai/test', { method: 'POST', timeout: TEST_TIMEOUT_MS })
    status(describeTest(result), !result.ok)
  }))

  return { refresh: async () => { try { show(await request('/ai/settings')) } catch { status('The local server did not answer.', true) } } }
}
