import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeDocument } from './model.js'

const mapWithPorts = (branchPorts) => ({
  title: 'Ports',
  nodes: [
    { id: 'root', parentId: null, text: 'Root' },
    { id: 'child', parentId: 'root', text: 'Child', branchPorts },
  ],
})

test('normalizeDocument preserves valid branch endpoint ports', () => {
  const documentValue = normalizeDocument(mapWithPorts({ source: 'top', target: 'bottom' }))

  assert.deepEqual(documentValue.nodes[1].branchPorts, { source: 'top', target: 'bottom' })
})

test('normalizeDocument discards invalid branch endpoint ports', () => {
  const documentValue = normalizeDocument(mapWithPorts({ source: 'diagonal', target: 'left' }))

  assert.equal(documentValue.nodes[1].branchPorts, null)
})