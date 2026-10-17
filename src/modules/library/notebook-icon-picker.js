// The small picker that opens from a notebook's icon button (F-089). Fetched the first time one is opened (F-096 took it out of the first load);
// main.js owns the data and passes openIconPicker what to change and how to save it. The button itself is notebook-icon-button.js.
import { createIcons, icons } from '../../icons.js'
import { ICON_NAMES, NOTEBOOK_COLORS, normalizeEmoji } from './notebook-icon.js'

let open = null // { close } while a picker is showing

/**
 * @param {object} options
 *  notebook          { id, name, color, icon }: what is shown now
 *  getAnchor()       the notebook's icon button (looked up again on close, because the list is re-rendered when something changes)
 *  onChange(patch)   { icon } or { color }; the picker stays open after a colour so both can be chosen
 */
export function openIconPicker({ notebook, getAnchor, onChange, xLogo }) {
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
      <button type="button" data-icon="brand:x" aria-label="X">${xLogo}</button>
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
