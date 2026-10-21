// The picker for a note's emoji icon (F-100): search, recent, a few common ones, five tints, "Guess from title" and "Remove".
// A popover by the emoji on a wide screen, a bottom sheet on a phone. It is fetched the first time one is opened (nothing here is in the first load);
// main.js passes what to change and how to redraw. The server holds the guess and the tint rules (note_icon.py): this only sends choices.
// (It imports nothing: a module the first load shares with a lazy chunk becomes a chunk of its own and costs first-load bytes.)

export const COMMON = ['📝', '📌', '✅', '💭', '🔖', '🧾', '📎', '🗂️', '🎨', '🎵', '🎬', '📷', '🏠', '🌱', '🍳', '🏃', '💰', '📈', '🧪', '🛠️', '🌍', '❤️', '⭐', '🔥']
// What the search finds: an emoji by the words people use for it (the common ones above come first).
const MORE = `
💡 idea light bulb|🚀 rocket launch startup|📚 books reading library|🗓️ calendar week plan|✈️ travel plane trip|🛒 shopping groceries cart|🧠 brain mind think|📄 page document file|🍋 lemon fruit|🍎 apple fruit|☕ coffee tea cafe|🍕 pizza food|🎯 target goal|🏆 trophy win|💼 work briefcase job|💻 computer laptop code|📱 phone mobile|🔒 lock secure private|🔑 key password|📊 chart stats data|🗺️ map plan route|🧳 luggage suitcase trip|🚗 car drive|🚲 bike cycle|🌳 tree nature|🌊 wave sea water|☀️ sun day|🌙 moon night sleep|🐶 dog pet|🐱 cat pet|🎓 school study learn|🏥 health doctor|💊 medicine pill|🧘 calm yoga mind|🎮 game play|📖 book story|✏️ pencil write|🖊️ pen write|🧩 puzzle piece|⚙️ settings gear|🔧 tool fix|💬 chat talk message|📣 announce news|🎁 gift present|🎉 party celebrate|👪 family|👶 baby child|🧹 clean chores|🛏️ bed sleep|🍷 wine drink|🥗 salad healthy food|🍰 cake dessert|🔔 bell reminder|⏰ alarm time|📅 date schedule|🧭 compass direction|🪴 plant home|💎 gem value|🏦 bank money|💳 card pay|🧮 math numbers|🔬 science research|🌐 web internet|📧 email mail|🔗 link|🖼️ picture image|🎤 mic voice|🎧 headphones listen|📺 tv watch|🧵 thread sew|🔥 fire hot|⚡ lightning fast|❄️ snow cold|🌈 rainbow`
  .trim().split('|').map((line) => { const [emoji, ...words] = line.trim().split(' '); return { emoji, words: words.join(' ') } })
const TABLE = [...COMMON.map((emoji) => ({ emoji, words: '' })), ...MORE]
const RECENT_KEY = 'pn.recentNoteIcons'
const TINTS = [1, 2, 3, 4, 5]
const EMOJI_FONT = '"Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", sans-serif'

const CSS = `
@media screen {
.nip { animation: menu-in 220ms var(--oq-ease-in); position: fixed; z-index: 90; width: 300px; max-width: calc(100vw - 16px); box-sizing: border-box; display: grid; gap: 10px; padding: 12px; border: 1px solid var(--glass-border); border-radius: 16px;
  background: var(--sk-panel); color: var(--sk-ink); box-shadow: var(--oq-shadow-2); font: 12px var(--ui-font); }
.nip :focus-visible { outline: 2px solid var(--sk-accent); outline-offset: 1px; }
.nip button { border: 0; background: none; color: inherit; font: inherit; cursor: pointer; touch-action: manipulation; }
.nip-in { box-sizing: border-box; width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--sk-edge); border-radius: 9px; background: var(--sk-desk); color: inherit; font: 13px var(--ui-font); }
.nip-h { margin: 0; color: var(--ui-muted); font: 600 10.5px var(--ui-font); letter-spacing: .08em; text-transform: uppercase; }
.nip-grid { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 2px; }
.nip-grid button { height: 34px; border-radius: 9px; font: 20px/1 ${EMOJI_FONT}; }
.nip-grid button:hover, .nip-foot button:hover { background: var(--hover); }
.nip-grid button[aria-pressed="true"] { background: var(--sk-accent-soft); }
.nip-tints { display: flex; gap: 8px; }
.nip-tints button { width: 26px; height: 26px; border-radius: 50%; background: color-mix(in srgb, var(--t) 40%, var(--sk-panel)); box-shadow: inset 0 0 0 1px var(--sk-line); }
.nip-tints button[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--sk-panel), 0 0 0 4px var(--sk-ink); }
.nip-foot { display: flex; justify-content: space-between; color: var(--ui-muted); }
.nip-foot button { padding: 6px 8px; margin: -6px -8px; border-radius: 8px; }
.nip-none { margin: 0; padding: 10px 0; color: var(--ui-muted); text-align: center; }
.nip-scrim { position: fixed; inset: 0; z-index: 89; background: color-mix(in srgb, var(--sk-ink) 38%, transparent); }
.nip-grab { display: none; }
@media (max-width: 800px) {
  .nip { inset: auto 0 0 0 !important; width: auto; max-width: none; padding: 8px 16px calc(18px + env(safe-area-inset-bottom)); border-radius: 22px 22px 0 0; gap: 12px; animation: nip-up 280ms var(--oq-ease-in); }
  .nip-grab { display: block; height: 22px; margin: 0 -16px; touch-action: none; cursor: grab; }
  .nip-grab::after { content: ""; display: block; width: 38px; height: 5px; margin: 9px auto 0; border-radius: 3px; background: var(--sk-edge); }
  .nip-in { height: 44px; font-size: 16px; }
  .nip-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .nip-grid button { height: 48px; font-size: 26px; }
  .nip-tints { gap: 10px; }
  .nip-tints button { width: 44px; height: 44px; }
  .nip-foot button { padding: 12px 10px; margin: -12px -10px; }
}
@keyframes nip-up { from { translate: 0 var(--settle-y); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .nip { animation-duration: 150ms; } }
}`

