// The dynamic island's body (F-084): puts the face the model chose on screen. One hidden measure per change of face (the new face is laid out
// once to read its size, the island's width and height follow with a CSS transition); nothing runs at rest, and a download's percent or a
// recording's level only touch text and a custom property.
import { createIcons, icons } from '../../icons.js'
import { createIslandModel } from './island-model.js'

const BARS = 9
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

function h(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const icon = (name, className) => { const node = h('i', className); node.dataset.lucide = name; return node }

/** Builds the island's moment faces (everything but the title, the card and the focus strip). */
const MOMENTS = {
  saving: () => [h('span', 'saving-spinner'), h('span', 'isl-muted', 'Saving')],
  saved: () => [icon('check', 'isl-ok'), h('span', '', 'Saved')],
  added: (f) => [icon('check'), h('span', '', `Added ${f.words} ${f.words === 1 ? 'word' : 'words'}`)],
  ready: (f) => [icon('check', 'isl-ok'), h('span', '', `${f.name} is ready`)],
  agent: (f) => [icon('sparkles'), h('span', 'isl-label', f.label)],
  download: (f) => {
    const bar = h('span', 'isl-bar'); bar.append(h('i'))
    return [icon('download'), h('span', 'isl-wide-only', f.name), bar, h('span', 'isl-muted isl-pct', `${f.percent}%`)]
  },
  error: (f) => {
    const nodes = [icon('triangle-alert', 'isl-bad'), h('span', 'isl-bad', f.title)]
    if (f.message) nodes.push(h('span', 'isl-muted isl-wide-only isl-label', f.message))
    if (f.retry) { const retry = h('button', 'isl-chip', 'Try again'); retry.dataset.islandAction = 'retry'; nodes.push(retry) }
    return nodes
  },
  recording: (f) => {
    const wave = h('span', 'isl-wave')
    for (let i = 0; i < BARS; i += 1) wave.append(h('i'))
    const stop = h('button', 'isl-chip', 'Stop'); stop.dataset.islandAction = 'stop'
    stop.setAttribute('aria-label', 'Stop recording')
    return [h('span', 'isl-rec'), wave, h('span', '', 'Listening'), h('span', 'isl-muted isl-clock', clock(Date.now() - f.startedAt)), stop]
  },
}

export function mountIsland(island, { onRetry = () => {}, onStop = () => {}, onOpen = () => {} } = {}) {
  const faceBox = (name) => island.querySelector(`:scope > [data-face="${name}"]`)
  const boxes = { rest: faceBox('rest'), card: faceBox('card'), moment: faceBox('moment'), focus: faceBox('focus') }
  let current = boxes.rest
  let clockTimer = 0
  let levels = []
  const title = island.querySelector('#island-title')

  function measure(box) {
    const { offsetWidth: w, offsetHeight: hgt } = box
    island.style.width = `${w + 2}px` // (the island's 1px border)
    island.style.height = `${hgt + 2}px`
  }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  // A short cross-fade between faces (the Web Animations API: nothing is left running once it ends).
  const fade = (box, from, to, done) => {
    if (still) return done?.()
    const animation = box.animate({ opacity: [from, to] }, { duration: 120, easing: 'ease-out' })
    if (done) animation.onfinish = done
  }
  function swap(next) {
    const previous = current
    current = next
    next.hidden = false
    measure(next) // (the only layout read: the new face, positioned out of flow)
    fade(next, 0, 1)
    if (previous === boxes.card) previous.hidden = true // (the card goes at once: the island shrinks round the new face)
    else if (previous !== next) fade(previous, 1, 0, () => { if (previous !== current) previous.hidden = true })
  }

  const model = createIslandModel({
    onChange(face, patch) {
      island.dataset.face = face.kind
      clearInterval(clockTimer)
      if (patch) { patchFace(face); return }
      let box = boxes[face.kind]
      if (!box) {
        box = boxes.moment
        box.replaceChildren(h('button', 'isl-hit'), ...MOMENTS[face.kind](face))
        box.firstChild.setAttribute('aria-label', 'Note actions')
        box.firstChild.dataset.islandAction = 'open'
        createIcons({ icons, root: box })
        if (face.kind === 'download') box.querySelector('.isl-bar i').style.transform = `scaleX(${face.percent / 100})`
        if (face.kind === 'recording') {
          levels = new Array(BARS).fill(0)
          const clockText = box.querySelector('.isl-clock')
          clockTimer = setInterval(() => { clockText.textContent = clock(Date.now() - face.startedAt) }, 1000)
        }
      }
      swap(box)
    },
  })
  function patchFace(face) {
    if (face.kind !== 'download') return
    boxes.moment.querySelector('.isl-bar i').style.transform = `scaleX(${face.percent / 100})`
    boxes.moment.querySelector('.isl-pct').textContent = `${face.percent}%`
  }

  measure(current)
  island.addEventListener('click', (event) => {
    const action = event.target.closest('[data-island-action]')?.dataset.islandAction
    if (action === 'retry') onRetry()
    else if (action === 'stop') onStop()
    else if (action === 'open') onOpen()
  })

  return {
    model,
    // The title changed (a note opened or was renamed): if the title is what shows, measure it again.
    setTitle(text) {
      if (title.textContent === text) return
      title.textContent = text
      if (current === boxes.rest) measure(boxes.rest)
    },
    remeasure: () => measure(current),
    // One level (0 to 1) per chunk of audio while recording: a scrolling row of bars, written only then.
    level(value) {
      if (island.dataset.face !== 'recording') return
      levels.push(Math.min(1, value * 4))
      levels.shift()
      boxes.moment.querySelectorAll('.isl-wave i').forEach((bar, i) => bar.style.setProperty('--l', levels[i].toFixed(2)))
    },
  }
}
