// Settings as a window of its own (F-102). Everything here arrives with the lazy settings chunk (F-097): the window frame and the dim are in the
// first load's CSS, so Settings opens at once with its title, and this fills it in when the code is there. It does not own any setting: the
// sections the shell, the AI/X/Plugins panels and the plugins draw are moved into pages (same elements, same ids, same wiring), the look comes
// from settings-window.css, and a few controls get a friendlier face (a segmented control over the AI <select>, skin cards, switches).
import css from './settings-window.css?inline'
import { SECTIONS, filterSections, sectionValues } from './settings-model.js'

// Four Lucide icons the app's own set does not carry, as Lucide's own node lists (importing 'lucide' here would split it into a first-load chunk of its own).
const EXTRA_ICONS = {
  ChevronLeft: [['path', { d: 'm15 18-6-6 6-6' }]],
  Cloud: [['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }]],
  Plug: [['path', { d: 'M12 22v-5' }], ['path', { d: 'M15 8V2' }], ['path', { d: 'M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z' }], ['path', { d: 'M9 8V2' }]],
  Terminal: [['path', { d: 'M12 19h8' }], ['path', { d: 'm4 17 6-6-6-6' }]],
}
// What each skin looks like, for its card (the active skin's own tokens cannot paint the other two): desk, page, ink, as in skins.css.
const SKIN_ART = { crayon: ['#f2f2f7', '#ffffff', '#111114'], paper: ['#e9e4da', '#fffdf8', '#1f1b16'], night: ['#0d1015', '#161b23', '#eceff4'] }
const AI_FACES = { 'claude-code': ['terminal', 'Claude Code'], azure: ['cloud', 'Azure OpenAI'], openai: ['globe', 'OpenAI-compatible'] }
const AI_SHORT = { 'claude-code': 'Claude Code', azure: 'Azure', openai: 'OpenAI' }
const ROWS = '.settings-section > :not(.settings-section-label):not(#settings-plugins-rows):not([hidden]), #settings-plugins-rows > *, .sw-skins > *'

function el(tag, className, html) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html !== undefined) node.innerHTML = html
  return node
}

/**
 * `host`: { icons (the app's Lucide set), createIcons(options) (draws them), skins: { list, current(), select(id) }, defaults() → { fontFamily, fontSize }, plugins (the registry),
 * close(), openNoteProps() }. Returns { select(id), sync(), refreshValues() }.
 */
