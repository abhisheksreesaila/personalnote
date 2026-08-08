import assert from 'node:assert/strict'
import test from 'node:test'

import {
  conceptDiagramBounds,
  conceptEdgePath,
  conceptNodePath,
  proposeConceptDiagram,
  wrapConceptLabel,
} from './concept-diagram.js'


test('builds an editable concept-map plan from focused text', () => {
  const plan = proposeConceptDiagram([
    'Slow productivity. Do fewer things. Work at a natural pace. Obsess over quality.',
  ])

  assert.equal(plan.kind, 'concept-map')
  assert.equal(plan.title, 'Slow productivity')
  assert.deepEqual(plan.nodes.map(item => item.id), ['topic', 'idea-1', 'idea-2', 'idea-3'])
  assert.deepEqual(plan.edges, [
    { from: 'topic', to: 'idea-1' },
    { from: 'topic', to: 'idea-2' },
    { from: 'topic', to: 'idea-3' },
  ])
  assert.match(plan.summary, /editable concept map/)
})

test('uses separate selected text objects as concepts and removes duplicates', () => {
  const plan = proposeConceptDiagram([
    'Q-learning update',
    'Current state',
    'Choose an action',
    'Current state',
    'Observe reward',
    'Update Q value',
  ])

  assert.equal(plan.nodes[0].text, 'Q-learning update')
  assert.deepEqual(plan.nodes.slice(1).map(item => item.text), [
    'Current state',
    'Choose an action',
    'Observe reward',
    'Update Q value',
  ])
})

test('stays silent for a single ambiguous phrase', () => {
  assert.equal(proposeConceptDiagram(['Q algorithm']), null)
  assert.equal(proposeConceptDiagram([]), null)
})

test('reports diagram bounds at the requested canvas origin', () => {
  const plan = proposeConceptDiagram(['A system', 'Input', 'Process', 'Output'])
  assert.deepEqual(conceptDiagramBounds(plan, { left: 120, top: 240 }), {
    left: 120,
    top: 240,
    width: 620,
    height: 352,
    right: 740,
    bottom: 592,
  })
})

test('generates framework-neutral paths and wrapped labels for Fabric rendering', () => {
  const plan = proposeConceptDiagram(['Slow productivity', 'Do fewer things'])
  const origin = { left: 40, top: 80 }

  assert.match(conceptNodePath(plan.nodes[0], origin), /^M .+ C .+ Z$/)
  assert.match(conceptEdgePath(plan, plan.edges[0], origin), /^M .+ Q .+$/)
  assert.equal(wrapConceptLabel('Create artifacts of value through cognitive effort'), 'Create artifacts of\nvalue through\ncognitive effort')
})