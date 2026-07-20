import { casual } from 'chrono-node'

const EVENT_CUE = /\b(?:appointment|breakfast|call|coffee|deadline|dinner|event|interview|lunch|meet|meeting|reminder|review|schedule|sync|workshop)\b/i

function cleanTitle(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\b(?:on|at|for)\s*$/i, '')
    .replace(/^[\s,.;:!-]+|[\s,.;:!-]+$/g, '')
    .trim()
}

export function parseCalendarDraft(text, referenceDate = new Date()) {
  if (!EVENT_CUE.test(text)) return null
  const result = casual.parse(text, referenceDate, { forwardDate: true })[0]
  if (!result) return null
  const title = cleanTitle(`${text.slice(0, result.index)} ${text.slice(result.index + result.text.length)}`)
  if (!title) return null
  const start = result.start.date()
  const parsedHour = result.start.get('hour')
  if (
    result.start.isCertain('hour')
    && !result.start.isCertain('meridiem')
    && parsedHour >= 1
    && parsedHour <= 6
    && !/\bbreakfast\b/i.test(title)
  ) {
    start.setHours(start.getHours() + 12)
  }
  return {
    title,
    startAt: start.toISOString(),
    dateText: result.text,
    hasExplicitTime: result.start.isCertain('hour'),
    durationMinutes: 60,
  }
}

function icsTimestamp(value) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function escapeIcs(value) {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

export function calendarDraftToIcs(draft, uid = crypto.randomUUID()) {
  const start = new Date(draft.startAt)
  const end = new Date(start.getTime() + draft.durationMinutes * 60_000)
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Personal Note//Calendar Draft//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsTimestamp(new Date())}`,
    `DTSTART:${icsTimestamp(start)}`,
    `DTEND:${icsTimestamp(end)}`,
    `SUMMARY:${escapeIcs(draft.title)}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}