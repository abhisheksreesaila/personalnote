import assert from 'node:assert/strict'
import test from 'node:test'

process.env.PERSONAL_NOTE_DISABLE_MODEL = '1'

const { executeTask } = await import('./executor.js')
const { selectProviderChain } = await import('../providers/registry.js')


const sampleCandidate = {
  noteId: 7,
  title: 'Launch timing',
  notebookName: 'My Notes',
  notebookColor: '#267A9D',
  excerpt: 'Maya preferred a September launch because of the partner event.',
  reason: 'Connected through launch and maya.',
  sourceUpdatedAt: '2026-07-18 00:00:00',
  score: 4,
  confidence: 0.84,
  mode: 'local-retrieval',
}

test('execute protocol returns deterministic rank-related output', async () => {
  const result = await executeTask({
    task: 'rank-related',
    input: {
      currentText: 'Talk to Maya about moving the launch to October.',
      candidates: [sampleCandidate],
    },
    preferences: { tier: 'local-first' },
  })

  assert.equal(result.protocolVersion, '1')
  assert.equal(result.task, 'rank-related')
  assert.equal(result.output.selectedId, 7)
  assert.equal(result.output.observation, 'Connected through launch and maya.')
  assert.equal(result.execution.executor, 'deterministic')
  assert.equal(result.mode, 'local-retrieval')
})

test('local-first without model uses deterministic chain only', () => {
  const chain = selectProviderChain({ tier: 'local-first', modelDisabled: false })
  assert.equal(chain.length, 1)
  assert.equal(chain[0].id, 'deterministic')
})

test('execute protocol returns deterministic scan-page output', async () => {
  const result = await executeTask({
    task: 'scan-page',
    input: {
      currentText: 'schedule something at 9 AM with Maya',
      segments: ['schedule something at 9 AM with Maya'],
      focusSegments: ['schedule something at 9 AM with Maya'],
      calendarDrafts: [{
        title: 'schedule something with Maya',
        startAt: '2026-07-31T09:00:00.000Z',
        dateText: 'at 9 AM',
        hasExplicitTime: true,
        durationMinutes: 60,
        priority: true,
      }],
      people: [],
      relatedCandidates: [sampleCandidate],
      actions: { canTidy: true, tidyFocused: false, tidyCount: 3 },
    },
    preferences: { tier: 'local-first' },
  })

  assert.equal(result.task, 'scan-page')
  assert.equal((result.output.related as { noteId: number }).noteId, 7)
  assert.equal(result.execution.executor, 'deterministic')
})

test('local-only rejects cloud-capable providers at chain level', () => {
  const chain = selectProviderChain({ tier: 'local-only', modelDisabled: false })
  assert.ok(chain.every(provider => provider.id === 'deterministic'))
})
