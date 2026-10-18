// Settings as a window of its own (F-102), in the lazy settings chunk (F-097). The frame, the dim and the title are in the first load, so Settings
// opens at once; this draws the sections, wires what they set, and the AI/X/Plugins panels and the plugins fill their pages (`[data-sw-page]`).
import css from './settings-window.css?inline'
import { SECTIONS, filterSections, sectionValues } from './settings-model.js'

const AI = { 'claude-code': ['code', 'Claude Code', 'Claude Code'], azure: ['globe', 'Azure OpenAI', 'Azure'], openai: ['link', 'OpenAI-compatible', 'OpenAI'] }
const ROWS = '.settings-section > :not(.settings-section-label):not(#settings-plugins-rows):not([hidden]), #settings-plugins-rows > *, .sw-skins > *'
const html = (tag, className, inner = '') => Object.assign(document.createElement(tag), { className, innerHTML: inner })
const label = (text) => `<p class="settings-section-label">${text}</p>`
const row = (icon, text, tail) => `<div class="setting-row"><span><i data-lucide="${icon}"></i>${text}</span>${tail}</div>`
const FONTS = [['Source Serif 4', 'Serif'], ['IBM Plex Sans', 'Sans serif'], ['monospace', 'Monospace']]
const RENDER = [['default', 'Hybrid (page bitmaps while navigating)'], ['classic', 'Draw every step (before)'], ['bitmaps', 'Page bitmaps always'], ['gestureTransform', 'Slide picture (preview 3)'], ['dpr1', 'Lower resolution (1x)']]
const button = (id, icon, text) => `<button id="${id}"><i data-lucide="${icon}"></i><span>${text}</span></button>`

// What each page holds that no other module draws (AI, the Plugins rows, X and the voice and search downloads come from their own modules).
const PAGES = {
  writing: `<section class="settings-section"><div class="setting-field-heading"><span>Default text</span><small>New objects</small></div>
    <div class="font-family-control" aria-label="Default font family">${FONTS.map(([id, name]) => `<button data-default-font-family="${id}" title="${name}" aria-label="${name}">Ag</button>`).join('')}</div>
    <label class="font-size-row" for="settings-font-size"><span>Size</span><output id="settings-font-size-value">24</output><input id="settings-font-size" type="range" min="12" max="72" step="1" value="24" /></label></section>`,
  ai: '<section class="settings-section" id="ai-settings"></section>',
  plugins: '<section class="settings-section" id="settings-plugins"><div id="settings-plugins-rows"></div></section>',
  voice: `${label('Built-in modules')}<section class="settings-section">${row('mic', 'Voice capture', '<small id="settings-voice">Transcript only</small>')}${row('audio-lines', 'Audio retention', '<small>None</small>')}</section><p class="sw-off">Off. Switch it on in Plugins.</p>`,
  meaning: '<p class="sw-off">Off. Switch it on in Plugins.</p>',
  locked: `<section class="settings-section">${row('lock', '<span class="row-text"><b>Locks itself</b><small>When you open another note, when the app starts, and when the Mac sleeps. Search sees titles only.</small></span>', '')}<div class="portability-actions"><button type="button" id="settings-make-secure"><i data-lucide="lock"></i><span>Make the open note secure…</span></button></div></section>`,
  advanced: `${label('Performance')}<section class="settings-section">
    <label class="setting-row" for="settings-speed-meter"><span><i data-lucide="gauge"></i>Show speed meter</span><input type="checkbox" id="settings-speed-meter" aria-keyshortcuts="Control+Shift+F" title="Ctrl/Cmd+Shift+F" /></label>
    <label class="setting-row" for="settings-render-mode"><span>Render mode</span><select id="settings-render-mode">${RENDER.map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}</select></label>
    <p class="portability-help">Changes only how the screen is drawn, never a note. "Page bitmaps always" can slow drawing and typing.</p>
    <p class="portability-help speedtest-offer">The speed test measures this computer on a generated note of 5,000+ objects, in a window of its own. Your notes are left alone.</p>
    <div class="portability-actions speedtest-offer">${button('settings-speed-test', 'gauge', 'Run speed test…')}</div></section>
    ${label('Workspace data')}<section class="settings-section">${row('hard-drive', 'Storage', '<small id="settings-storage">SQLite · This device</small>')}
    <div class="portability-actions">${button('download-backup', 'archive', 'Download backup')}${button('export-markdown', 'file-down', 'Markdown + assets')}${button('import-backup', 'folder-input', 'Import backup')}<input id="import-backup-file" type="file" accept="application/json,.json" hidden /></div>
    <p class="portability-help">Backup keeps canvas and mind-map data. Import merges copies and never replaces notes.</p>
    <p class="portability-status" id="portability-status" role="status" aria-live="polite"></p></section>`,
}

