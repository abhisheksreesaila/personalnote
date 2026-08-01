import assert from 'node:assert/strict'
import test from 'node:test'

import { calendarDraftToIcs, parseCalendarDraft } from './calendar-draft.js'


test('parses a calendar draft without treating it as a committed event', () => {
  const draft = parseCalendarDraft(
    'Lunch with Maya next Thursday at 2',
    new Date('2026-07-19T09:00:00'),
  )

  assert.equal(draft.title, 'Lunch with Maya')
  assert.equal(draft.dateText, 'next Thursday at 2')
  assert.equal(draft.hasExplicitTime, true)
  assert.equal(new Date(draft.startAt).getDay(), 4)
  assert.equal(new Date(draft.startAt).getHours(), 14)
})

test('stays quiet for dated prose without an event cue', () => {
  const draft = parseCalendarDraft(
    'The launch moved to next Thursday',
    new Date('2026-07-19T09:00:00'),
  )

  assert.equal(draft, null)
})

test('recognizes scheduling language used in a canvas text object', () => {
  const draft = parseCalendarDraft(
    'Lets schedule the event for Saturday at 6 am',
    new Date('2026-07-19T09:00:00'),
  )

  assert.equal(draft.title, 'Lets schedule the event')
  assert.equal(new Date(draft.startAt).getDay(), 6)
  assert.equal(new Date(draft.startAt).getHours(), 6)
})

test('recognizes explicit clock times without a scheduling verb', () => {
  const draft = parseCalendarDraft(
    'Team sync at 9 AM with Maya',
    new Date('2026-07-30T12:00:00'),
  )

  assert.equal(draft.title, 'Team sync with Maya')
  assert.equal(draft.hasExplicitTime, true)
  assert.equal(new Date(draft.startAt).getHours(), 9)
})

test('parses schedule something at 9 AM phrasing', () => {
  const draft = parseCalendarDraft(
    'schedule something at 9 AM',
    new Date('2026-07-30T12:00:00'),
  )

  assert.equal(draft.title, 'schedule something')
  assert.equal(draft.hasExplicitTime, true)
})

test('serializes a draft as an explicit calendar file', () => {
  const content = calendarDraftToIcs({
    title: 'Lunch with Maya',
    startAt: '2026-07-23T09:00:00.000Z',
    durationMinutes: 60,
  }, 'draft@example')

  assert.match(content, /UID:draft@example/)
  assert.match(content, /DTSTART:20260723T090000Z/)
  assert.match(content, /DTEND:20260723T100000Z/)
  assert.match(content, /SUMMARY:Lunch with Maya/)
})