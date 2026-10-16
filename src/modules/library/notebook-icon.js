// A notebook's icon (F-089): what it shows, how it is guessed from the name, and what the emoji field accepts.
// Stored on the server as '' (guess), 'lucide:<name>', 'brand:x' or 'emoji:<one grapheme>' (notebook_icon.py holds the same name list).

export const ICON_NAMES = [
  'house', 'globe', 'link', 'bookmark', 'book', 'briefcase', 'code', 'heart', 'plane', 'cooking-pot', 'dumbbell', 'music',
  'camera', 'lightbulb', 'graduation-cap', 'wallet', 'shopping-cart', 'baby', 'paw-print', 'leaf', 'car', 'gamepad-2',
  'film', 'palette', 'flask-conical', 'calendar', 'star', 'inbox', 'archive', 'folder', 'mic', 'brain', 'pencil', 'map',
  'users', 'rocket', 'coffee', 'sun', 'moon', 'flag',
]

// The six of the notebook dialog and two more.
export const NOTEBOOK_COLORS = ['#B86B4B', '#D09A45', '#6F8C63', '#4D839C', '#7A6F9B', '#A55D6F', '#C4577A', '#5F7F8F']

const KEYWORDS = {
  house: 'chores chore home house household housework family garden',
  globe: 'links link web website websites bookmarks internet sites',
  'brand:x': 'x twitter tweets tweet',
  'cooking-pot': 'recipes recipe food cooking cook meals kitchen',
  plane: 'travel trip trips flights holiday vacation',
  briefcase: 'work job jobs career office business',
  lightbulb: 'ideas idea brainstorm inspiration',
  wallet: 'money finance finances budget taxes expenses',
  dumbbell: 'health gym fitness workout exercise',
  book: 'reading books book library',
  music: 'music songs playlist',
  camera: 'photos photo pictures photography',
  'graduation-cap': 'school study studies class courses learning university',
  code: 'code coding programming dev',
  heart: 'love dates wedding',
  film: 'movies movie films film',
  'shopping-cart': 'shopping groceries',
  calendar: 'calendar schedule planning',
  'paw-print': 'pets pet dog cat',
  car: 'car cars driving',
}
const WORDS = new Map(Object.entries(KEYWORDS).flatMap(([icon, words]) => words.split(' ').map((word) => [word, icon.includes(':') ? icon : `lucide:${icon}`])))

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const graphemes = (text) => [...segmenter.segment(text)].map((part) => part.segment)
const isEmoji = (grapheme) => /^(\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣)/u.test(grapheme)

/** The emoji a name starts with ('' when it does not start with one). */
export function leadingEmoji(name) {
  const first = graphemes(String(name || '').trimStart())[0]
  return first && isEmoji(first) ? first : ''
}

/** The icon a name suggests: its leading emoji, else a keyword, else '' (the first letter is shown then). */
export function guessIcon(name) {
  const emoji = leadingEmoji(name)
  if (emoji) return `emoji:${emoji}`
  for (const word of String(name || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (WORDS.has(word)) return WORDS.get(word)
  }
  return ''
}

/** What to draw for a notebook: { kind: 'emoji' | 'lucide' | 'brand' | 'letter', value }. A chosen icon wins, then the guess. */
export function iconOf(notebook) {
  const icon = notebook.icon || guessIcon(notebook.name)
  const [kind, ...rest] = icon.split(':')
  if (rest.length) return { kind, value: rest.join(':') }
  return { kind: 'letter', value: String(notebook.name || '').trim().slice(0, 1).toUpperCase() || '?' }
}

/** The name as the row shows it: without its leading emoji when that emoji is the icon already drawn beside it. */
export function displayName(notebook) {
  const emoji = leadingEmoji(notebook.name)
  const rest = emoji ? String(notebook.name).trimStart().slice(emoji.length).trim() : ''
  return rest && iconOf(notebook).value === emoji ? rest : notebook.name
}

/** What the emoji field holds as a stored icon, or null when it is not exactly one emoji. */
export function normalizeEmoji(text) {
  const parts = graphemes(String(text || '').trim())
  return parts.length === 1 && isEmoji(parts[0]) ? `emoji:${parts[0]}` : null
}
