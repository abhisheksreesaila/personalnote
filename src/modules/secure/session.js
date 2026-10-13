// Secure notes in the page (F-058): the quiet cover, the sheets, the "locks in 4:59" pill and the lock/unlock flow.
// main.js owns the note lifecycle; this module is handed what it needs (`host`) and never reaches into main's state.
//
// host = {
//   flush(): Promise<boolean>     land the open note's pending edits (true when nothing is left unsaved)
//   reload(): Promise<void>       open the active note again from the server (a locked one comes back to the cover)
//   note(id): { id, revision, secure, title }   the note's list entry
//   patchNote(id, patch)          update that entry (secure, revision)
//   renderList(): void
//   syncMenu(): void              refresh the "Make secure / Make ordinary" button
//   toast(message): void
// }
import { createQuietTimer, formatCountdown, formatRecoveryInput, passphraseProblem, recoveryGroups, unlockFailureMessage } from './secure.js'

const html = (strings, ...values) => strings.reduce((out, text, index) => out + text + (index < values.length ? values[index] : ''), '')
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

export function createSecureSession({ api, workspace, topbarActions, shell, titleInput, renderIcons, captureBridge, host, clock = () => Date.now(), setInterval: tick = (fn, ms) => setInterval(fn, ms), clearInterval: untick = (id) => clearInterval(id) }) {
  const state = { open: false, noteId: null, timer: null, quiet: null, pill: null, cover: null, edge: null, hidden: false, status: null }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

  // ---- hiding the window from screen sharing (the Mac app's bridge; nothing elsewhere) ----
  const canHide = () => typeof captureBridge() === 'function'
  async function setCapture(hidden) {
    const bridge = captureBridge()
    if (typeof bridge !== 'function') return false
    try { state.hidden = Boolean(await bridge(hidden)) && hidden } catch { state.hidden = false }
    return hidden ? state.hidden : true
  }

  async function status(force = false) {
    if (!state.status || force) state.status = await api('/secure/status')
    return state.status
  }

  // ---- sheets ----
  function sheet({ title, intro, fields = [], primary, cancel = true, extra = '', verify, wide = false }) {
    return new Promise((resolve) => {
      const back = document.createElement('div')
      back.className = 'secure-sheet-back'
      back.innerHTML = html`<form class="secure-sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="secure-sheet-title" novalidate>
        <h3 id="secure-sheet-title">${escapeHtml(title)}</h3>
        ${intro ? `<p>${escapeHtml(intro)}</p>` : ''}
        ${fields.map((field) => `<label class="secure-field"><span>${escapeHtml(field.label)}</span><input name="${field.name}" type="${field.type || 'password'}" autocomplete="${field.autocomplete || 'off'}" ${field.mono ? 'class="mono" spellcheck="false" autocapitalize="characters"' : ''} placeholder="${escapeHtml(field.placeholder || '')}" /></label>`).join('')}
        ${extra}
        <p class="secure-sheet-error" role="alert" hidden></p>
        <div class="secure-sheet-actions">${cancel ? '<button type="button" class="secure-btn" data-cancel>Cancel</button>' : ''}<button type="submit" class="secure-btn primary">${escapeHtml(primary)}</button></div>
      </form>`
      const form = back.querySelector('form')
      const error = back.querySelector('.secure-sheet-error')
      const close = (value) => { back.remove(); resolve(value) }
      form.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Escape' && cancel) close(null) })
      back.querySelector('[data-cancel]')?.addEventListener('click', () => close(null))
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        const values = Object.fromEntries(fields.map((field) => [field.name, form.elements[field.name].value]))
        const message = verify ? await verify(values) : null
        if (message) { error.textContent = message; error.hidden = false; return }
        close(values)
      })
      for (const field of fields.filter((item) => item.mono)) {
        const input = form.elements[field.name]
        input.addEventListener('input', () => { input.value = formatRecoveryInput(input.value) })
      }
      document.body.append(back)
      if (fields.length) form.elements[fields[0].name].focus()
      else form.querySelector('.primary').focus()
    })
  }

  const askPassphrase = ({ verify } = {}) => sheet({
    title: 'Passphrase for secure notes', intro: 'Type the passphrase you chose for secure notes on this computer.',
    fields: [{ name: 'passphrase', label: 'Passphrase', autocomplete: 'current-password' }], primary: 'Open', verify,
  }).then((values) => values?.passphrase ?? null)

  const choosePassphrase = ({ intro = 'On this computer a passphrase opens secure notes (a Mac uses Touch ID). Choose one you will remember.', title = 'Choose a passphrase' } = {}) => sheet({
    title, intro,
    fields: [{ name: 'passphrase', label: 'Passphrase', autocomplete: 'new-password' }, { name: 'again', label: 'Again', autocomplete: 'new-password' }],
    primary: 'Save passphrase', verify: (values) => passphraseProblem(values.passphrase, values.again),
  }).then((values) => values?.passphrase ?? null)

  // The one-time recovery key. Done waits for "I saved it somewhere safe"; there is no way to dismiss it otherwise.
  function showRecoveryKey(key, { backend }) {
    return new Promise((resolve) => {
      const back = document.createElement('div')
      back.className = 'secure-sheet-back'
      const intro = backend === 'touchid'
        ? 'Touch ID opens secure notes on this Mac. This key is the only other way in: on a new Mac, after a restore, or if Touch ID is reset.'
        : 'Your passphrase opens secure notes on this computer. This key is the only other way in: on a new computer, after a restore, or if you forget the passphrase.'
      back.innerHTML = html`<div class="secure-sheet wide" role="dialog" aria-modal="true" aria-labelledby="secure-key-title">
        <h3 id="secure-key-title">Your recovery key</h3>
        <p>${intro}</p>
        <div class="secure-key" data-recovery-key>${recoveryGroups(key).map((group) => `<span>${escapeHtml(group)}</span>`).join('')}</div>
        <div class="secure-warn"><i data-lucide="shield-check"></i><span>It is shown once. Without it, a lost Mac means lost secure notes. Keep it in a password manager or on paper, not in a note.</span></div>
        <div class="secure-sheet-actions">
          <label class="secure-check"><input type="checkbox" data-saved /> I saved it somewhere safe</label>
          <button type="button" class="secure-btn" data-copy>Copy</button>
          <button type="button" class="secure-btn primary" data-done disabled>Done</button>
        </div>
      </div>`
      const saved = back.querySelector('[data-saved]')
      const done = back.querySelector('[data-done]')
      const copy = back.querySelector('[data-copy]')
      saved.addEventListener('change', () => { done.disabled = !saved.checked })
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(key); copy.textContent = 'Copied' } catch { copy.textContent = 'Select it and copy' }
      })
      done.addEventListener('click', () => { if (!saved.checked) return; back.remove(); resolve() })
      back.addEventListener('keydown', (event) => event.stopPropagation(), true)
      document.body.append(back)
      renderIcons()
      saved.focus()
    })
  }

  // ---- the quiet cover ----
  function removeCover() { state.cover?.remove(); state.cover = null }

  function showCover(note, { message = '' } = {}) {
    clearOpen()
    removeCover()
    void status().then((current) => draw(current)).catch(() => draw({ backend: 'passphrase', configured: true }))
    function draw(current) {
      if (state.cover) return
      const touch = current.backend === 'touchid'
      const cover = document.createElement('div')
      cover.className = 'secure-cover'
      cover.dataset.secureCover = String(note.id)
      cover.innerHTML = html`
        <h2 class="secure-cover-title"><i data-lucide="lock"></i><span>${escapeHtml(note.title || 'Untitled note')}</span></h2>
        <div class="secure-cover-card">
          ${touch
            ? `<button type="button" class="secure-fp" data-touch aria-label="Touch to open"><i data-lucide="fingerprint"></i></button><h3>Touch to open</h3>`
            : `<h3>Open with your passphrase</h3><form class="secure-pass" data-pass-form><input type="password" name="passphrase" autocomplete="current-password" aria-label="Passphrase" placeholder="Passphrase" /><button type="submit" class="secure-btn primary">Open</button></form>`}
          <p class="secure-sub">${canHide() ? 'Secure note · hidden from screen sharing' : 'Secure note · locked'}</p>
          <p class="secure-msg" role="status" aria-live="polite">${escapeHtml(message)}</p>
          <button type="button" class="secure-link" data-use-key>Use recovery key</button>
          <form class="secure-recovery" data-key-form hidden><input class="mono" name="key" autocomplete="off" spellcheck="false" autocapitalize="characters" aria-label="Recovery key" placeholder="XXXX-XXXX-XXXX-…" /><button type="submit" class="secure-btn primary">Open</button></form>
        </div>`
      // Dropping or pasting onto the cover must not reach the empty page underneath.
      for (const type of ['dragover', 'drop', 'paste']) cover.addEventListener(type, (event) => { event.preventDefault(); event.stopPropagation() })
      workspace.append(cover)
      state.cover = cover
      renderIcons()
      const messageLine = cover.querySelector('.secure-msg')
      const say = (text) => { messageLine.textContent = text }
      const busy = (on) => cover.classList.toggle('is-busy', on)
      const attempt = async (method, value) => {
        busy(true); say('')
        try {
          const result = await post('/secure/unlock', method === 'touch' ? {} : method === 'passphrase' ? { passphrase: value } : { recoveryKey: value })
          if (method === 'recovery' && result.backend === 'passphrase' && !result.deviceWrapAdded) {
            busy(false)
            const passphrase = await choosePassphrase({ title: 'Passphrase for this computer', intro: 'The recovery key opened your secure notes. Choose a passphrase so this computer can open them next time.' })
            if (passphrase) {
              try { await post('/secure/passphrase', { passphrase }) } catch (error) { host.toast(error.message) }
            }
            busy(true)
          }
          await finishUnlock(note, say)
        } catch (error) {
          say(unlockFailureMessage(error, method))
        } finally { busy(false) }
      }
      cover.querySelector('[data-touch]')?.addEventListener('click', () => attempt('touch'))
      cover.querySelector('[data-pass-form]')?.addEventListener('submit', (event) => {
        event.preventDefault()
        const value = event.currentTarget.elements.passphrase.value
        if (value) void attempt('passphrase', value)
      })
      const keyForm = cover.querySelector('[data-key-form]')
      const keyInput = keyForm.elements.key
      keyInput.addEventListener('input', () => { keyInput.value = formatRecoveryInput(keyInput.value) })
      keyForm.addEventListener('submit', (event) => { event.preventDefault(); if (keyInput.value) void attempt('recovery', keyInput.value) })
      cover.querySelector('[data-use-key]').addEventListener('click', (event) => {
        event.currentTarget.hidden = true
        keyForm.hidden = false
        keyInput.focus()
      })
      ;(cover.querySelector('[data-touch]') ?? cover.querySelector('input'))?.focus({ preventScroll: true })
    }
  }

  // The keys are held. Hide the window from screen sharing first (the Mac), then load the words.
  async function finishUnlock(note, say = () => {}) {
    if (canHide() && !(await setCapture(true))) {
      await post('/secure/lock').catch(() => {})
      say("Couldn't keep this window out of screen sharing, so the note stays locked.")
      return
    }
    await host.reload() // the words come only after the keys are held and the window is hidden
  }

  // ---- while a secure note is open ----
  function clearOpen() {
    untick(state.timer)
    state.timer = null
    state.pill?.remove()
    state.pill = null
    state.edge?.remove()
    state.edge = null
    shell.classList.remove('secure-open')
    for (const type of ['keydown', 'pointerdown', 'wheel']) workspace.removeEventListener(type, touch, true)
    state.open = false
  }
  const touch = () => state.quiet?.touch()

  async function noteOpened(note) {
    removeCover()
    clearOpen()
    const current = await status(true).catch(() => state.status)
    state.open = true
    state.noteId = note.id
    state.quiet = createQuietTimer({ seconds: current?.idleSeconds, now: clock })
    shell.classList.add('secure-open')
    state.edge = document.createElement('div')
    state.edge.className = 'secure-edge'
    workspace.append(state.edge)
    const pill = document.createElement('div')
    pill.className = 'secure-pill'
    pill.innerHTML = html`<i data-lucide="shield-check"></i><span>${state.hidden ? 'Hidden from screen sharing' : 'Unlocked'} · locks in <b class="secure-time"></b></span><button type="button" class="secure-lock">Lock</button>`
    topbarActions.prepend(pill)
    state.pill = pill
    renderIcons()
    const time = pill.querySelector('.secure-time')
    const paint = () => { time.textContent = formatCountdown(state.quiet.remaining()) }
    paint()
    pill.querySelector('.secure-lock').addEventListener('click', () => void lockNow())
    for (const type of ['keydown', 'pointerdown', 'wheel']) workspace.addEventListener(type, touch, true)
    state.timer = tick(() => { if (state.quiet.expired()) void lockNow(); else paint() }, 1000)
  }

  // Back to the cover: lands the edits, forgets the keys on the server, lets the window be shared again, and opens the note again (locked).
  let locking = null
  function lockNow({ edits = true, force = false } = {}) {
    locking ??= (async () => {
      try {
        if (state.open && edits) await host.flush()
        await post('/secure/lock').catch(() => {})
        await setCapture(false)
        const wasOpen = state.open || force
        clearOpen()
        if (wasOpen) await host.reload()
      } finally { locking = null }
    })()
    return locking
  }

  // Leaving the note (another note opens): keys and sharing are put back at once; nothing is reloaded.
  async function leave() {
    const needsLock = state.open || state.hidden
    removeCover()
    clearOpen()
    if (needsLock) {
      await post('/secure/lock').catch(() => {})
      await setCapture(false)
    }
  }

  // ---- the note menu ----
  async function makeSecure(id) {
    const note = host.note(id)
    if (!note || note.secure) return
    if (!(await host.flush())) { host.toast('Save the note first, then make it secure.'); return }
    const current = await status(true)
    let passphrase
    try {
      if (current.backend === 'passphrase') {
        if (!current.configured) {
          passphrase = await choosePassphrase()
          if (passphrase === null) return
        } else if (!current.unlocked) {
          const entered = await askPassphrase({
            verify: async (values) => {
              try { await post('/secure/unlock', { passphrase: values.passphrase }); return null } catch (error) { return unlockFailureMessage(error, 'passphrase') }
            },
          })
          if (entered === null) return
        }
      } else if (current.configured && !current.unlocked) await post('/secure/unlock')
      const result = await post(`/notes/${id}/secure`, { revision: note.revision, passphrase })
      host.patchNote(id, { secure: true, revision: result.revision })
      host.renderList()
      state.status = null
      if (result.recoveryKey) await showRecoveryKey(result.recoveryKey, { backend: current.backend })
    } catch (error) {
      host.toast(error.message || 'Could not make the note secure')
      return
    }
    if (canHide() && !(await setCapture(true))) {
      await lockNow({ edits: false })
      host.toast("Couldn't keep this window out of screen sharing, so the note was locked.")
      return
    }
    await noteOpened(host.note(id))
    host.syncMenu()
  }

  async function makeOrdinary(id) {
    const note = host.note(id)
    if (!note?.secure) return
    if (!state.open) { state.cover?.querySelector('input, [data-touch]')?.focus(); host.toast('Open the note first, then make it ordinary.'); return }
    if (!(await host.flush())) { host.toast('Save the note first.'); return }
    try {
      const result = await api(`/notes/${id}/secure`, { method: 'DELETE' })
      host.patchNote(id, { secure: false, revision: result.revision })
    } catch (error) {
      host.toast(error.message || 'Could not take the note out of secure')
      return
    }
    await leave() // the other secure notes lock again; this one is an ordinary note now and stays on screen
    host.renderList()
    host.syncMenu()
  }

  return {
    showCover, noteOpened, leave, lockNow, makeSecure, makeOrdinary,
    isOpen: () => state.open,
    // The cover or the pill must go when an ordinary note opens.
    clear() { removeCover(); clearOpen() },
    dismissCover: removeCover,
    // The server locked behind the page's back (a save was refused with 423): show the cover, not an error.
    serverLocked() { return lockNow({ edits: false, force: true }) },
  }
}
