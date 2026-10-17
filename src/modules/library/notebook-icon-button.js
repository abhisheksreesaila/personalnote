// The notebook icon in the notes panel (F-089): main.js draws the button with iconButtonHtml; a click opens the picker (notebook-icon-picker.js,
// fetched the first time it is wanted, not in the first load).
import '../../notebook-icon.css'
import { iconOf } from './notebook-icon.js'

export const X_LOGO = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

/** The inside of an icon: a Lucide icon (drawn by createIcons), the X logo, an emoji, or the first letter on the notebook colour. */
export function glyphHtml(notebook) {
  const { kind, value } = iconOf(notebook)
  if (kind === 'lucide') return `<i data-lucide="${value}"></i>`
  if (kind === 'brand') return X_LOGO
  return `<span class="${kind === 'emoji' ? 'nbi-e' : 'nbi-l'}">${escapeHtml(value)}</span>`
}

/** The button in a notebook's row (the row's name sits beside it); click opens the picker. */
export function iconButtonHtml(notebook) {
  const label = `Icon and colour of ${escapeHtml(notebook.name)}`
  return `<button class="nbi" type="button" style="--notebook-color:${notebook.color}" data-icon-notebook="${notebook.id}" title="${label}" aria-label="${label}" aria-haspopup="dialog">${glyphHtml(notebook)}</button>`
}