export function mountSettingsWindow(panel, host) {
  if (!document.querySelector('style[data-settings-window]')) {
    const style = el('style', '', `@media screen {${css}}`)
    style.dataset.settingsWindow = ''
    document.head.append(style)
  }
  const icons = () => host.createIcons({ icons: { ...host.icons, ...EXTRA_ICONS }, root: panel })
  const heading = panel.querySelector('.properties-heading')
  const stray = [...panel.querySelectorAll(':scope > .settings-section')]

  const root = el('div', 'sw')
  root.dataset.view = 'list'
  const nav = el('nav', 'sw-nav')
  nav.setAttribute('aria-label', 'Settings sections')
  const search = el('label', 'sw-search', '<i data-lucide="search"></i><input type="search" id="settings-search" placeholder="Search settings" aria-label="Search settings" autocomplete="off" spellcheck="false" />')
  const groups = el('div', 'sw-groups')
  const pane = el('div', 'sw-pane')
  const head = el('header', 'sw-head', '<button type="button" class="sw-back" aria-label="Back to Settings"><i data-lucide="chevron-left"></i><span>Settings</span></button><div class="sw-head-text"><h3 class="sw-title"></h3><p class="sw-blurb"></p></div><button type="button" class="sw-close" aria-label="Close settings"><i data-lucide="x"></i></button>')
  const body = el('div', 'sw-body')
  const none = el('p', 'sw-none')
  none.hidden = true
  pane.append(head, body, none)
  nav.append(heading, search, groups)
  root.append(nav, pane)
  panel.append(el('div', 'sw-grab'), root)

  // pages
  const pages = {}
  const items = {}
  for (const section of SECTIONS) {
    const page = el('section', 'sw-page')
    page.dataset.swPage = section.id
    page.hidden = true
    page.append(el('h4', 'sw-page-title', section.title))
    body.append(page)
    pages[section.id] = page
    if (!groups.children[section.group]) groups.append(el('div', 'sw-group'))
    const item = el('button', 'sw-item', `<span class="sw-tile"><i data-lucide="${section.icon}"></i></span><span class="sw-label">${section.title}</span><small class="sw-val"></small><i data-lucide="chevron-right" class="sw-chev"></i>`)
    item.type = 'button'
    item.dataset.swItem = section.id
    groups.children[section.group].append(item)
    items[section.id] = item
  }
  // the sections the shell drew, into the page they belong to ("advanced" holds two)
  for (const section of stray) pages[section.dataset.sw]?.append(section)
  pages.voice.append(el('p', 'sw-off', 'Voice is off. Switch it on in Plugins.'))
  pages.meaning.append(el('p', 'sw-off', 'Search by meaning is off. Switch it on in Plugins.'))

  // Appearance: the three skins as cards
  const cards = el('div', 'sw-skins')
  cards.setAttribute('role', 'radiogroup')
  cards.setAttribute('aria-label', 'Skin')
  for (const skin of host.skins.list) {
    const [desk, page, ink] = SKIN_ART[skin.id]
    const card = el('button', 'sw-skin', `<span class="sw-skin-art" style="--d:${desk};--p:${page};--i:${ink}"><i></i><i></i></span><b>${skin.name}</b><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`)
    card.type = 'button'
    card.dataset.skin = skin.id
    card.setAttribute('role', 'radio')
    card.addEventListener('click', () => { host.skins.select(skin.id); syncSkins(); refreshValues() })
    cards.append(card)
  }
  pages.appearance.append(cards)
  const syncSkins = () => cards.querySelectorAll('.sw-skin').forEach((card) => card.setAttribute('aria-checked', String(card.dataset.skin === host.skins.current())))
  syncSkins()

  // Locked notes: there is no setting to change, so the page says what happens and where to make a note secure
  const locked = el('section', 'settings-section', `
    <div class="setting-row"><span><i data-lucide="lock"></i><span class="row-text"><b>Locks itself</b><small>When you open another note, when the app starts, and when the Mac sleeps or its screen locks.</small></span></span></div>
    <div class="setting-row"><span><i data-lucide="search"></i><span class="row-text"><b>Search sees titles only</b><small>The words of a secure note are never searched.</small></span></span></div>
    <div class="portability-actions"><button type="button" id="settings-make-secure"><i data-lucide="lock"></i><span>Make the open note secure…</span></button></div>`)
  locked.querySelector('#settings-make-secure').addEventListener('click', () => host.openNoteProps())
  pages.locked.append(locked)

  // a section's own label would repeat the page title (CSS hides it); the other labels (Performance, Built-in modules…) head their card
  for (const label of panel.querySelectorAll('.settings-section-label')) {
    const section = label.closest('.settings-section')
    const title = SECTIONS.find((entry) => entry.id === section.closest('.sw-page')?.dataset.swPage)?.title
    if (label.textContent.trim().toLowerCase() !== title?.toLowerCase()) section.before(label)
  }
  // Advanced is a card, not a folded group
  for (const details of panel.querySelectorAll('.settings-advanced')) { details.querySelector('summary')?.remove(); details.replaceWith(...details.childNodes) }

  // navigation
  let current = 'appearance'
  const phone = matchMedia('(max-width: 640px)')
  function select(id, drill = false) {
    current = id
    const section = SECTIONS.find((entry) => entry.id === id)
    head.querySelector('.sw-title').textContent = section.title
    head.querySelector('.sw-blurb').textContent = section.blurb
    for (const [key, page] of Object.entries(pages)) page.hidden = key !== id
    for (const [key, item] of Object.entries(items)) { if (key === id) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current') }
    if (drill) root.dataset.view = 'section'
    if (drill && phone.matches) body.scrollTop = 0
  }
  function showList() { root.dataset.view = 'list'; refreshValues() }
  groups.addEventListener('click', (event) => { const item = event.target.closest('.sw-item'); if (item) select(item.dataset.swItem, true) })
  groups.addEventListener('keydown', (event) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (!step) return
    const all = [...groups.querySelectorAll('.sw-item:not([hidden])')]
    event.preventDefault()
    all[(all.indexOf(document.activeElement) + step + all.length) % all.length]?.focus()
  })
  head.querySelector('.sw-back').addEventListener('click', () => { searchBox.value = ''; filter(); showList() })
  head.querySelector('.sw-close').addEventListener('click', () => host.close())
  panel.addEventListener('settings-show', (event) => { searchBox.value = ''; filter(); select(event.detail, true) })

  // search: sections and rows
  const searchBox = search.querySelector('input')
  function filter() {
    const query = searchBox.value.trim()
    root.toggleAttribute('data-searching', Boolean(query))
    const rows = Object.fromEntries(SECTIONS.map(({ id }) => [id, [...pages[id].querySelectorAll(ROWS)].map((row) => `${row.textContent} ${[...row.querySelectorAll('select')].map((select) => select.textContent).join(' ')}`)]))
    const kept = new Map(filterSections(query, rows).map((entry) => [entry.id, new Set(entry.rows)]))
    for (const { id } of SECTIONS) {
      const keep = kept.get(id)
      items[id].hidden = Boolean(query) && !keep
      pages[id].hidden = query ? !keep : id !== current
      const rowNodes = [...pages[id].querySelectorAll(ROWS)]
      rowNodes.forEach((row, index) => row.classList.toggle('sw-miss', Boolean(query) && !keep?.has(index)))
      for (const card of pages[id].querySelectorAll('.settings-section')) { // a card with no row left goes, and the heading above it
        const hit = !query || rowNodes.some((row) => card.contains(row) && !row.classList.contains('sw-miss'))
        card.classList.toggle('sw-miss', !hit)
        if (card.previousElementSibling?.matches('.settings-section-label')) card.previousElementSibling.classList.toggle('sw-miss', !hit)
      }
    }
    none.hidden = !query || kept.size > 0
    none.textContent = `Nothing matches “${query}”`
    if (!query) select(current)
  }
  searchBox.addEventListener('input', filter)
  searchBox.addEventListener('keydown', (event) => { if (event.key === 'Escape' && searchBox.value) { event.stopPropagation(); searchBox.value = ''; filter() } })

  // what the phone's list shows beside each name
  function refreshValues() {
    const text = (selector) => panel.querySelector(selector)?.textContent.trim() ?? ''
    const provider = panel.querySelector('#ai-provider')?.value
    const values = sectionValues({
      skin: host.skins.current(), ...host.defaults(), provider: AI_SHORT[provider] ?? '', plugins: host.plugins.list(),
      voice: text('#voice-setup-headline'), meaning: text('#meaning-setup-headline'), x: text('#x-headline'),
    })
    for (const [id, value] of Object.entries(values)) items[id].querySelector('.sw-val').textContent = value
  }

  // swipe down on the sheet's handle (phone): follow the finger, close past 80 px or a quick flick, else spring back
  const grab = panel.querySelector('.sw-grab')
  let drag = null
  grab.addEventListener('pointerdown', (event) => { drag = { y: event.clientY, t: event.timeStamp, dy: 0 }; grab.setPointerCapture(event.pointerId); panel.style.transition = 'none' })
  grab.addEventListener('pointermove', (event) => {
    if (!drag) return
    drag.dy = Math.max(0, event.clientY - drag.y)
    panel.style.transform = `translateY(${drag.dy}px)`
  })
  const release = (event) => {
    if (!drag) return
    const { dy, t } = drag
    drag = null
    panel.style.transition = ''
    panel.style.transform = ''
    if (dy > 80 || (dy > 24 && dy / Math.max(1, event.timeStamp - t) > 0.6)) host.close()
  }
  grab.addEventListener('pointerup', release)
  grab.addEventListener('pointercancel', release)

  // opening starts a phone on its list and reads the values again
  new MutationObserver(() => { if (panel.classList.contains('open')) { searchBox.value = ''; filter(); showList(); syncAI() } }).observe(panel, { attributes: true, attributeFilter: ['class'] })

  // the AI provider as a segmented control (the <select> stays, out of sight, as the one source of the choice)
  function syncAI() {
    const select = panel.querySelector('#ai-provider')
    panel.querySelectorAll('.sw-seg button').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.value === select?.value)))
  }
  function enhanceAI() {
    const select = panel.querySelector('#ai-provider')
    if (!select || panel.querySelector('.sw-seg')) return
    const seg = el('div', 'sw-seg')
    seg.setAttribute('role', 'radiogroup')
    seg.setAttribute('aria-label', 'Model provider')
    for (const option of select.options) {
      const [icon, name] = AI_FACES[option.value] ?? ['plug', option.textContent]
      const button = el('button', '', `<i data-lucide="${icon}"></i><span>${name}</span>`)
      button.type = 'button'
      button.dataset.value = option.value
      button.setAttribute('role', 'radio')
      button.addEventListener('click', () => { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); syncAI() })
      seg.append(button)
    }
    select.closest('.setting-row').classList.add('sw-sr')
    select.tabIndex = -1
    select.setAttribute('aria-hidden', 'true')
    select.closest('.setting-row').before(seg)
    select.addEventListener('input', () => { syncAI(); refreshValues() })
    syncAI()
  }

  panel.classList.add('sw-ready')
  select('appearance')
  icons()
  return { select, icons, refresh() { enhanceAI(); icons(); refreshValues() }, syncAI, refreshValues }
}
