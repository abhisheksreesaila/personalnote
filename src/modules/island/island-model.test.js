import assert from 'node:assert/strict'
import test from 'node:test'
import { createIslandModel } from './island-model.js'

// A clock the test turns by hand: schedule/cancel replace setTimeout/clearTimeout.
function harness() {
  let now = 0
  let next = 1
  const timers = new Map()
  const faces = []
  const model = createIslandModel({
    schedule: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id },
    cancel: (id) => timers.delete(id),
    onChange: (face, patch) => faces.push({ kind: face.kind, patch }),
  })
  const advance = (ms) => {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at
      timers.delete(due[0])
      due[1].fn()
    }
    now = end
  }
  return { model, faces, advance, timers: () => timers.size }
}

test('at rest it shows the title and nothing is scheduled', () => {
  const { model, timers } = harness()
  assert.equal(model.face().kind, 'rest')
  assert.equal(timers(), 0)
})

test('a save that lands within 3 seconds never changes the face', () => {
  const { model, faces, advance, timers } = harness()
  model.saveSending()
  advance(2999)
  model.saveDone()
  advance(5000)
  assert.deepEqual(faces, [])
  assert.equal(model.face().kind, 'rest')
  assert.equal(timers(), 0)
})

test('a save still pending after 3 seconds says Saving, then Saved for 1.2 seconds, then rests', () => {
  const { model, faces, advance } = harness()
  model.saveSending()
  advance(3000)
  assert.equal(model.face().kind, 'saving')
  model.saveDone()
  assert.equal(model.face().kind, 'saved')
  advance(1199)
  assert.equal(model.face().kind, 'saved')
  advance(1)
  assert.equal(model.face().kind, 'rest')
  assert.deepEqual(faces.map((f) => f.kind), ['saving', 'saved', 'rest'])
})

test('a failed save stays, with its reason and a retry, until a save works', () => {
  const { model, advance } = harness()
  model.saveFailed('Couldn’t save', 'Disk is full', true)
  advance(60000)
  assert.deepEqual(model.face(), { kind: 'error', title: 'Couldn’t save', message: 'Disk is full', retry: true })
  model.saveSending()
  assert.equal(model.face().kind, 'error') // (still failed while it tries again)
  model.saveDone()
  assert.equal(model.face().kind, 'saved') // (the relief is announced, like a slow save)
  advance(1200)
  assert.equal(model.face().kind, 'rest')
})

test('recording shows the recording face until stopped, then Added N words for 1.5 seconds', () => {
  const { model, advance } = harness()
  model.recording(true, 1000)
  assert.deepEqual(model.face(), { kind: 'recording', startedAt: 1000 })
  advance(120000)
  assert.equal(model.face().kind, 'recording')
  model.recording(false, 24)
  assert.deepEqual(model.face(), { kind: 'added', words: 24 })
  advance(1500)
  assert.equal(model.face().kind, 'rest')
})

test('recording that adds no words just goes back to rest; one word reads singular', () => {
  const { model } = harness()
  model.recording(true, 0)
  model.recording(false, 0)
  assert.equal(model.face().kind, 'rest')
  model.recording(true, 0)
  model.recording(false, 1)
  assert.deepEqual(model.face(), { kind: 'added', words: 1 })
})

test('an agent notice shows for 4 seconds; agent presence stays while it is there', () => {
  const { model, advance } = harness()
  model.agentNotice('Claude edited this note')
  assert.deepEqual(model.face(), { kind: 'agent', label: 'Claude edited this note' })
  advance(4000)
  assert.equal(model.face().kind, 'rest')
  model.agentPresence('Claude Code is writing')
  advance(60000)
  assert.deepEqual(model.face(), { kind: 'agent', label: 'Claude Code is writing' })
  model.agentPresence(null)
  assert.equal(model.face().kind, 'rest')
})

