import assert from 'node:assert/strict'
import test from 'node:test'

import { displayIcons, normalizeDocument, taskCounts } from './model.js'

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
test('done is kept only when true', () => {
  const nodes = normalizeDocument({ nodes: [
    { id: 'root', parentId: null, text: 'Root' },
    { id: 'a', parentId: 'root', text: 'A', done: true },
    { id: 'b', parentId: 'root', text: 'B', done: 'yes' },
  ] }).nodes
  assert.equal(nodes[1].done, true)
  assert.equal('done' in nodes[2], false)
})

test('a done node shows the check where its to-do box was, or in front when it had none', () => {
  assert.deepEqual(displayIcons({ icons: ['flag', 'todo'], done: true }), ['flag', 'done'])
  assert.deepEqual(displayIcons({ icons: ['flag'], done: true }), ['done', 'flag'])
  assert.deepEqual(displayIcons({ done: true }), ['done'])
  assert.deepEqual(displayIcons({ icons: ['todo'] }), ['todo'])
})

test('a node counts the tasks anywhere under it: a to-do box or a strike, not itself', () => {
  const map = normalizeDocument({ nodes: [
    { id: 'root', parentId: null, text: 'Root', icons: ['todo'] },
    { id: 'a', parentId: 'root', text: 'A', icons: ['todo'], done: true },
    { id: 'a1', parentId: 'a', text: 'A1', icons: ['todo'] },
    { id: 'a2', parentId: 'a', text: 'A2', done: true },
    { id: 'a3', parentId: 'a2', text: 'A3', icons: ['flag'] },
    { id: 'b', parentId: 'root', text: 'B', collapsed: true },
    { id: 'b1', parentId: 'b', text: 'B1', icons: ['todo'] },
  ] })
  assert.deepEqual(taskCounts(map, 'root'), { done: 2, total: 4 })
  assert.deepEqual(taskCounts(map, 'a'), { done: 1, total: 2 })
  assert.deepEqual(taskCounts(map, 'b'), { done: 0, total: 1 })
  assert.deepEqual(taskCounts(map, 'a3'), { done: 0, total: 0 })
})
