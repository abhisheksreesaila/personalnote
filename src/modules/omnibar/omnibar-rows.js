// The omnibar's rows and preview as HTML (F-101), with no page in them. Fetched when the omnibar first opens (omnibar-view.js), never in the first load.
import { highlight, relativeTime, shortDate } from './omnibar.js'

const esc = (text) => highlight(text, [])
const TYPES = { page: 'Page', canvas: 'Canvas', mindmap: 'Mind map' }
export const isNote = (item) => item.kind === 'note' || item.kind === 'words' || item.kind === 'meaning'

const tile = (extra, tint, inner) => `<span class="nt${extra}"${tint ? ` style="--t:${tint}"` : ''}>${inner}</span>`
const LOCK = tile(' omni-lock', '', '<i data-lucide="lock"></i>')
const noteTile = (item) => (item.secure ? LOCK : tile('', `var(--sk-c${item.icon?.tint ?? 1})`, item.icon?.emoji ?? ''))
const chip = (item) => `<span class="omni-nb"><i style="background:${esc(item.notebookColor || 'var(--sk-accent)')}"></i>${esc(item.notebookName)}</span>`
const copy = (title, sub) => `<span class="omni-copy"><span class="omni-title">${title}</span>${sub === undefined ? '' : `<span class="omni-sub">${sub}</span>`}</span>`

/** `view`: { tokens, sel, now, glyph(notebook), hint } (glyph draws a notebook's icon; hint finishes "Secure note · …"). */
export function rowHtml(item, index, { tokens, sel, now, glyph, hint }) {
  const head = `id="omni-row-${index}" role="option" aria-selected="${sel}" data-omni="${index}" tabindex="-1"`
  const row = (extra, inner, data = '') => `<button class="omni-row${extra}${sel ? ' sel' : ''}" ${head}${data}>${inner}</button>`
  if (isNote(item)) {
    const sub = item.secure ? `Secure note · ${hint}` : item.excerpt ? highlight(item.excerpt, tokens) : item.kind === 'meaning' ? esc(item.notebookName) : TYPES[item.noteType] ?? '' // (the tag takes the chip's place on a meaning row, so the notebook is named here)
    const side = `<span class="omni-side">${item.kind === 'meaning' ? '<span class="omni-tag">By meaning</span>' : chip(item)}<span class="omni-when">${relativeTime(item.updatedAt, now)}</span></span>`
    return row(` search-result${item.secure ? ' is-secure' : ''}`, `${noteTile(item)}${copy(highlight(item.title, tokens), sub)}${side}`, ` data-search-note-id="${item.id}"`)
  }
  if (item.kind === 'notebook') return row('', `${tile('', esc(item.color || 'var(--sk-accent)'), glyph(item))}${copy(highlight(item.name, tokens), `Notebook · ${item.noteCount} ${item.noteCount === 1 ? 'note' : 'notes'}`)}`)
  return row('', `${tile(' omni-act', '', `<i data-lucide="${item.icon}"></i>`)}${copy(highlight(item.title, tokens))}${item.hint ? `<span class="omni-when">${item.hint}</span>` : ''}${item.keycap ? `<kbd>${item.keycap}</kbd>` : ''}`)
}

export const createRowHtml = (index, query, sel) => `<button class="omni-row${sel ? ' sel' : ''}" id="omni-row-${index}" role="option" aria-selected="${sel}" data-omni="${index}" tabindex="-1">${tile(' omni-act', '', '<i data-lucide="plus"></i>')}${copy(`New note “${esc(query)}”`)}</button>`

export const noneHtml = (query) => `<div class="omni-none"><strong>${query ? `Nothing matches “${esc(query)}”` : 'Nothing here yet'}</strong><span>Secure notes match by title only.</span></div>`

/** The pane beside the list: the selected note's emoji, title, notebook, first lines (`text`, once fetched) and type, edited, created. A secure note shows no words. */
export function previewHtml(item, { tokens, now, text }) {
  const emoji = item.secure ? '🔒' : item.icon?.emoji ?? ''
  const body = item.secure ? 'Secure note. Its words stay locked.' : highlight(text ?? '', tokens)
  return `<span class="omni-pv-e">${emoji}</span><h3>${esc(item.title)}</h3>${chip(item)}<p class="omni-pv-text">${body}</p>
    <dl><dt>Type</dt><dd>${TYPES[item.noteType] ?? ''}</dd><dt>Edited</dt><dd>${relativeTime(item.updatedAt, now)}</dd><dt>Created</dt><dd>${shortDate(item.createdAt, now)}</dd></dl>`
}