/**
 * `host`: { createIcons(options), skins: { list, current(), select(id) }, plugins (the registry), state (the shell's: fontFamily, fontSize, speedMeter,
 * renderMode), api, save(), typography(), speedMeter(on), speedTest(), renderMode(mode), exportTo(path, name), importFile(file), close(), openNoteProps() }
 */
export function mountSettingsWindow(panel, host) {
  document.head.append(Object.assign(document.createElement('style'), { textContent: `@media screen{${css}}` }))
  const heading = panel.querySelector('.properties-heading')
  const $ = (selector) => panel.querySelector(selector)
  const { state } = host
  const root = html('div', 'sw')
  root.dataset.view = 'list'
  const nav = html('nav', 'sw-nav')
  nav.ariaLabel = 'Settings sections'
  const search = html('label', 'sw-search', '<i data-lucide="search"></i><input type="search" id="settings-search" placeholder="Search settings" aria-label="Search settings" autocomplete="off" spellcheck="false" />')
  const box = search.lastChild
  const groups = html('div', 'sw-groups')
  const pane = html('div', 'sw-pane')
  const head = html('header', 'sw-head', '<button type="button" class="sw-back" aria-label="Back to Settings"><i data-lucide="arrow-left"></i><span>Settings</span></button><button type="button" class="sw-close" aria-label="Close settings"><i data-lucide="x"></i></button><div><h3 class="sw-title"></h3><p class="sw-blurb"></p></div>')
  const body = html('div', 'sw-body')
  const none = html('p', 'sw-none')
  none.hidden = true
  pane.append(head, body, none)
  nav.append(heading, search, groups)
  root.append(nav, pane)
  panel.append(html('div', 'sw-grab'), root)

  const pages = {}
  const items = {}
  for (const { id, title, icon, group } of SECTIONS) {
    const page = pages[id] = html('section', 'sw-page', `<h4 class="sw-page-title">${title}</h4>${PAGES[id] ?? ''}`)
    page.dataset.swPage = id
    page.hidden = true
    body.append(page)
    groups.children[group] ?? groups.append(html('div', 'sw-group'))
    const item = items[id] = html('button', 'sw-item', `<span><i data-lucide="${icon}"></i></span><span>${title}</span><small></small><i data-lucide="chevron-right"></i>`)
    item.type = 'button'
    item.dataset.swItem = id
    groups.children[group].append(item)
  }

  // Appearance: each skin drawn with its own tokens (.pv-<id> in skins.css), so there is one source of colour
  const cards = html('div', 'sw-skins', host.skins.list.map(({ id, name }) => `<button type="button" role="radio" class="sw-skin" data-skin-id="${id}"><span class="sw-art pv-${id}"><i></i><i></i></span><b>${name}</b><i data-lucide="check"></i></button>`).join(''))
  cards.setAttribute('role', 'radiogroup')
  cards.ariaLabel = 'Skin'
  const syncSkins = () => cards.childNodes.forEach((card) => card.setAttribute('aria-checked', String(card.dataset.skinId === host.skins.current())))
  cards.addEventListener('click', (event) => { const card = event.target.closest('.sw-skin'); if (card) { host.skins.select(card.dataset.skinId); syncSkins(); values() } })
  pages.appearance.append(cards)

  // what the shell's own settings do (the shell keeps the state; these are only their controls)
  const on = (selector, type, fn) => $(selector).addEventListener(type, fn)
  const fontButtons = panel.querySelectorAll('[data-default-font-family]')
  const sync = () => {
    fontButtons.forEach((b) => b.classList.toggle('active', b.dataset.defaultFontFamily === state.fontFamily))
    $('#settings-font-size').value = $('#settings-font-size-value').value = state.fontSize
    $('#settings-speed-meter').checked = state.speedMeter
    $('#settings-render-mode').value = state.renderMode
    syncSkins()
  }
  fontButtons.forEach((b) => b.addEventListener('click', () => { state.fontFamily = b.dataset.defaultFontFamily; host.save(); sync(); host.typography() }))
  on('#settings-font-size', 'input', (event) => { state.fontSize = Number(event.target.value); host.save(); sync(); host.typography() })
  on('#settings-speed-meter', 'change', (event) => { host.speedMeter(event.target.checked); host.save() })
  on('#settings-render-mode', 'change', (event) => host.renderMode(event.target.value))
  on('#settings-speed-test', 'click', () => host.speedTest())
  on('#download-backup', 'click', () => host.exportTo('/export/workspace', 'personal-note-backup.json'))
  on('#export-markdown', 'click', () => host.exportTo('/export/markdown', 'personal-note-markdown.zip'))
  on('#import-backup', 'click', () => $('#import-backup-file').click())
  on('#import-backup-file', 'change', async (event) => { await host.importFile(event.target.files?.[0]); event.target.value = '' })
  on('#settings-make-secure', 'click', () => host.openNoteProps())
  const capabilities = () => host.api('/settings/capabilities').then(({ storage, modules }) => [storage?.engine === 'sqlite' ? 'SQLite · This device' : 'Unavailable', modules?.voice?.available ? 'Transcript only' : 'Unavailable'], () => ['Unavailable', 'Unavailable'])
    .then(([disk, voice]) => { $('#settings-storage').textContent = disk; $('#settings-voice').textContent = voice })

  let current = 'appearance'
  function select(id, drill = false) {
    current = id
    const { title, blurb } = SECTIONS.find((section) => section.id === id)
    head.querySelector('.sw-title').textContent = title
    head.querySelector('.sw-blurb').textContent = blurb
    for (const key in pages) { pages[key].hidden = key !== id; items[key].ariaCurrent = key === id ? 'page' : null }
    if (drill) { root.dataset.view = 'section'; body.scrollTop = 0 }
  }
  groups.addEventListener('click', (event) => { const item = event.target.closest('.sw-item'); if (item) select(item.dataset.swItem, true) })
  head.addEventListener('click', (event) => {
    const b = event.target.closest('button')
    if (b?.className === 'sw-close') host.close()
    else if (b) { box.value = ''; filter(); root.dataset.view = 'list'; values() }
  })
  // asked for right after Settings opened: the opening resets a phone to its list in a microtask of its own, so this goes after it
  panel.addEventListener('settings-show', (event) => Promise.resolve().then(() => { box.value = ''; filter(); select(event.detail, true) }))

  // Tab stays inside the window
  const focusable = () => [...panel.querySelectorAll('button, input, select, a[href]')].filter((node) => node.getClientRects().length && !node.disabled && node.tabIndex >= 0)
  panel.addEventListener('keydown', (event) => {
    const list = focusable()
    const at = list.indexOf(document.activeElement)
    if (event.key === 'Tab') {
      const edge = list[event.shiftKey ? 0 : list.length - 1]
      if (at < 0 || list[at] === edge) { event.preventDefault(); list[event.shiftKey ? list.length - 1 : 0].focus() }
    }
  })

  // search: sections and rows
  function filter() {
    const query = box.value.trim()
    root.toggleAttribute('data-searching', Boolean(query))
    const nodes = {}
    const texts = {}
    for (const { id } of SECTIONS) {
      nodes[id] = [...pages[id].querySelectorAll(ROWS)]
      texts[id] = nodes[id].map((r) => r.textContent + [...r.querySelectorAll('select')].map((select) => select.textContent))
    }
    const kept = new Map(filterSections(query, texts).map(({ id, rows }) => [id, new Set(rows)]))
    for (const { id } of SECTIONS) {
      const keep = kept.get(id)
      items[id].hidden = Boolean(query) && !keep
      pages[id].hidden = query ? !keep : id !== current
      nodes[id].forEach((r, index) => r.classList.toggle('sw-miss', Boolean(query) && !keep?.has(index)))
      for (const card of pages[id].querySelectorAll('.settings-section')) { // a card with no row left goes, and the heading above it
        const hit = !query || nodes[id].some((r) => card.contains(r) && !r.classList.contains('sw-miss'))
        card.classList.toggle('sw-miss', !hit)
        card.previousElementSibling?.matches('.settings-section-label') && card.previousElementSibling.classList.toggle('sw-miss', !hit)
      }
    }
    none.hidden = !query || kept.size > 0
    none.textContent = `Nothing matches “${query}”`
    if (!query) select(current)
  }
  box.addEventListener('input', filter)
  box.addEventListener('keydown', (event) => { if (event.key === 'Escape' && box.value) { event.stopPropagation(); box.value = ''; filter() } })

  // the value beside each name on a phone's list
  function values() {
    const text = (selector) => $(selector)?.textContent.trim() ?? ''
    const done = sectionValues({
      skin: host.skins.current(), fontFamily: state.fontFamily, fontSize: state.fontSize, provider: AI[$('#ai-provider')?.value]?.[2] ?? '', plugins: host.plugins.list(),
      voice: text('#voice-setup-headline'), meaning: text('#meaning-setup-headline'), x: text('#x-headline'),
    })
    for (const id in done) items[id].querySelector('small').textContent = done[id]
  }

  // swipe down on the sheet's handle (phone): follows the finger, closes past 80 px or on a flick, else springs back
  const grab = $('.sw-grab')
  let drag = null
  grab.addEventListener('pointerdown', (event) => { drag = { y: event.clientY, t: event.timeStamp, dy: 0 }; grab.setPointerCapture(event.pointerId); panel.style.transition = 'none' })
  grab.addEventListener('pointermove', (event) => { if (drag) panel.style.transform = `translateY(${drag.dy = Math.max(0, event.clientY - drag.y)}px)` })
  const release = (event) => {
    if (!drag) return
    const { dy, t } = drag
    drag = null
    panel.style.transition = panel.style.transform = ''
    if (dy > 80 || (dy > 24 && dy / Math.max(1, event.timeStamp - t) > 0.6)) host.close()
  }
  grab.addEventListener('pointerup', release)
  grab.addEventListener('pointercancel', release)

  // the AI provider as a segmented control; the <select> stays, out of sight, as the one source of the choice
  function syncAI() {
    const value = $('#ai-provider')?.value
    panel.querySelectorAll('.sw-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === value)))
  }
  function enhanceAI() {
    const select = $('#ai-provider')
    if (!select || $('.sw-seg')) return
    const seg = html('div', 'sw-seg', [...select.options].map(({ value }) => `<button type="button" role="radio" data-value="${value}"><i data-lucide="${AI[value][0]}"></i><span>${AI[value][1]}</span></button>`).join(''))
    seg.setAttribute('role', 'radiogroup')
    seg.ariaLabel = 'Model provider'
    seg.addEventListener('click', (event) => { const b = event.target.closest('button'); if (b) { select.value = b.dataset.value; select.dispatchEvent(new Event('change', { bubbles: true })); syncAI() } })
    select.closest('.setting-row').classList.add('sw-sr')
    select.tabIndex = -1
    select.ariaHidden = 'true'
    select.closest('.setting-row').before(seg)
    select.addEventListener('input', () => { syncAI(); values() })
    syncAI()
  }

  // opening starts a phone on its list and reads everything again
  new MutationObserver(() => { if (panel.classList.contains('open')) { box.value = ''; filter(); root.dataset.view = 'list'; sync(); values(); syncAI(); void capabilities() } }).observe(panel, { attributes: true, attributeFilter: ['class'] })
  panel.classList.add('sw-ready')
  select('appearance')
  sync()
  void capabilities()
  host.createIcons({ root: panel })
  return { refresh() { enhanceAI(); host.createIcons({ root: panel }); values() } }
}
