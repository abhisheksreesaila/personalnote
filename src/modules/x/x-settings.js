// Settings → X bookmarks (F-088). The server owns the sign-in and the hourly sync (x_sync.py); this module reads its
// status, turns it into words, and sends the four actions. It builds its own section, so main.js only mounts it.

const APP_HEADER = { 'X-Personal-Note': '1' } // a custom header cannot be sent cross-site without a preflight the server never answers

export function createXClient(request) {
  const post = (path, body) => request(path, { method: 'POST', headers: APP_HEADER, ...(body ? { body: JSON.stringify(body) } : {}) })
  return {
    status: () => request('/x/status'),
    setClientId: (clientId) => post('/x/client-id', { clientId }),
    connect: () => post('/x/connect'),
    sync: () => post('/x/sync'),
    disconnect: () => request('/x', { method: 'DELETE', headers: APP_HEADER }),
  }
}

const count = (n) => `${n} ${n === 1 ? 'bookmark' : 'bookmarks'}`
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '')

/**
 * What Settings shows for a status: headline, detail, which buttons, and whether the client id field is shown.
 * The page never learns the client id, only that one is saved (`hasClientId`); the field starts empty and `replacing` opens it again.
 */
export function describeX(status, replacing = false) {
  if (!status) return { headline: 'Checking…', detail: '', field: false, replace: false, connect: false, sync: false, disconnect: false, busy: true }
  const problem = status.error || ''
  if (status.connecting) return { headline: 'Waiting for X…', detail: 'Finish signing in to X in your browser.', field: false, replace: false, connect: false, sync: false, disconnect: false, busy: true }
  const saved = Boolean(status.hasClientId)
  if (!status.connected) {
    const field = !saved || replacing
    return {
      headline: 'Not connected',
      detail: problem || (saved ? 'Client ID saved. Connect X to sign in.' : 'Bring your X bookmarks in as notes. Paste the client id from your X developer app (scripts/x-setup.sh shows how), then Connect X. Only your bookmarks are read, from api.x.com; nothing is posted.'),
      field, replace: saved && !field, connect: true, sync: false, disconnect: false, busy: false, error: Boolean(problem),
    }
  }
  const again = status.errorKind === 'signed_out'
  const last = status.lastSync ? `Last sync ${time(status.lastSync)}.` : 'Not synced since the app opened.'
  const field = again && (!saved || replacing)
  return {
    headline: status.syncing ? 'Syncing…' : count(status.imported),
    detail: problem || `${last} Checks again every hour while the app is open.`,
    field, replace: again && !field, connect: again, sync: !again, disconnect: true, busy: Boolean(status.syncing), error: Boolean(problem),
  }
}

export function mountXSettings(after, request, panel) {
  const client = createXClient(request)
  const section = document.createElement('section')
  section.className = 'settings-section'
  section.id = 'settings-x-section'
  section.setAttribute('aria-labelledby', 'settings-x-label')
  section.innerHTML = `
    <p class="settings-section-label" id="settings-x-label">X bookmarks</p>
    <div class="setting-row"><span>Saved posts from X</span><small id="x-headline">Checking…</small></div>
    <p class="portability-help" id="x-detail" role="status" aria-live="polite"></p>
    <div class="portability-actions">
      <input id="x-client-id" type="text" placeholder="X client id" autocomplete="off" spellcheck="false" aria-label="X client id" hidden
        style="min-height:44px;padding:0 10px;border:1px solid var(--line);border-radius:var(--radius-row);background:var(--surface-cool);color:var(--ink);font-size:16px" />
      <button id="x-replace" hidden><span>Replace client ID</span></button>
      <button id="x-connect" hidden><span>Connect X</span></button>
      <button id="x-sync" hidden><span>Sync now</span></button>
      <button id="x-disconnect" hidden><span>Disconnect</span></button>
    </div>`
  after.after(section)
  const el = (id) => section.querySelector(`#x-${id}`)
  let poll = null
  let last = null
  let replacing = false

  function render(status) {
    last = status
    const view = describeX(status, replacing)
    el('headline').textContent = view.headline
    el('detail').textContent = view.detail
    el('detail').classList.toggle('error', Boolean(view.error))
    el('client-id').hidden = !view.field
    el('replace').hidden = !view.replace
    for (const [name, shown] of [['connect', view.connect], ['sync', view.sync], ['disconnect', view.disconnect]]) {
      el(name).hidden = !shown
      el(name).disabled = view.busy
    }
    clearTimeout(poll)
    if (status?.connecting || status?.syncing) poll = setTimeout(refresh, 1200)
  }

  async function refresh() {
    try { render(await client.status()) } catch { render({ connected: false, error: 'The local server did not answer.' }) }
  }

  async function act(call) {
    try { render(await call()) } catch (error) { el('detail').textContent = error.message; el('detail').classList.add('error') }
  }

  el('connect').addEventListener('click', () => void act(async () => {
    const typed = el('client-id').value.trim()
    if (typed || !last?.hasClientId) await client.setClientId(typed)
    el('client-id').value = '' // the id stays on the server
    replacing = false
    return client.connect()
  }))
  el('replace').addEventListener('click', () => { replacing = true; render(last); el('client-id').focus() })
  el('sync').addEventListener('click', () => {
    el('headline').textContent = 'Syncing…'
    void act(() => client.sync())
  })
  el('disconnect').addEventListener('click', () => void act(() => client.disconnect()))

  void refresh()
  // Settings opening is the moment the numbers may be old: look again then.
  new MutationObserver(() => { if (panel.classList.contains('open')) void refresh() }).observe(panel, { attributes: true, attributeFilter: ['class'] })
}
