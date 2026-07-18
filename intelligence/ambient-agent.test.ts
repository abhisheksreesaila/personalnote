import assert from 'node:assert/strict'
import test from 'node:test'

import { rankCandidates } from './ambient-agent.js'


test('returns the grounded first candidate without a configured model', async () => {
  const result = await rankCandidates({
    currentText: 'Talk to Maya about moving the launch to October.',
    candidates: [{
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
    }],
  })

  assert.deepEqual(result, {
    selectedId: 7,
    observation: 'Connected through launch and maya.',
    mode: 'local-retrieval',
  })
})