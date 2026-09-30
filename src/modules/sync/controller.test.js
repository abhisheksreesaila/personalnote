import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFlagFor, pickFlagBlock } from './changes.js'
import { createAgentSyncController } from './controller.js'

function setup({ active = { id: 1, resourceId: 'res_a', revision: 3, noteType: 'canvas' }, unsaved = false, remote = { id: 1, revision: 4 }, added = 1 } = {}) {
  const calls = []
  const ui = {
    setPresence: (p) => calls.push(['presence', p?.label ?? null]),
    setFlag: (f) => calls.push(['flag', f?.label ?? null]),
    showNotice: (m) => calls.push(['notice', m]),
  }
  const host = {
    api: async () => remote,
    getActive: () => active,
    hasUnsavedEdits: () => unsaved,
    reload: async () => calls.push(['reload']),
    merge: async () => (calls.push(['merge']), added),
    refreshLists: async () => calls.push(['lists']),
  }
  return { calls, controller: createAgentSyncController({ host, ui }) }
}
const change = (revision, changeType = 'updated') => ({ resourceKind: 'note', resourceId: 'res_a', revision, changeType })
const names = (calls) => calls.map((call) => call[0])

test('a clean open note is reloaded', async () => {
  const { calls, controller } = setup()
  await controller.onUpdate({ changes: [change(4)], agents: [] })
  assert.deepEqual(names(calls).filter((n) => n !== 'presence' && n !== 'flag'), ['lists', 'reload'])
})

test('unsaved edits take the merge path and report added agent text', async () => {
  const { calls, controller } = setup({ unsaved: true })
  await controller.onUpdate({ changes: [change(4)], agents: [] })
  assert.ok(names(calls).includes('merge'))
  assert.ok(!names(calls).includes('reload'))
  assert.equal(calls.find((c) => c[0] === 'notice')[1], 'New text from an agent was added next to your edits')
})

test('no notice when a merge adds nothing (the user\'s own save in flight)', async () => {
  const { calls, controller } = setup({ unsaved: true, added: 0 })
  await controller.onUpdate({ changes: [change(4)], agents: [] })
  assert.ok(names(calls).includes('merge'))
  assert.ok(!names(calls).includes('notice'))
})

test('a remote delete of the open note shows a notice and does not reload', async () => {
  const { calls, controller } = setup()
  await controller.onUpdate({ changes: [change(5, 'deleted')], agents: [] })
  assert.ok(names(calls).includes('notice'))
  assert.ok(!names(calls).includes('reload'))
})

test('the baseline poll only sets presence and never touches the note', async () => {
  const { calls, controller } = setup()
  await controller.onUpdate({ baseline: true, changes: [], agents: [{ agent: 'Claude Code', action: 'reading', noteId: 1 }] })
  assert.deepEqual(calls, [['presence', 'Claude Code is reading'], ['flag', 'Claude · reading']])
})

test('own echoed revisions cause no reload or merge', async () => {
  const { calls, controller } = setup()
  await controller.onUpdate({ changes: [change(3)], agents: [] })
  assert.deepEqual(names(calls).filter((n) => !['presence', 'flag'].includes(n)), [])
})

test('the cursor flag only shows for an agent on the open note and clears with presence', async () => {
  assert.equal(agentFlagFor([{ agent: 'Claude Code', action: 'writing', noteId: 2 }], 1), null)
  assert.equal(agentFlagFor([{ agent: 'Claude Code', action: 'reading', noteId: 1 }, { agent: 'Other', action: 'writing', noteId: 1 }], 1).label, 'Other · writing')
  const { calls, controller } = setup()
  controller.clearPresence()
  assert.deepEqual(calls, [['presence', null], ['flag', null]])
})

test('the flag points at the appended block for writes and the first block for reads', () => {
  const objects = [
    { text: 'middle', top: 200, left: 10 },
    { text: 'last', top: 400, left: 10 },
    { text: 'first', top: 100, left: 10 },
    { text: '  ', top: 900, left: 0 },
    { top: 1000 },
  ]
  assert.equal(pickFlagBlock('writing', objects).text, 'last')
  assert.equal(pickFlagBlock('reading', objects).text, 'first')
  assert.equal(pickFlagBlock('reading', []), undefined)
})
