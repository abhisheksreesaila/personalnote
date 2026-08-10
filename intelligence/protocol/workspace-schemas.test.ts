import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { workspaceRequestSchema } from './workspace-schemas.js'


const fixtureUrl = new URL('../../tests/fixtures/workspace_protocol.json', import.meta.url)
const fixtures = JSON.parse(await readFile(fixtureUrl, 'utf-8')) as Record<string, unknown>

test('shared workspace protocol requests satisfy the TypeScript contract', () => {
  assert.equal(workspaceRequestSchema.parse(fixtures.describeRequest).operation, 'workspace.describe')
  assert.equal(workspaceRequestSchema.parse(fixtures.queryRequest).operation, 'workspace.query')
})

test('the Slice 1 contract rejects mutation operations', () => {
  const result = workspaceRequestSchema.safeParse({
    protocolVersion: '1',
    requestId: 'req_mutation',
    operation: 'proposal.create',
    input: {},
  })

  assert.equal(result.success, false)
})