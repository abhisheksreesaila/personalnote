// The sidebar's behaviour (F-065..F-067): filing by drag, folding sections, naming a notebook in place.
// main.js renders the sidebar's HTML from its state; this module wires the events on that container once and works on the DOM it finds,
// so a fold or a drag never re-renders. It reads data attributes only:
//   data-note-id / data-notebook-drag="id"   draggable rows (a note, a notebook)
//   data-notebook-drop="id" (data-category)  where a note can land
//   [data-sec="id"] > [data-fold="id"]       a section and its head; categories also carry data-sec-drop on the section
//   [data-new-notebook="category"]           the section's +
// The plain-CSS side is in chrome.css (.sec, .fold, .drop-target, .lifting, .landed, .drag-ghost, .sec-box, .namer).

import { CATEGORIES } from './outline.js'

export const SPRING_OPEN_MS = 500
const LID_CLOSE_MS = 220
const BUMP_MS = 170

// A drag image that is not there, so the ghost row we draw is the only thing following the pointer.
function invisibleDragImage() {
  const image = new Image()
  image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  return image
}

/**
 * @param {HTMLElement} root     the sidebar's list container (it stays; its children are re-rendered)
 * @param {object} options
 *  isOpen(id) / setOpen(id, open)                 folded state (main.js keeps it, and remembers it on this machine)
 *  moveNote(noteId, notebookId) -> Promise<boolean>        applies at once, reports whether the server kept it
 *  moveNotebook(notebookId, category) -> Promise<boolean>  same
 *  createNotebook(category, name) -> Promise<boolean>
 *  noteNotebookId(noteId) / notebookCategory(notebookId)   what is where now
 */