let open = null // { close } while one is showing

function recents() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((item) => typeof item === 'string').slice(0, 8) } catch { return [] }
}
function remember(emoji) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recents().filter((item) => item !== emoji)].slice(0, 8))) } catch { /* storage can be missing in a web view */ }
}

/** The emoji a search finds: the table by words (or the emoji itself), or one the person typed or pasted. */
export function findEmoji(query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  const typed = [...new Intl.Segmenter().segment(query.trim())]
  if (typed.length === 1 && /^(\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(typed[0].segment)) return [typed[0].segment]
  return TABLE.filter((item) => words.every((word) => item.words.split(' ').some((name) => name.startsWith(word)))).map((item) => item.emoji)
}

/**
 * @param {object} options
 *  id         the note's id
 *  anchor()   the emoji button the picker opens from (looked up again when it closes, because the list is drawn again)
 *  getNote()  the note's row in the notes list: { revision, icon: { emoji, tint, chosen } }
 *  api, toast, refresh   the app's request helper, its toast, and a redraw of the notes list and the open note's emoji
 *  settled()  resolves once no text save of the note is in flight (that save moves the revision)
 */
export function openNoteIconPicker({ id, anchor, getNote, api, toast, refresh, settled = async () => {} }) {
  open?.close()
  if (!getNote()) return
  if (!document.querySelector('#nip-style')) document.head.append(Object.assign(document.createElement('style'), { id: 'nip-style', textContent: CSS }))
  const picker = document.createElement('div')
  picker.className = 'nip'
  picker.setAttribute('role', 'dialog')
  picker.setAttribute('aria-label', 'Icon of this note')
  const scrim = document.createElement('div')
  scrim.className = 'nip-scrim'
  const sheet = matchMedia('(max-width: 800px)').matches
  picker.innerHTML = `
    <div class="nip-grab" aria-hidden="true"></div>
    <input class="nip-in" maxlength="40" placeholder="Search emoji, or paste one…" aria-label="Search emoji" autocomplete="off" spellcheck="false" enterkeyhint="done" />
    <div class="nip-body"></div>
    <div><p class="nip-h">Tint</p><div class="nip-tints" role="group" aria-label="Tint" style="margin-top:8px">${TINTS.map((tint) => `<button type="button" data-tint="${tint}" style="--t:var(--sk-c${tint})" aria-label="Tint ${tint}"></button>`).join('')}</div></div>
    <div class="nip-foot"><button type="button" data-guess>Guess from title</button><button type="button" data-remove>Remove</button></div>`
  const body = picker.querySelector('.nip-body')
  const input = picker.querySelector('.nip-in')
  const grid = (title, list) => `<p class="nip-h">${title}</p><div class="nip-grid" role="group" aria-label="${title}" style="margin-top:6px">${list.map((emoji) => `<button type="button" data-emoji="${emoji}" aria-label="${emoji}">${emoji}</button>`).join('')}</div>`
  const mark = () => {
    const { emoji, tint, chosen } = getNote()?.icon ?? {}
    for (const button of picker.querySelectorAll('[data-emoji]')) button.setAttribute('aria-pressed', String(chosen && button.dataset.emoji === emoji))
    for (const button of picker.querySelectorAll('[data-tint]')) button.setAttribute('aria-pressed', String(Number(button.dataset.tint) === tint))
    picker.querySelector('[data-remove]').disabled = !chosen
  }
  const draw = () => {
    const found = findEmoji(input.value)
    const recent = recents()
    body.innerHTML = found
      ? (found.length ? grid('Results', found) : `<p class="nip-none">Nothing matches “${input.value.trim().replace(/[<&]/g, '')}”</p>`)
      : (recent.length ? grid('Recent', recent) : '') + `<div style="height:10px"></div>` + grid('Notes', COMMON)
    mark()
  }
  draw()

  const place = () => {
    const rect = anchor()?.getBoundingClientRect()
    if (!rect) return close()
    if (sheet) return
    const left = Math.max(8, Math.min(rect.left, innerWidth - picker.offsetWidth - 8))
    const below = rect.bottom + 8
    picker.style.left = `${left}px`
    picker.style.top = `${below + picker.offsetHeight <= innerHeight - 8 ? below : Math.max(8, rect.top - picker.offsetHeight - 8)}px`
  }
  if (sheet) document.body.append(scrim)
  document.body.append(picker)
  place()

  function close() {
    if (open?.picker !== picker) return
    open = null
    picker.remove()
    scrim.remove()
    document.removeEventListener('pointerdown', outside, true)
    removeEventListener('resize', close)
    anchor()?.focus()
  }
  function outside(event) {
    if (!picker.contains(event.target)) close()
  }

  // One save after another, each with the revision the last one returned.
  let saves = Promise.resolve()
  const save = (change) => {
    saves = saves.then(async () => {
      await settled()
      const note = getNote()
      if (!note) return
      try {
        const result = await api(`/notes/${id}/icon`, { method: 'PATCH', body: JSON.stringify({ ...change, revision: note.revision }) })
        Object.assign(note, { revision: result.revision, icon: result.icon })
        refresh()
        mark()
      } catch (error) {
        console.error(error)
        toast("Couldn't change the icon. Try again.")
        try { note.revision = (await api(`/notes/${id}`)).revision } catch { /* the next try will say so again */ }
      }
    })
  }
  const pick = (emoji) => {
    remember(emoji)
    const { tint, chosen } = getNote().icon
    save({ icon: emoji, tint: chosen ? tint : 0 })
    close()
  }

  picker.addEventListener('click', (event) => {
    const emoji = event.target.closest('[data-emoji]')
    if (emoji) return pick(emoji.dataset.emoji)
    const tint = event.target.closest('[data-tint]')
    if (tint) {
      const { emoji: shown } = getNote().icon // a tint on a guessed icon chooses that emoji with it
      return save({ icon: shown, tint: Number(tint.dataset.tint) })
    }
    if (event.target.closest('[data-guess]')) { save({ guess: true }); close() }
    else if (event.target.closest('[data-remove]')) { save({ icon: '' }); close() }
  })
  input.addEventListener('input', draw)
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const first = findEmoji(input.value)?.[0]
    if (first) pick(first)
  })
  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    } else if (event.target.closest('.nip-grid') && event.key.startsWith('Arrow')) {
      const cells = [...picker.querySelectorAll('.nip-grid button')]
      const columns = getComputedStyle(picker.querySelector('.nip-grid')).gridTemplateColumns.split(' ').length
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key]
      const next = cells[cells.indexOf(event.target.closest('button')) + step]
      if (next) next.focus()
      event.preventDefault()
    }
  })

  // A phone sheet follows a finger dragged down from its grabber; past 80 px or a quick flick it goes, otherwise it springs back.
  const grab = picker.querySelector('.nip-grab')
  let drag = null
  grab.addEventListener('pointerdown', (event) => {
    grab.setPointerCapture(event.pointerId)
    drag = { y: event.clientY, last: event.clientY, at: event.timeStamp, speed: 0 }
    picker.style.animation = 'none'
    picker.style.transition = 'none'
  })
  grab.addEventListener('pointermove', (event) => {
    if (!drag) return
    drag.speed = (event.clientY - drag.last) / Math.max(1, event.timeStamp - drag.at)
    drag.last = event.clientY
    drag.at = event.timeStamp
    picker.style.transform = `translateY(${Math.max(0, event.clientY - drag.y)}px)`
  })
  const release = (event) => {
    if (!drag) return
    const far = event.clientY - drag.y
    const flick = drag.speed > 0.6
    drag = null
    if (far > 80 || (flick && far > 12)) return close()
    picker.style.transition = 'transform var(--oq-spring-fast-dur) var(--oq-spring-fast)'
    picker.style.transform = ''
  }
  grab.addEventListener('pointerup', release)
  grab.addEventListener('pointercancel', release)
  scrim.addEventListener('click', close)

  document.addEventListener('pointerdown', outside, true)
  addEventListener('resize', close)
  open = { picker, close }
  if (!sheet) input.focus() // (on a phone the keyboard would cover the sheet: the person taps the field when they want to type)
  else picker.querySelector('[data-emoji]')?.focus({ preventScroll: true })
}
