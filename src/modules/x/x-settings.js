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

/** What Settings shows for a status: headline, detail, which buttons, and whether the client id field is shown. */
export function describeX(status) {
  if (!status) return { headline: 'Checking…', detail: '', field: false, connect: false, sync: false, disconnect: false, busy: true }
  const problem = status.error || ''
  if (status.connecting) return { headline: 'Waiting for X…', detail: 'Finish signing in to X in your browser.', field: false, connect: false, sync: false, disconnect: false, busy: true }
  if (!status.connected) {
    return {
      headline: 'Not connected',
      detail: problem || 'Bring your X bookmarks in as notes. Paste the client id from your X developer app (scripts/x-setup.sh shows how), then Connect X. Only your bookmarks are read, from api.x.com; nothing is posted.',
      field: true, connect: true, sync: false, disconnect: false, busy: false, error: Boolean(problem),
    }
  }
  const again = status.errorKind === 'signed_out'
  const last = status.lastSync ? `Last sync ${time(status.lastSync)}.` : 'Not synced since the app opened.'
  return {
    headline: status.syncing ? 'Syncing…' : count(status.imported),
    detail: problem || `${last} Checks again every hour while the app is open.`,
    field: again, connect: again, sync: !again, disconnect: true, busy: Boolean(status.syncing), error: Boolean(problem),
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
        style="min-height:38px;padding:0 10px;border:1px solid var(--line);border-radius:var(--radius-row);background:var(--surface-cool);color:var(--ink);font-size:10px" />
      <button id="x-connect" hidden><span>Connect X</span></button>
      <button id="x-sync" hidden><span>Sync now</span></button>
      <button id="x-disconnect" hidden><span>Disconnect</span></button>
    </div>`
  after.after(section)
  const el = (id) => section.querySelector(`#x-${id}`)
  let poll = null

  function render(status) {
    const view = describeX(status)
    el('headline').textContent = view.headline
    el('detail').textContent = view.detail
    el('detail').classList.toggle('error', Boolean(view.error))
    el('client-id').hidden = !view.field
    if (status && document.activeElement !== el('client-id')) el('client-id').value = status.clientId || ''
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
    await client.setClientId(el('client-id').value)
    return client.connect()
  }))
  el('sync').addEventListener('click', () => {
    el('headline').textContent = 'Syncing…'
    void act(() => client.sync())
  })
  el('disconnect').addEventListener('click', () => void act(() => client.disconnect()))

  void refresh()
  // Settings opening is the moment the numbers may be old: look again then.
  new MutationObserver(() => { if (panel.classList.contains('open')) void refresh() }).observe(panel, { attributes: true, attributeFilter: ['class'] })
}
