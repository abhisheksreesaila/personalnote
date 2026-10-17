// What a note link card shows (F-095): the target's title, its first lines and its notebook's icon, from the live answer of the server
// (`info`: undefined while it is being asked, null when the note is gone). Pure, so the faces are checked without the canvas; scene.js draws them.
import { iconOf } from '../library/notebook-icon.js'

export const CARD_SIZE = Object.freeze({ width: 280, height: 96 })
const NEUTRAL = '#8a8a85'

// The glyph on the notebook's colour: an emoji, a letter, X for the X logo; other icons show the notebook's first letter (the card is drawn, not a page of HTML).
function badgeOf(notebook) {
  if (!notebook) return { color: NEUTRAL, glyph: '·' }
  const icon = iconOf(notebook)
  const letter = String(notebook.name || '?').trim().slice(0, 1).toUpperCase() || '?'
  return { color: notebook.color || NEUTRAL, glyph: icon.kind === 'emoji' ? icon.value : icon.kind === 'brand' ? 'X' : icon.kind === 'letter' ? icon.value : letter }
}

/** { state: 'ok' | 'removed' | 'secure', title, detail, badge } for a card; `detail` is a plain-text line or two (never HTML). */
export function noteLinkFace(object, info) {
  if (info === null) return { state: 'removed', title: 'Note removed', detail: object.title || '', badge: { color: NEUTRAL, glyph: '×' } }
  const title = info?.title || object.title || 'Untitled note'
  if (!info) return { state: 'ok', title, detail: '', badge: badgeOf(null) }
  if (info.secure) return { state: 'secure', title, detail: 'Secure note', badge: badgeOf(info.notebook) }
  return { state: 'ok', title, detail: String(info.excerpt || '').split('\n').filter(Boolean).slice(0, 3).join(' · '), badge: badgeOf(info.notebook) }
}

/** A card for a note, centred on a page point. */
export function newNoteLink({ id, z, point, ref, title }) {
  const { width, height } = CARD_SIZE
  return {
    id, type: 'notelink', z, noteRef: ref, title,
    geometry: { x: point.x - width / 2, y: point.y - height / 2, width, height, rotation: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 },
  }
}
