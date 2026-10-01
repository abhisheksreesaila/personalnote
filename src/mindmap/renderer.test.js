import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeDocument } from './model.js'
import { MindMapRenderer } from './renderer.js'

function fakeElement(name) {
  return { name, attributes: {}, children: [], setAttribute(key, value) { this.attributes[key] = String(value) }, append(...items) { this.children.push(...items) }, replaceChildren() { this.children = [] } }
}

function renderBranch(childOverrides) {
  globalThis.document = { createElementNS: (_, name) => fakeElement(name) }
  const layers = { '[data-map-viewport]': fakeElement('g'), '[data-map-branches]': fakeElement('g'), '[data-map-nodes]': fakeElement('g') }
  const renderer = new MindMapRenderer({ querySelector: (selector) => layers[selector] })
  const documentValue = normalizeDocument({
    title: 'T',
    nodes: [
      { id: 'root', parentId: null, text: 'Root', x: 0, y: 0 },
      { id: 'child', parentId: 'root', text: 'Child', x: 260, y: -140, ...childOverrides },
    ],
  })
  renderer.render(documentValue, null)
  const paths = layers['[data-map-branches]'].children
  return { ribbon: paths.find((p) => p.attributes.class === 'map-branch-ribbon').attributes.d, centre: paths.find((p) => p.attributes.class === 'map-branch-hit').attributes.d }
}

test('saved curve, anchors and ports reach the branch geometry', () => {
  const plain = renderBranch({})
  assert.notEqual(renderBranch({ curve: 5 }).centre, plain.centre)
  assert.notEqual(renderBranch({ branchPorts: { source: 'right', target: 'left' } }).centre, plain.centre)
  const anchored = renderBranch({ branchAnchors: [{ t: 0.2, n: 0.5 }, { t: 0.8, n: -0.5 }] })
  assert.notEqual(anchored.centre, plain.centre)
  assert.notEqual(anchored.ribbon, plain.ribbon)
})
