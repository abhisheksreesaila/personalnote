import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeText } from './merge.js'

const apply = (local, changes) => changes.apply(EditorText(local)).toString()
import { Text } from '@codemirror/state'
const EditorText = (s) => Text.of(s.split('\n'))

test('an agent edit and local typing in different places both survive', () => {
  const base = 'Plan the trip.\n\nPack light.'
  const local = 'Plan the trip.\n\nPack light. Bring a coat.'
  const remote = '# Lisbon\n\nPlan the trip.\n\nPack light.'
  assert.equal(apply(local, mergeText(base, local, remote)), '# Lisbon\n\nPlan the trip.\n\nPack light. Bring a coat.')
})

test('nothing changes when the agent text is what the server already had', () => {
  assert.equal(mergeText('same', 'same plus mine', 'same').empty, true)
})
