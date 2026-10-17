// Settings window (F-102): what the sections are, which rows a search keeps, and the short value each section shows on a phone's list.
// No DOM here: settings-window.js draws it. The icons are Lucide names; every tile is monochrome (the design's rule), so a section has no colour.

export const SECTIONS = [
  { id: 'appearance', title: 'Appearance', icon: 'sun', group: 0, blurb: 'How Personal Note looks. A skin applies at once.' },
  { id: 'writing', title: 'Writing', icon: 'pencil', group: 0, blurb: 'How new text looks on a canvas.' },
  { id: 'ai', title: 'AI', icon: 'sparkles', group: 1, blurb: 'One model for every AI feature. Nothing is sent until you press Jam.' },
  { id: 'plugins', title: 'Plugins', icon: 'layout-grid', group: 1, blurb: 'Optional features. Off hides a feature and keeps its notes.' },
  { id: 'voice', title: 'Voice', icon: 'mic', group: 1, blurb: 'Hold to talk. It runs here and keeps only the words.' },
  { id: 'meaning', title: 'Search by meaning', icon: 'brain', group: 1, blurb: 'Finds notes by idea, not just words. It runs here.' },
  { id: 'x', title: 'X bookmarks', icon: 'bookmark', group: 1, blurb: 'Bring your X bookmarks in as notes. Read-only.' },
  { id: 'locked', title: 'Locked notes', icon: 'lock', group: 2, blurb: 'Secure notes stay locked until you open one.' },
  { id: 'advanced', title: 'Advanced', icon: 'gauge', group: 2, blurb: 'Speed, drawing mode and your backups.' },
]

const tokens = (query) => query.toLowerCase().split(/\s+/).filter(Boolean)
export const matches = (query, text) => { const hay = text.toLowerCase(); return tokens(query).every((token) => hay.includes(token)) }

/**
 * What a search keeps. `rows` maps a section id to the text of each of its rows. A section whose name matches keeps every row; otherwise it keeps the
 * rows that match, and drops out when none does. An empty search keeps everything. Returns `[{ id, rows }]` in section order (`rows`: indexes to show).
 */
export function filterSections(query, rows, sections = SECTIONS) {
  const all = (id) => (rows[id] ?? []).map((_, index) => index)
  if (!tokens(query).length) return sections.map(({ id }) => ({ id, rows: all(id) }))
  return sections.flatMap(({ id, title }) => {
    if (matches(query, title)) return [{ id, rows: all(id) }]
    const kept = (rows[id] ?? []).flatMap((text, index) => (matches(query, `${title} ${text}`) ? [index] : []))
    return kept.length ? [{ id, rows: kept }] : []
  })
}

const FONTS = { 'Source Serif 4': 'Serif', 'IBM Plex Sans': 'Sans', monospace: 'Mono' }
const SKIN_NAMES = { crayon: 'Crayon', paper: 'Paper', night: 'Night' }

/** The value on a phone's section list, from facts the shell already has. A missing fact reads as an empty value, never an error. */
export function sectionValues(facts) {
  const on = (facts.plugins ?? []).filter((plugin) => plugin.enabled).length
  return {
    appearance: SKIN_NAMES[facts.skin] ?? '',
    writing: facts.fontFamily ? `${FONTS[facts.fontFamily] ?? facts.fontFamily} · ${facts.fontSize}` : '',
    ai: facts.provider ?? '',
    plugins: facts.plugins ? `${on} on` : '',
    voice: facts.voice ?? '',
    meaning: facts.meaning ?? '',
    x: facts.x ?? '',
    locked: '',
    advanced: '',
  }
}
