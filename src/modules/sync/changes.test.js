import assert from 'node:assert/strict'
import test from 'node:test'
import { createChangePoller, describeAgentPresence, mergeRemoteAppends, planChangeSync } from './changes.js'

const noteChange = (resourceId, revision, changeType = 'updated') => ({
  resourceKind: 'note',
  resourceId,
  revision,
  changeType,
})

test('own saves echoed by the feed cause no reload', () => {
  const plan = planChangeSync({
    changes: [noteChange('res_a', 3)],
    activeResourceId: 'res_a',
    activeRevision: 3,
    hasUnsavedEdits: false,
  })
  assert.deepEqual(plan, { refreshLists: false, activeNote: 'none' })
})

test('a newer remote revision reloads a clean active note', () => {
  const plan = planChangeSync({
    changes: [noteChange('res_a', 4)],
    activeResourceId: 'res_a',
    activeRevision: 3,
    hasUnsavedEdits: false,
  })
  assert.deepEqual(plan, { refreshLists: true, activeNote: 'reload' })
})

test('a newer remote revision never reloads over unsaved local edits', () => {
  const plan = planChangeSync({
    changes: [noteChange('res_a', 4)],
    activeResourceId: 'res_a',
    activeRevision: 3,
    hasUnsavedEdits: true,
  })
  assert.equal(plan.activeNote, 'merge')
})

test('changes to other notes only refresh the lists', () => {
  const plan = planChangeSync({
    changes: [noteChange('res_b', 2, 'created'), { resourceKind: 'notebook', resourceId: 'res_n', revision: 1, changeType: 'created' }],
    activeResourceId: 'res_a',
    activeRevision: 3,
    hasUnsavedEdits: false,
  })
  assert.deepEqual(plan, { refreshLists: true, activeNote: 'none' })
})

test('a remote delete of the active note is reported', () => {
  const plan = planChangeSync({
    changes: [noteChange('res_a', 4, 'deleted')],
    activeResourceId: 'res_a',
    activeRevision: 3,
    hasUnsavedEdits: true,
  })
  assert.equal(plan.activeNote, 'deleted')
})

test('overflowing feeds refresh lists and re-check the active note', () => {
  const plan = planChangeSync({ changes: [], overflow: true, activeResourceId: 'res_a', activeRevision: 3, hasUnsavedEdits: false })
  assert.deepEqual(plan, { refreshLists: true, activeNote: 'check' })
})

test('merging keeps local edits and adds only objects the user has not seen or deleted', () => {
  const local = [{ semanticId: 's1', text: 'edited by user' }, { semanticId: 's3', text: 'local new' }]
  const remote = [
    { semanticId: 's1', text: 'original' },
    { semanticId: 's2', text: 'user deleted this' },
    { semanticId: 's4', text: 'agent added' },
  ]
  const added = mergeRemoteAppends({
    syncedIds: new Set(['s1', 's2']),
    localObjects: local,
    remoteObjects: remote,
  })
  assert.deepEqual(added.map((item) => item.semanticId), ['s4'])
})

test('presence prefers writing over reading and names the agent', () => {
  assert.deepEqual(describeAgentPresence([]), null)
  assert.deepEqual(describeAgentPresence(undefined), null)
  const presence = describeAgentPresence([
    { agent: 'Claude Code', action: 'reading', noteTitle: 'Plan' },
    { agent: 'Claude Code 2', action: 'writing', noteTitle: 'Plan' },
  ])
  assert.equal(presence.label, 'Claude Code 2 is writing')
  assert.equal(presence.action, 'writing')
  assert.equal(presence.title, 'Plan')
  assert.equal(describeAgentPresence([{ agent: 'Claude Code', action: 'reading', noteTitle: null }]).label, 'Claude Code is reading')
})

function fakeClock() {
  const timers = new Map()
  let nextId = 1
  return {
    schedule(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, delay })
      return id
    },
    cancel(id) {
      timers.delete(id)
    },
    async tick() {
      const [id, timer] = [...timers.entries()][0] || []
      if (!id) return false
      timers.delete(id)
      await timer.callback()
      return true
    },
    get pending() {
      return timers.size
    },
  }
}

test('the poller takes a baseline first, then asks only for changes after the last sequence', async () => {
  const clock = fakeClock()
  const requests = []
  const updates = []
  const responses = [
    { sequence: 5, changes: [], agents: [] },
    { sequence: 7, changes: [noteChange('res_a', 2)], agents: [{ agent: 'Claude Code', action: 'writing' }] },
  ]
  const poller = createChangePoller({
    fetchChanges: async (since) => {
      requests.push(since)
      return responses.shift()
    },
    onUpdate: (update) => updates.push(update),
    isVisible: () => true,
    schedule: clock.schedule,
    cancel: clock.cancel,
    intervalMs: 2000,
  })
  poller.start()
  await clock.tick()
  await clock.tick()
  assert.deepEqual(requests, [null, 5])
  assert.equal(updates[0].baseline, true)
  assert.equal(updates[1].changes.length, 1)
  assert.equal(updates[1].agents[0].action, 'writing')
  poller.stop()
  assert.equal(clock.pending, 0)
})

test('the poller pauses while the page is hidden and resumes with an immediate poll', async () => {
  const clock = fakeClock()
  let visible = false
  let calls = 0
  const poller = createChangePoller({
    fetchChanges: async () => {
      calls += 1
      return { sequence: calls, changes: [], agents: [] }
    },
    onUpdate: () => {},
    isVisible: () => visible,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  poller.start()
  await clock.tick()
  assert.equal(calls, 0)
  visible = true
  await poller.pollNow()
  assert.equal(calls, 1)
})

test('the poller survives request errors and reports them', async () => {
  const clock = fakeClock()
  const errors = []
  let attempt = 0
  const poller = createChangePoller({
    fetchChanges: async () => {
      attempt += 1
      if (attempt === 1) throw new Error('offline')
      return { sequence: 1, changes: [], agents: [] }
    },
    onUpdate: () => {},
    onError: (error) => errors.push(error.message),
    isVisible: () => true,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  poller.start()
  await clock.tick()
  await clock.tick()
  assert.deepEqual(errors, ['offline'])
  assert.equal(attempt, 2)
})

test('a sequence that goes backwards (database replaced) forces a full refresh', async () => {
  const clock = fakeClock()
  const updates = []
  const responses = [
    { sequence: 9, changes: [], agents: [] },
    { sequence: 2, changes: [], agents: [] },
  ]
  const poller = createChangePoller({
    fetchChanges: async () => responses.shift(),
    onUpdate: (update) => updates.push(update),
    isVisible: () => true,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  poller.start()
  await clock.tick()
  await clock.tick()
  assert.equal(updates[1].overflow, true)
})
