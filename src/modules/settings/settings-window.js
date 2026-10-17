// Settings as a window of its own (F-102), in the lazy settings chunk (F-097). It owns no setting: the sections the shell, the AI/X/Plugins panels and
// the plugins draw are moved, as they are, into pages; settings-window.css gives them the look (cards, switches, segments). The frame and the dim are
// in the first load's CSS, so Settings opens at once with its title and this fills it in.
import css from './settings-window.css?inline'
import { SECTIONS, filterSections, sectionValues } from './settings-model.js'

const AI = { 'claude-code': ['code', 'Claude Code', 'Claude Code'], azure: ['globe', 'Azure OpenAI', 'Azure'], openai: ['link', 'OpenAI-compatible', 'OpenAI'] }
const ROWS = '.settings-section > :not(.settings-section-label):not(#settings-plugins-rows):not([hidden]), #settings-plugins-rows > *, .sw-skins > *'
const html = (tag, className, inner = '') => Object.assign(document.createElement(tag), { className, innerHTML: inner })

/** `host`: { createIcons(options), skins: { list, current(), select(id) }, defaults() -> { fontFamily, fontSize }, plugins (the registry), close(), openNoteProps() } */
export function mountSettingsWindow(panel, host) {
  document.head.append(Object.assign(document.createElement('style'), { textContent: `@media screen{${css}}` }))
  const heading = panel.querySelector('.properties-heading')
  const stray = [...panel.querySelectorAll(':scope > .settings-section')]
  const $ = (selector) => panel.querySelector(selector)
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
    const page = pages[id] = html('section', 'sw-page', `<h4 class="sw-page-title">${title}</h4>`)
    page.dataset.swPage = id
    page.hidden = true
    body.append(page)
    groups.children[group] ?? groups.append(html('div', 'sw-group'))
    const item = items[id] = html('button', 'sw-item', `<span class="sw-tile"><i data-lucide="${icon}"></i></span><span>${title}</span><small></small><i data-lucide="chevron-right"></i>`)
    item.type = 'button'
    item.dataset.swItem = id
    groups.children[group].append(item)
  }
  for (const section of stray) pages[section.dataset.sw]?.append(section)
  pages.voice.append(html('p', 'sw-off', 'Voice is off. Switch it on in Plugins.'))
  pages.meaning.append(html('p', 'sw-off', 'Search by meaning is off. Switch it on in Plugins.'))

  // Appearance: each skin drawn with its own tokens (.pv-<id> in skins.css), so there is one source of colour
  const cards = html('div', 'sw-skins', host.skins.list.map(({ id, name }) => `<button type="button" role="radio" class="sw-skin" data-skin-id="${id}"><span class="sw-art pv-${id}"><i></i><i></i></span><b>${name}</b><i data-lucide="check"></i></button>`).join(''))
  cards.setAttribute('role', 'radiogroup')
  cards.ariaLabel = 'Skin'
  const syncSkins = () => cards.childNodes.forEach((card) => card.setAttribute('aria-checked', String(card.dataset.skinId === host.skins.current())))
  cards.addEventListener('click', (event) => { const card = event.target.closest('.sw-skin'); if (card) { host.skins.select(card.dataset.skinId); syncSkins(); values() } })
  syncSkins()
  pages.appearance.append(cards)

  // Locked notes has nothing to set: it says what locks a note and leads to Make secure
  const locked = html('section', 'settings-section', '<div class="setting-row"><span><i data-lucide="lock"></i><span class="row-text"><b>Locks itself</b><small>When you open another note, when the app starts, and when the Mac sleeps or its screen locks. Search sees titles only.</small></span></span></div><div class="portability-actions"><button type="button"><i data-lucide="lock"></i><span>Make the open note secure…</span></button></div>')
  locked.querySelector('button').addEventListener('click', () => host.openNoteProps())
  pages.locked.append(locked)

  // a section's label would repeat its page's title (CSS hides it); the others (Performance, Built-in modules…) head their card
  for (const label of panel.querySelectorAll('.settings-section-label')) {
    const title = SECTIONS.find(({ id }) => id === label.closest('.sw-page')?.dataset.swPage)?.title
    if (label.textContent !== title) label.closest('.settings-section').before(label)
  }
  for (const details of panel.querySelectorAll('.settings-advanced')) { details.querySelector('summary').remove(); details.replaceWith(...details.childNodes) }

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
    const button = event.target.closest('button')
    if (button?.className === 'sw-close') host.close()
    else if (button) { box.value = ''; filter(); root.dataset.view = 'list'; values() }
  })
  // asked for right after Settings opened: the opening resets a phone to its list in a microtask of its own, so this goes after it
  panel.addEventListener('settings-show', (event) => Promise.resolve().then(() => { box.value = ''; filter(); select(event.detail, true) }))

  // keys: arrows in the list; Tab stays inside the window
  const focusable = () => [...panel.querySelectorAll('button, input, select, a[href]')].filter((node) => node.getClientRects().length && !node.disabled && node.tabIndex >= 0)
  panel.addEventListener('keydown', (event) => {
    const list = focusable()
    const at = list.indexOf(document.activeElement)
    if (event.key === 'Tab') {
      const edge = list[event.shiftKey ? 0 : list.length - 1]
      if (at < 0 || list[at] === edge) { event.preventDefault(); list[event.shiftKey ? list.length - 1 : 0].focus() }
    } else if (event.target.closest('.sw-groups') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const all = [...groups.querySelectorAll('.sw-item:not([hidden])')]
      all[(all.indexOf(event.target) + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length].focus()
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
      texts[id] = nodes[id].map((row) => row.textContent + [...row.querySelectorAll('select')].map((select) => select.textContent))
    }
    const kept = new Map(filterSections(query, texts).map(({ id, rows }) => [id, new Set(rows)]))
    for (const { id } of SECTIONS) {
      const keep = kept.get(id)
      items[id].hidden = Boolean(query) && !keep
      pages[id].hidden = query ? !keep : id !== current
      nodes[id].forEach((row, index) => row.classList.toggle('sw-miss', Boolean(query) && !keep?.has(index)))
      for (const card of pages[id].querySelectorAll('.settings-section')) { // a card with no row left goes, and the heading above it
        const hit = !query || nodes[id].some((row) => card.contains(row) && !row.classList.contains('sw-miss'))
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
      skin: host.skins.current(), ...host.defaults(), provider: AI[$('#ai-provider')?.value]?.[2] ?? '', plugins: host.plugins.list(),
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
    panel.querySelectorAll('.sw-seg button').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.value === value)))
  }
  function enhanceAI() {
    const select = $('#ai-provider')
    if (!select || $('.sw-seg')) return
    const seg = html('div', 'sw-seg', [...select.options].map(({ value }) => `<button type="button" role="radio" data-value="${value}"><i data-lucide="${AI[value][0]}"></i><span>${AI[value][1]}</span></button>`).join(''))
    seg.setAttribute('role', 'radiogroup')
    seg.ariaLabel = 'Model provider'
    seg.addEventListener('click', (event) => { const button = event.target.closest('button'); if (button) { select.value = button.dataset.value; select.dispatchEvent(new Event('change', { bubbles: true })); syncAI() } })
    select.closest('.setting-row').classList.add('sw-sr')
    select.tabIndex = -1
    select.ariaHidden = 'true'
    select.closest('.setting-row').before(seg)
    select.addEventListener('input', () => { syncAI(); values() })
    syncAI()
  }

  // opening starts a phone on its list and reads the values again
  new MutationObserver(() => { if (panel.classList.contains('open')) { box.value = ''; filter(); root.dataset.view = 'list'; values(); syncAI() } }).observe(panel, { attributes: true, attributeFilter: ['class'] })
  panel.classList.add('sw-ready')
  select('appearance')
  host.createIcons({ root: panel })
  return { refresh() { enhanceAI(); host.createIcons({ root: panel }); values() } }
}
