// The Settings section an optional download shows (Voice, Search by meaning): headline, bar, sentence and buttons. A plugin draws it when it
// switches on and removes it when it switches off, so a plugin that is off leaves nothing in Settings. Ids are `#<name>-setup-*` and
// `#<name>-download|cancel|remove`.

const BUTTON_ICONS = { download: 'download', cancel: 'x', remove: 'trash-2' }

export function createSetupSection({ name, label, rowLabel, icon, actions }) {
  const section = document.createElement('section')
  section.className = 'settings-section'
  section.id = `settings-${name}-section`
  section.setAttribute('aria-labelledby', `settings-${name}-label`)
  section.innerHTML = `
    <p class="settings-section-label" id="settings-${name}-label">${label}</p>
    <div class="setting-row"><span><i data-lucide="${icon}"></i>${rowLabel}</span><small id="${name}-setup-headline">Checking…</small></div>
    <progress class="setup-progress" id="${name}-setup-progress" max="100" value="0" aria-label="${label} download progress" hidden></progress>
    <p class="portability-help" id="${name}-setup-detail" role="status" aria-live="polite"></p>
    <div class="portability-actions">${actions.map((action) => `<button id="${name}-${action}" hidden><i data-lucide="${BUTTON_ICONS[action]}"></i><span></span></button>`).join('')}</div>`
  return section
}

export function renderSetupRow(name, view) {
  document.querySelector(`#${name}-setup-headline`).textContent = view.headline
  document.querySelector(`#${name}-setup-detail`).textContent = view.detail
  const progress = document.querySelector(`#${name}-setup-progress`)
  progress.hidden = view.percent === null
  if (view.percent !== null) progress.value = view.percent
  for (const [action, label] of [['download', view.download], ['cancel', view.cancel], ['remove', view.remove]]) {
    const button = document.querySelector(`#${name}-${action}`)
    if (!button) continue
    button.hidden = !label
    button.querySelector('span').textContent = label || ''
  }
}

// A download that runs shows on the island too, fed by the same status the Settings row polls (no polling of its own).
export function createIslandDownload(island) {
  const downloading = {}
  return (key, name, status) => {
    if (status?.state === 'downloading') { downloading[key] = true; island.model.download(key, name, status.percent ?? 0) }
    else if (downloading[key]) { downloading[key] = false; island.model.downloadEnd(key, status?.state === 'ready') }
  }
}
