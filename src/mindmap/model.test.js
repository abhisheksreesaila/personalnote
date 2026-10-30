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

test('icons keep only the known names, once each, three at most, in order', () => {
  const nodes = normalizeDocument({ nodes: [
    { id: 'root', parentId: null, text: 'Root' },
    { id: 'a', parentId: 'root', text: 'A', icons: ['flag', 'bogus', 'flag', 'star', 'heart', 'fire'] },
    { id: 'b', parentId: 'root', text: 'B', icons: 'todo' },
    { id: 'c', parentId: 'root', text: 'C' },
  ] }).nodes
  assert.deepEqual(nodes[1].icons, ['flag', 'star', 'heart'])
  assert.equal('icons' in nodes[2], false)
  assert.equal('icons' in nodes[3], false)
})