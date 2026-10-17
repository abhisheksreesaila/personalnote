// A note dropped into a note (F-095). The address of a note is its resource id (it survives a backup, which repoints it): a canvas holds a
// JSON Canvas link node with this url, a page holds a Markdown link to it. What a card or link shows (title, first lines, notebook, or
// "gone") is asked of the server and kept here, so a canvas and a page share one answer.
import { api } from './api.js'

export const NOTE_URL = 'personal-note://note/'
export const NOTE_LINK = /\[([^\]\n]*)\]\(personal-note:\/\/note\/(res_[0-9a-f]{32})\)/g

/** The Markdown for a link to a note; brackets and line breaks in the title are dropped so it stays one link. */
export const noteLinkMarkdown = (ref, title) => `[${String(title || 'Untitled note').replace(/[[\]\\\s]+/g, ' ').trim() || 'Untitled note'}](${NOTE_URL}${ref})`

const answers = new Map() // resource id -> { id, title, excerpt, secure, notebook } | null (the note is gone); absent: not asked yet
const listeners = new Set()

export const peekNoteLink = (ref) => answers.get(ref)
export function onNoteLinks(listener) { listeners.add(listener); return () => listeners.delete(listener) }

/** Asks the server about notes (all again with `fresh`, else only those not asked yet) and tells the listeners what changed. */
export async function loadNoteLinks(refs, { fresh = false } = {}) {
  const wanted = [...new Set(refs)].filter((ref) => fresh || !answers.has(ref))
  if (!wanted.length) return
  let found
  try { found = await api(`/note-links?refs=${wanted.join(',')}`) } catch { return } // offline: the cards keep what they show
  for (const ref of wanted) answers.set(ref, found[ref] ?? null)
  for (const listener of listeners) listener(wanted)
}
