import assert from 'node:assert/strict'
import test from 'node:test'

import { dueChip, validDue } from './due.js'

const now = new Date(2026, 9, 30, 10, 0) // Friday 30 October 2026, 10:00 local

test('the chip says Today, a time, a weekday this week, or the date', () => {
  assert.deepEqual(dueChip('2026-10-30', now), { text: 'Today', state: 'today' })
  assert.deepEqual(dueChip('2026-10-30T15:00', now), { text: '3:00 PM', state: 'today' })
  assert.deepEqual(dueChip('2026-10-31', now), { text: 'Sat', state: 'later' })
  assert.deepEqual(dueChip('2026-11-05', now), { text: 'Thu', state: 'later' })
  assert.deepEqual(dueChip('2026-11-06', now), { text: 'Nov 6', state: 'later' })
  assert.deepEqual(dueChip('2026-11-03T08:30', now), { text: 'Tue 8:30 AM', state: 'later' })
  assert.deepEqual(dueChip('2026-11-20T00:00', now), { text: 'Nov 20 12:00 AM', state: 'later' })
})

test('overdue is a date before today, or a time that has passed today', () => {
  assert.deepEqual(dueChip('2026-10-29', now), { text: 'Oct 29', state: 'overdue' })
  assert.deepEqual(dueChip('2026-10-30T09:00', now), { text: '9:00 AM', state: 'overdue' })
  assert.deepEqual(dueChip('2026-10-30T10:00', now), { text: '10:00 AM', state: 'overdue' })
  assert.equal(dueChip('2026-10-30T10:01', now).state, 'today')
})

test('only a real date, or a real date and time, is a due', () => {
  for (const good of ['2026-10-30', '2026-02-28', '2026-10-30T23:59', '2028-02-29T00:00']) assert.equal(validDue(good), true, good)
  for (const bad of ['2026-02-30', '2026-13-01', '2026-10-30T24:00', '2026-10-30T10:60', 'tomorrow', '', '2026-10-30T10:00:00', null, 5, '2026-1-3']) assert.equal(validDue(bad), false, String(bad))
  assert.equal(dueChip('nonsense', now), null)
})
