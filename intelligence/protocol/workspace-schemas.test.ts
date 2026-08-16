import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { workspaceRequestSchema } from './workspace-schemas.js'


const fixtureUrl = new URL('../../tests/fixtures/workspace_protocol.json', import.meta.url)
const fixtures = JSON.parse(await readFile(fixtureUrl, 'utf-8')) as Record<string, unknown>

test('shared workspace protocol requests satisfy the TypeScript contract', () => {
  assert.equal(workspaceRequestSchema.parse(fixtures.describeRequest).operation, 'workspace.describe')
  assert.equal(workspaceRequestSchema.parse(fixtures.queryRequest).operation, 'workspace.query')
  assert.equal(workspaceRequestSchema.parse(fixtures.changesRequest).operation, 'changes.since')
})

test('the Slice 2 contract accepts proposal operations', () => {
  const result = workspaceRequestSchema.safeParse({
    protocolVersion: '1',
    requestId: 'req_mutation',
    operation: 'proposal.create',
    input: { idempotencyKey: 'classify-launch-plan', proposal: {} },
  })

  assert.equal(result.success, true)
})