export function mountShelves(root, options) {
  const shell = root.closest('.app-shell') || document.body
  const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const image = invisibleDragImage()
  let drag = null // { kind: 'note' | 'notebook', id, el }
  let ghost = null
  let target = null // the element currently ringed
  let spring = null // { id, timer }
  let naming = null // { category, value } while a notebook is being named in place

  // ---------------------------------------------------------------- fold
  function applyOpen(id) {
    const section = root.querySelector(`[data-sec="${id}"]`)
    if (!section) return
    const open = options.isOpen(id)
    section.classList.toggle('open', open)
    section.querySelector('[data-fold]')?.setAttribute('aria-expanded', String(open))
    // A folded section's rows must not be reachable by Tab or by a screen reader (the grid row collapses them visually).
    section.querySelector('.fold')?.toggleAttribute('inert', !open)
  }
  function toggle(id) {
    options.setOpen(id, !options.isOpen(id))
    applyOpen(id) // only a class: the grid-template-rows transition runs, nothing re-renders
  }

  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-new-notebook]')) return // the section's +, handled below
    const head = event.target.closest('[data-fold]')
    if (head && root.contains(head)) toggle(head.dataset.fold)
  })
  root.addEventListener('keydown', (event) => {
    if (event.target.matches?.('.namer-input')) return
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('[data-fold][role="button"]')) {
      event.preventDefault()
      toggle(event.target.dataset.fold)
    }
  })

  // ---------------------------------------------------------------- drag and drop
  function moveGhost(event) {
    if (ghost && (event.clientX || event.clientY)) {
      ghost.style.left = `${event.clientX + 12}px`
      ghost.style.top = `${event.clientY - 14}px`
    }
  }

  function targetFor(event) {
    if (!drag) return null
    const found = event.target instanceof Element ? event.target : null
    if (drag.kind === 'note') {
      const notebook = found?.closest('[data-notebook-drop]')
      return notebook && notebook.dataset.notebookDrop !== String(options.noteNotebookId(drag.id) ?? '') ? notebook : null
    }
    const section = found?.closest('[data-sec-drop]')
    return section && section.dataset.secDrop !== options.notebookCategory(drag.id) ? section : null
  }

  // The element that carries the ring: a notebook row itself, or the head of the section being dropped on.
  const ringOf = (element) => (element?.matches('[data-sec-drop]') ? element.querySelector('[data-fold]') : element)

  function isArchiveTarget(element) {
    if (!element) return false
    if (element.matches('[data-sec-drop]')) return element.dataset.secDrop === 'archive'
    return element.dataset.category === 'archive'
  }

  function setLid(open) {
    root.querySelectorAll('.sec-box').forEach((box) => box.classList.toggle('open', open))
  }

  function setTarget(next) {
    if (next === target) return
    ringOf(target)?.classList.remove('drop-target')
    target = next
    ringOf(target)?.classList.add('drop-target')
    setLid(isArchiveTarget(target))
  }

  function clearSpring() {
    clearTimeout(spring?.timer)
    spring = null
  }

  function cleanUp() {
    clearSpring()
    setTarget(null)
    drag?.el.classList.remove('lifting')
    drag = null
    ghost?.remove()
    ghost = null
  }

  root.addEventListener('dragstart', (event) => {
    const note = event.target.closest?.('[data-note-id]')
    const notebook = note ? null : event.target.closest?.('[data-notebook-drag]')
    if (!note && !notebook) return
    drag = note
      ? { kind: 'note', id: Number(note.dataset.noteId), el: note }
      : { kind: 'notebook', id: Number(notebook.dataset.notebookDrag), el: notebook.closest('.nav-row') || notebook }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(drag.id)) // some engines refuse to start a drag with no data
    try { event.dataTransfer.setDragImage(image, 0, 0) } catch {}
    ghost = (note || notebook).cloneNode(true)
    ghost.querySelectorAll('.notebook-count, .nav-edit').forEach((node) => node.remove())
    ghost.removeAttribute('data-note-id')
    ghost.removeAttribute('data-notebook-select')
    ghost.removeAttribute('data-notebook-drop')
    ghost.removeAttribute('data-notebook-drag')
    ghost.removeAttribute('draggable')
    ghost.className = 'drag-ghost'
    ghost.setAttribute('aria-hidden', 'true')
    shell.append(ghost)
    moveGhost(event)
    // The row lifts one frame later: changing the dragged element in dragstart can cancel the drag in some engines.
    requestAnimationFrame(() => drag?.el.classList.add('lifting'))
  })

  // Not every engine reports the pointer in `drag`, but all report it in `dragover`.
  document.addEventListener('drag', moveGhost)
  document.addEventListener('dragover', (event) => {
    moveGhost(event)
    // Leaving the list ends the hover. (dragleave is no use for this: it fires between a row's own children too, and some engines send it with no position.)
    if (drag && !root.contains(event.target)) { setTarget(null); clearSpring() }
  })

  // dragenter says yes to a drop target too: the ring appears the moment the pointer arrives, and engines that send dragover only now and then still see a valid target.
  const hovering = (event) => {
    if (!drag) return
    // Hovering a folded section's head springs it open after half a second.
    const head = event.target.closest?.('[data-fold]')
    if (head && !options.isOpen(head.dataset.fold)) {
      if (spring?.id !== head.dataset.fold) {
        clearSpring()
        const id = head.dataset.fold
        spring = { id, timer: setTimeout(() => { spring = null; options.setOpen(id, true); applyOpen(id) }, SPRING_OPEN_MS) }
      }
    } else if (spring && spring.id !== head?.dataset.fold) {
      clearSpring()
    }
    const found = targetFor(event)
    setTarget(found)
    if (found) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
    }
  }
  root.addEventListener('dragenter', hovering)
  root.addEventListener('dragover', hovering)

  function land(selector) {
    requestAnimationFrame(() => {
      const element = root.querySelector(selector)
      if (!element) return
      element.classList.add('landed')
      element.addEventListener('animationend', () => element.classList.remove('landed'), { once: true })
    })
  }

  function gulp() {
    if (reducedMotion()) return
    requestAnimationFrame(() => root.querySelectorAll('.sec-box').forEach((box) => {
      box.classList.add('open')
      setTimeout(() => {
        box.classList.remove('open')
        box.classList.add('gulp')
        box.addEventListener('animationend', () => box.classList.remove('gulp'), { once: true })
      }, LID_CLOSE_MS)
    }))
  }

  root.addEventListener('drop', (event) => {
    const dropped = targetFor(event)
    if (!dropped || !drag) return
    event.preventDefault()
    const moving = drag
    const intoArchive = isArchiveTarget(dropped)
    const destination = moving.kind === 'note' ? Number(dropped.dataset.notebookDrop) : dropped.dataset.secDrop
    cleanUp()
    // main.js re-renders in the first, synchronous part of the call, so the row is already in its new place when the flash is set.
    const pending = moving.kind === 'note' ? options.moveNote(moving.id, destination) : options.moveNotebook(moving.id, destination)
    land(`[data-notebook-select="${moving.kind === 'note' ? destination : moving.id}"]`)
    if (intoArchive) gulp()
    return pending
  })

  document.addEventListener('dragend', () => cleanUp())

  // ---------------------------------------------------------------- naming a notebook in place
  const namerHtml = () => `
    <div class="namer" data-namer="${naming.category}">
      <span class="notebook-dot namer-dot"></span>
      <input class="namer-input" aria-label="Notebook name" placeholder="Notebook name" maxlength="80" autocomplete="off" spellcheck="false">
    </div>
    <div class="namer-hint">Enter to keep · Esc to drop</div>`

  function stopNaming() {
    const category = naming?.category
    naming = null
    root.querySelectorAll('.namer, .namer-hint').forEach((node) => node.remove())
    return category
  }

  function showNamer() {
    root.querySelectorAll('.namer, .namer-hint').forEach((node) => node.remove())
    if (!naming) return
    const inner = root.querySelector(`[data-sec="${naming.category}"] .fold > .inner`)
    if (!inner) { naming = null; return }
    inner.querySelector('.empty-section')?.remove()
    inner.insertAdjacentHTML('beforeend', namerHtml())
    const input = inner.querySelector('.namer-input')
    input.value = naming.value
    input.focus()
  }

  async function commitNaming() {
    const input = root.querySelector('.namer-input')
    const name = input?.value.trim() || ''
    const category = stopNaming()
    if (!name || !category) return
    await options.createNotebook(category, name)
  }

  root.addEventListener('click', (event) => {
    const add = event.target.closest('[data-new-notebook]')
    if (!add || event.shiftKey) return // Shift+click is the full dialog (colour), handled by main.js
    if (!CATEGORIES.includes(add.dataset.newNotebook)) return
    event.stopPropagation()
    options.setOpen(add.dataset.newNotebook, true)
    applyOpen(add.dataset.newNotebook)
    naming = { category: add.dataset.newNotebook, value: '' }
    showNamer()
  }, true)

  root.addEventListener('input', (event) => {
    if (naming && event.target.matches('.namer-input')) naming.value = event.target.value
  })
  root.addEventListener('keydown', (event) => {
    if (!event.target.matches?.('.namer-input')) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void commitNaming()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      stopNaming()
    }
  })
  root.addEventListener('focusout', (event) => {
    if (!event.target.matches?.('.namer-input') || !naming) return
    // Esc and Enter remove the row themselves (naming is already null by then). Otherwise leaving the field keeps a name and drops an empty one.
    setTimeout(() => {
      if (!naming || document.activeElement?.matches?.('.namer-input')) return
      if (naming.value.trim()) void commitNaming()
      else stopNaming()
    }, 120)
  })

  return {
    // main.js calls this after it replaced the sidebar's HTML: put back what lives only in the DOM.
    afterRender() {
      for (const id of ['inbox', ...CATEGORIES]) applyOpen(id)
      showNamer()
    },
    applyOpen,
    bumpInbox() {
      if (reducedMotion()) return
      const badge = root.querySelector('#inbox-badge')
      if (!badge) return
      badge.classList.add('bump')
      setTimeout(() => badge.classList.remove('bump'), BUMP_MS)
    },
    isNaming: () => Boolean(naming),
  }
}
