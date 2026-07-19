import assert from 'node:assert/strict'
import test from 'node:test'

import { MastraAgent } from '@ag-ui/mastra'
import { Agent } from '@mastra/core/agent'

import { eventPolicy } from './event-policy.js'


test('wraps Mastra behind the framework-neutral AG-UI agent interface', () => {
  const adapter = new MastraAgent({
    resourceId: 'personal-note-spike',
    threadId: 'compatibility-only',
    agent: new Agent({
      id: 'ag-ui-compatibility',
      name: 'AG-UI compatibility agent',
      instructions: 'Return source-grounded observations only.',
      model: 'openai/gpt-4o-mini',
    }),
  })

  assert.equal(typeof adapter.runAgent, 'function')
  assert.equal(typeof adapter.subscribe, 'function')
  assert.deepEqual(adapter.messages, [])
})

test('keeps tool events proposal-only and local failures authoritative', () => {
  assert.equal(eventPolicy('TOOL_CALL_START'), 'show-proposed-action')
  assert.equal(eventPolicy('RUN_ERROR'), 'keep-local-result')
  assert.equal(eventPolicy('STATE_DELTA'), 'not-enabled')
  assert.equal(eventPolicy('UNKNOWN'), 'ignore')
})