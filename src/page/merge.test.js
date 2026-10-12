import test from 'node:test'
import assert from 'node:assert/strict'
import { Text } from '@codemirror/state'
import { mergeText } from './merge.js'

const merged = (base, local, remote) => mergeText(base, local, remote).apply(Text.of(local.split('\n'))).toString()

test('an agent edit and local typing in different places both survive', () => {
  assert.equal(merged('Plan the trip.\n\nPack light.', 'Plan the trip.\n\nPack light. Bring a coat.', '# Lisbon\n\nPlan the trip.\n\nPack light.'),
    '# Lisbon\n\nPlan the trip.\n\nPack light. Bring a coat.')
})

test('agent edits above and below the paragraph being typed in leave the typing exactly where it was', () => {
  const base = '# Trip\nDay two: tram ride.\nDay three: home.'
  const local = '# Trip\nDay two: tram ride to Belem, then pastries.\nDay three: home.'
  const remote = '# Lisbon trip\nDay two: tram ride.\nDay three: fly home.'
  assert.equal(merged(base, local, remote), '# Lisbon trip\nDay two: tram ride to Belem, then pastries.\nDay three: fly home.')
})

test('when the agent deletes the paragraph being typed in, the typing wins and stays intact', () => {
  const base = 'Day one.\nDay two: tram.\nDay three: home.'
  const local = 'Day one.\nDay two: tram and more.\nDay three: home.'
  assert.equal(merged(base, local, 'Day one.\nDay three: home.'), local)
})

test('agent edits on both sides of local typing in the same line are all kept', () => {
  assert.equal(merged('x1 mid x2', 'x1 MID! x2', 'y1 mid y2'), 'y1 MID! y2')
})

test('the agent text being the same as the local typing changes nothing (no doubled words)', () => {
  assert.equal(merged('A', 'AB', 'AB'), 'AB')
})

test('nothing changes when the agent text is what the server already had', () => {
  assert.equal(mergeText('same', 'same plus mine', 'same').empty, true)
})

test('an agent append at the very spot being typed at keeps both, typing first', () => {
  assert.equal(merged('We walked.', 'We walked. Typed here.', 'We walked.\n\nAgent paragraph.'), 'We walked. Typed here.\n\nAgent paragraph.')
})

test('an agent echo of what was already typed is not added twice', () => {
  assert.equal(merged('A', 'ABC', 'AB'), 'ABC')
})

test('on a long paragraph an agent fix at the start and typing at the end are both kept', () => {
  const tail = ' and so on'.repeat(220) // about 2,200 characters in one paragraph
  const base = `Teh trip began early${tail}.`
  const local = `${base} Typed at the end.`
  const remote = `The trip began early${tail}.`
  assert.equal(merged(base, local, remote), `The trip began early${tail}. Typed at the end.`)
})

test('on a note of thousands of lines an agent edit far from the typing is kept, quickly', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `Line ${i} of the long note.`)
  const base = lines.join('\n')
  const local = base.replace('Line 10 of', 'Line 10 (typed) of')
  const remote = base.replace('Line 4990 of', 'Line 4990 (agent) of')
  const started = performance.now()
  const result = merged(base, local, remote)
  assert.ok(result.includes('Line 10 (typed) of') && result.includes('Line 4990 (agent) of'))
  assert.ok(performance.now() - started < 500)
})

test('an agent append after text the server had not seen yet is added once', () => {
  assert.equal(merged('A', 'AB', 'ABC'), 'ABC')
})