test('an agent notice can offer actions, lasts as long as it is told, and is dismissed at once by a click', () => {
  const { model, advance } = harness()
  model.agentNotice('Claude edited this note', [['agent-show', 'Show'], ['agent-undo', 'Undo']])
  assert.deepEqual(model.face(), { kind: 'agent', label: 'Claude edited this note', actions: [['agent-show', 'Show'], ['agent-undo', 'Undo']] })
  advance(3999)
  assert.equal(model.face().kind, 'agent')
  advance(1)
  assert.equal(model.face().kind, 'rest')
  model.agentNotice('You changed this since', [], 6000)
  advance(5999)
  assert.equal(model.face().label, 'You changed this since')
  advance(1)
  assert.equal(model.face().kind, 'rest')
  model.agentNotice('Claude edited this note', [['agent-undo', 'Undo']])
  model.agentNotice(null) // a click on an action
  assert.equal(model.face().kind, 'rest')
  model.agentPresence('Claude Code is writing')
  model.agentNotice('Claude edited this note', [['agent-undo', 'Undo']])
  assert.equal(model.face().actions[0][0], 'agent-undo') // (the notice outranks presence)
})

test('a download shows its name and percent in place, and ends with "is ready" for 1.5 seconds', () => {
  const { model, faces, advance } = harness()
  model.download('voice', 'Voice model', 10)
  model.download('voice', 'Voice model', 55)
  assert.deepEqual(model.face(), { kind: 'download', name: 'Voice model', percent: 55 })
  assert.deepEqual(faces.map((f) => [f.kind, f.patch]), [['download', false], ['download', true]]) // (the second only patches the bar: no re-measure)
  model.downloadEnd('voice', true)
  assert.deepEqual(model.face(), { kind: 'ready', name: 'Voice model' })
  advance(1500)
  assert.equal(model.face().kind, 'rest')
})

test('a cancelled or failed download just leaves', () => {
  const { model } = harness()
  model.download('meaning', 'Search by meaning', 30)
  model.downloadEnd('meaning', false)
  assert.equal(model.face().kind, 'rest')
})

test('the card wins over moments and the moment comes back when it closes; an error outranks a recording', () => {
  const { model } = harness()
  model.recording(true, 5)
  model.saveFailed('Couldn’t save', 'Disk is full', true)
  assert.equal(model.face().kind, 'error')
  model.card(true)
  assert.equal(model.face().kind, 'card')
  model.card(false)
  assert.equal(model.face().kind, 'error')
  model.saveDone()
  assert.equal(model.face().kind, 'recording')
})

test('focus mode owns the face while it lasts', () => {
  const { model } = harness()
  model.saveFailed('Database offline')
  model.focus(true)
  assert.equal(model.face().kind, 'focus')
  model.focus(false)
  assert.equal(model.face().kind, 'error')
})

test('a save that ends without a result (locked) clears Saving at once and announces nothing', () => {
  const { model, advance, timers } = harness()
  model.saveSending()
  advance(3000)
  assert.equal(model.face().kind, 'saving')
  model.saveEnded()
  assert.equal(model.face().kind, 'rest')
  model.saveSending()
  model.saveEnded()
  advance(10000)
  assert.equal(model.face().kind, 'rest')
  assert.equal(timers(), 0)
})

test('a jam wears its own face over the mic, under the card, a save error and focus, and rests when it ends', () => {
  const { model, faces } = harness()
  model.jam({ phase: 'idle', line: '' })
  assert.deepEqual(model.face(), { kind: 'jam', phase: 'idle', line: '' })
  model.recording(true, 0)
  assert.equal(model.face().kind, 'jam')
  model.jam({ phase: 'listening', line: 'we could sell to dog owners' })
  assert.equal(faces.at(-1).patch, true) // same face, new words: the view only swaps the text
  model.card(true)
  assert.equal(model.face().kind, 'card')
  model.card(false)
  model.saveFailed('Could not save')
  assert.equal(model.face().kind, 'error')
  model.saveDone()
  assert.equal(model.face().kind, 'jam')
  model.jam(null)
  assert.equal(model.face().kind, 'recording')
  model.recording(false, 0)
  assert.equal(model.face().kind, 'saved')
})
