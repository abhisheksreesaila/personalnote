// Secure notes (F-058): the small pure pieces. The page code that draws the cover, the sheets and the pill is in ui.js.

export const DEFAULT_QUIET_SECONDS = 300
export const MIN_PASSPHRASE_LENGTH = 8 // the server's rule (secure_crypto.MIN_PASSPHRASE_LENGTH)
export const RECOVERY_LETTERS = 32

// "4:59": the part second still running counts as the second left, so the pill never shows 0:00 while the note is still open.
export function formatCountdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// How long the page has been quiet. The server runs the same clock on the keys; a nonsense length means the default 5 minutes.
export function createQuietTimer({ seconds, now = () => Date.now() } = {}) {
  const length = (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_QUIET_SECONDS) * 1000
  let last = now()
  const remaining = () => Math.max(0, length - (now() - last))
  return { touch: () => { last = now() }, remaining, expired: () => remaining() === 0, length }
}

const letters = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

export function recoveryGroups(key) {
  return letters(key).match(/.{1,4}/g) ?? []
}

// As the key is typed: capitals, groups of four joined by dashes, no more than the key's 32 letters.
export function formatRecoveryInput(text) {
  return recoveryGroups(letters(text).slice(0, RECOVERY_LETTERS)).join('-')
}

// `method` is how the unlock was tried: 'touch', 'passphrase' or 'recovery'.
export function unlockFailureMessage(error, method) {
  if (typeof error?.status !== 'number') return "Couldn't reach Personal Note. Try again."
  if (method === 'recovery') return "That key doesn't match. Check the groups and try again."
  return 'Not opened. Try again.'
}

// What is wrong with a passphrase being chosen, or null.
export function passphraseProblem(passphrase, again) {
  if (!passphrase) return 'Type a passphrase'
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters`
  if (passphrase !== again) return "The two don't match"
  return null
}

const plainIcon = (noteType) => (noteType === 'mindmap' ? 'git-fork' : noteType === 'page' ? 'file-pen' : 'file-text')

// The sidebar row: a secure note shows the lock in the secure colour in place of its note icon.
export function noteRowIcon(note) {
  return note.secure ? { icon: 'lock', className: 'is-secure' } : { icon: plainIcon(note.noteType), className: '' }
}

// A secure note is found by its title only: no words, whatever the server sent.
export function searchResultView(result) {
  return result.secure
    ? { icon: 'lock', excerpt: '', className: 'is-secure' }
    : { icon: plainIcon(result.noteType), excerpt: result.excerpt ?? '', className: '' }
}
