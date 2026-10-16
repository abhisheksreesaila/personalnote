// The notebook icon in the notes panel and the small picker that opens from it (F-089).
// main.js owns the data: it draws the button with iconButtonHtml, and passes openIconPicker what to change and how to save it.
import '../../notebook-icon.css'
import { createIcons, icons } from '../../icons.js'
import { ICON_NAMES, NOTEBOOK_COLORS, iconOf, normalizeEmoji } from './notebook-icon.js'

const X_LOGO = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'

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

let open = null // { close } while a picker is showing

/**
 * @param {object} options
 *  notebook          { id, name, color, icon }: what is shown now
 *  getAnchor()       the notebook's icon button (looked up again on close, because the list is re-rendered when something changes)
 *  onChange(patch)   { icon } or { color }; the picker stays open after a colour so both can be chosen
 */
export function openIconPicker({ notebook, getAnchor, onChange }) {
  open?.close()
  const current = { ...notebook }
  const picker = document.createElement('div')
  picker.className = 'nbi-pop'
  picker.setAttribute('role', 'dialog')
  picker.setAttribute('aria-label', `Icon and colour of ${notebook.name}`)
  picker.innerHTML = `
    <div class="nbi-colors" role="group" aria-label="Colour">${NOTEBOOK_COLORS.map((color) => `<button type="button" data-color="${color}" style="--notebook-color:${color}" aria-label="Colour ${color}"></button>`).join('')}</div>
    <input class="nbi-in" maxlength="16" placeholder="Type or paste an emoji, then Enter" aria-label="Emoji" autocomplete="off" spellcheck="false" />
    <div class="nbi-grid" role="group" aria-label="Icons">
      ${ICON_NAMES.map((name) => `<button type="button" data-icon="lucide:${name}" aria-label="${name.replace(/-/g, ' ')}"><i data-lucide="${name}"></i></button>`).join('')}
      <button type="button" data-icon="brand:x" aria-label="X">${X_LOGO}</button>
    </div>
    <button class="nbi-auto" type="button" data-icon="">Choose for me from the name</button>`
  document.body.append(picker)
  createIcons({ icons, root: picker })

  const input = picker.querySelector('.nbi-in')
  const mark = () => {
    for (const swatch of picker.querySelectorAll('[data-color]')) swatch.setAttribute('aria-pressed', String(swatch.dataset.color.toLowerCase() === current.color.toLowerCase()))
    for (const button of picker.querySelectorAll('[data-icon]')) button.setAttribute('aria-pressed', String(button.dataset.icon === (current.icon || '')))
  }
  mark()

  const place = () => {
    const anchor = getAnchor()?.getBoundingClientRect()
    if (!anchor) return close()
    const width = picker.offsetWidth
    const height = picker.offsetHeight
    const left = Math.max(8, Math.min(anchor.left, innerWidth - width - 8))
    const below = anchor.bottom + 6
    const top = below + height <= innerHeight - 8 ? below : Math.max(8, anchor.top - height - 6)
    picker.style.left = `${left}px`
    picker.style.top = `${top}px`
  }
  place()

  function close() {
    if (open?.picker !== picker) return
    open = null
    picker.remove()
    document.removeEventListener('pointerdown', outside, true)
    removeEventListener('resize', close)
    getAnchor()?.focus()
  }
  function outside(event) {
    if (!picker.contains(event.target)) close()
  }

  const choose = (patch) => {
    Object.assign(current, patch)
    mark()
    onChange(patch)
  }
  picker.addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-color]')
    if (swatch) return choose({ color: swatch.dataset.color })
    const button = event.target.closest('[data-icon]')
    if (button) {
      choose({ icon: button.dataset.icon })
      close()
    }
  })
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'))
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const icon = normalizeEmoji(input.value)
    if (!icon) return input.setAttribute('aria-invalid', 'true')
    choose({ icon })
    close()
  })
  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    } else if (event.target.closest('.nbi-grid') && event.key.startsWith('Arrow')) {
      const cells = [...picker.querySelectorAll('.nbi-grid button')]
      const columns = getComputedStyle(picker.querySelector('.nbi-grid')).gridTemplateColumns.split(' ').length
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key]
      const next = cells[cells.indexOf(event.target.closest('button')) + step]
      if (next) next.focus()
      event.preventDefault()
    }
  })
  document.addEventListener('pointerdown', outside, true)
  addEventListener('resize', close)
  open = { picker, close }
  ;(picker.querySelector('[data-icon][aria-pressed="true"]') || picker.querySelector('[data-color]')).focus()
  return close
}
