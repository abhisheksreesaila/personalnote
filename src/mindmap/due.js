// A node's due date (F-109): "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", local time (the server's reminders read the same text).
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parse(due) {
  const match = typeof due === 'string' ? SHAPE.exec(due) : null
  if (!match) return null
  const [year, month, day, hour, minute] = match.slice(1).map((part) => (part === undefined ? undefined : Number(part)))
  const at = new Date(year, month - 1, day, hour ?? 0, minute ?? 0)
  const real = at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day && at.getHours() === (hour ?? 0) && at.getMinutes() === (minute ?? 0)
  return real ? { at, timed: hour !== undefined } : null
}

export const validDue = (due) => parse(due) !== null

const clock = (at) => `${at.getHours() % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${at.getHours() < 12 ? 'AM' : 'PM'}`

// What the chip by the label says and how it looks: 'overdue' (red), 'today' (amber) or 'later'.
export function dueChip(due, now = new Date()) {
  const parsed = parse(due)
  if (!parsed) return null
  const { at, timed } = parsed
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()) - today) / 86400000)
  const state = days < 0 || (days === 0 && timed && at <= now) ? 'overdue' : days === 0 ? 'today' : 'later'
  const day = days === 0 ? (timed ? '' : 'Today') : days > 0 && days < 7 ? DAYS[at.getDay()] : `${MONTHS[at.getMonth()]} ${at.getDate()}`
  return { text: [day, timed ? clock(at) : ''].filter(Boolean).join(' '), state }
}
