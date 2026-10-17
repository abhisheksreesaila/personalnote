// The omnibar's results, filter pills and preview pane drawn into the page (F-101). main.js fetches this the first time the omnibar opens, so none of it is in the
// first load; until it arrives the typed text and the word search carry on and the list fills in when it does.
// `host`: { omni (the state main.js owns), state, elements, api, actions(), skip(), glyph(notebook), hint, refreshIcons() }
import './omnibar.css'
import { FILTERS, buildGroups, filterCounts, flatten, moveSelection, queryTokens } from './omnibar.js'
import { createRowHtml, isNote, noneHtml, previewHtml, rowHtml } from './omnibar-rows.js'

const itemKey = (item) => (item ? `${item.kind === 'words' ? 'note' : item.kind}:${item.id ?? item.title}` : '') // the selection stays on the same item when more results land
const PREVIEW_DELAY = 90 // arrowing down the list asks for the first lines only of the note it rests on

export function mountOmniView(host) {
  const { omni, state, elements, api } = host
  const chips = document.querySelector('#omni-chips')
  const pane = document.querySelector('#omni-preview')
  const firstLines = new Map() // resource id + edit time -> the note's first lines
  let previewTimer = 0

  function showPreview() {
    clearTimeout(previewTimer)
    const item = omni.items[omni.sel]
    if (!item || !isNote(item)) { pane.innerHTML = ''; return }
    const key = `${item.resourceId}@${item.updatedAt}`
    const tokens = queryTokens(elements.searchInput.value)
    pane.innerHTML = previewHtml(item, { tokens, now: Date.now(), text: firstLines.get(key) })
    if (item.secure || firstLines.has(key) || !pane.offsetParent) return // (a secure note's words are never asked for; a phone has no pane)
    previewTimer = setTimeout(async () => {
      try { firstLines.set(key, (await api(`/note-links?refs=${item.resourceId}`))[item.resourceId]?.excerpt ?? '') } catch { return }
      if (omni.open && omni.items[omni.sel] === item) showPreview()
    }, PREVIEW_DELAY)
  }

  function render() {
    const keep = itemKey(omni.items[omni.sel])
    const query = elements.searchInput.value.trim()
    const tokens = queryTokens(query)
    const skip = host.skip()
    const input = {
      query, notes: state.notes.filter((note) => note.id !== skip), notebooks: omni.pick ? [] : state.notebooks, actions: omni.pick ? [] : host.actions(),
      wordHits: omni.wordHits.filter((hit) => hit.id !== skip), meaningHits: omni.meaningHits, wordsPending: omni.pending,
    }
    omni.groups = buildGroups({ ...input, filter: omni.filter })
    omni.items = flatten(omni.groups)
    const kept = omni.items.findIndex((item) => itemKey(item) === keep)
    if (kept >= 0) omni.sel = kept
    const onlyCreate = omni.items.length === 1 && omni.items[0].kind === 'create'
    const waiting = (omni.pending || omni.meaningPending) && (omni.filter === 'All' || omni.filter === 'Notes') // a search is still out: no "nothing" yet
    const counts = query && filterCounts(omni.filter === 'All' ? omni.groups : buildGroups({ ...input, filter: 'All' }))
    chips.innerHTML = FILTERS.map((name) => `<button type="button" class="omni-chip" data-omni-chip="${name}" aria-pressed="${name === omni.filter}">${name}${counts && name !== 'All' ? ` <b>${counts[name]}</b>` : ''}</button>`).join('')
    const view = { tokens, now: Date.now(), glyph: host.glyph, hint: host.hint }
    let html = ''
    let index = 0
    omni.sel = onlyCreate ? 0 : Math.min(omni.sel, Math.max(omni.items.length - 1, 0))
    // Nothing matched (and no search is still out): say so. A lone New note row follows it, so Enter always does something.
    if ((!omni.items.length || onlyCreate) && !waiting) html = noneHtml(query)
    html += omni.groups.map((group) => group.key === 'create'
      ? `<div class="omni-group">${createRowHtml(index++, group.items[0].title, omni.sel === index - 1)}</div>`
      : `<div class="omni-group" role="group" aria-label="${group.label}"><h4>${group.label}</h4>${group.items.map((item) => rowHtml(item, index++, { ...view, sel: omni.sel === index - 1 })).join('')}</div>`).join('')
    if (omni.wordsFailed && query) html += '<p class="omni-note">Couldn’t search inside notes.</p>'
    elements.searchResults.innerHTML = html
    host.refreshIcons()
    if (omni.items.length) elements.searchInput.setAttribute('aria-activedescendant', `omni-row-${omni.sel}`)
    else elements.searchInput.removeAttribute('aria-activedescendant')
    showPreview()
  }

  function select(index, { scroll = true } = {}) {
    if (!omni.items.length) return
    omni.sel = index
    elements.searchResults.querySelectorAll('.omni-row').forEach((row, i) => { row.classList.toggle('sel', i === index); row.setAttribute('aria-selected', String(i === index)) })
    elements.searchInput.setAttribute('aria-activedescendant', `omni-row-${index}`)
    if (scroll) document.querySelector(`#omni-row-${index}`)?.scrollIntoView({ block: 'nearest' })
    showPreview()
  }

  return { render, select, move: (delta) => select(moveSelection(omni.sel, delta, omni.items.length)) }
}
