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

// ---- jam sessions (F-092): emoji, thumbs and ghosts are drawn as text, never as HTML ----
function renderJam(extra) {
  globalThis.document = { createElementNS: (_, name) => fakeElement(name) }
  const layers = { '[data-map-viewport]': fakeElement('g'), '[data-map-branches]': fakeElement('g'), '[data-map-nodes]': fakeElement('g') }
  const renderer = new MindMapRenderer({ querySelector: (selector) => layers[selector] })
  const documentValue = normalizeDocument({
    title: 'T',
    nodes: [
      { id: 'root', parentId: null, text: 'Root', x: 0, y: 0 },
      { id: 'child', parentId: 'root', text: 'Child', x: 260, y: -140, ...extra.child },
    ],
    ...extra.map,
  })
  renderer.render(documentValue, null)
  const all = (element) => [element, ...element.children.flatMap(all)]
  return { found: (test) => [...all(layers['[data-map-branches]']), ...all(layers['[data-map-nodes]'])].filter(test) }
}

test('a branch’s emoji is drawn in front of its words', () => {
  const { found } = renderJam({ child: { emoji: '🐕' } })
  assert.equal(found((e) => e.textContent === '🐕 Child').length, 1)
})

test('a thumb sits on the branch and carries its one-line reason as a tooltip', () => {
  const { found } = renderJam({ child: { vote: 'down', reason: 'Too <b>broad</b>' } })
  const [badge] = found((e) => e.attributes['data-vote'] === 'down')
  assert.equal(badge.children.find((c) => c.name === 'text').textContent, '👎')
  assert.equal(badge.children.find((c) => c.name === 'title').textContent, 'Too <b>broad</b>')
  assert.equal(badge.attributes['data-reason'], 'Too <b>broad</b>')
})

test('a ghost is drawn faint and dashed with its words as text and a Yes and a No', () => {
  const html = '<img src=x onerror=alert(1)>'
  const { found } = renderJam({ map: { ghosts: [{ id: 'g1', parentId: 'root', text: html, why: 'Because <b>x</b>' }] } })
  assert.equal(found((e) => e.attributes['data-ghost-id'] === 'g1' && !e.attributes['data-ghost-action']).length, 1)
  assert.equal(found((e) => e.textContent === html).length, 1)
  assert.equal(found((e) => e.innerHTML !== undefined).length, 0)
  assert.ok(found((e) => e.attributes['stroke-dasharray']).length >= 1)
  assert.deepEqual(found((e) => e.attributes['data-ghost-action']).map((e) => e.attributes['data-ghost-action']).sort(), ['no', 'yes'])
  assert.equal(found((e) => e.name === 'title' && e.textContent === 'Because <b>x</b>').length, 1)
})

// ---- F-105: the box fits its text ----
test('a long label is drawn on several lines inside a taller card', () => {
  const long = 'Renew the passport and then book the flights for the family trip'
  const card = (text) => renderJam({ child: { text } }).found((e) => e.attributes.class === 'map-idea-card')[0]
  const rows = renderJam({ child: { text: long } }).found((e) => e.name === 'tspan' && long.includes(e.textContent))
  assert.deepEqual(rows.map((row) => row.textContent), ['Renew the passport and then', 'book the flights for the', 'family trip'])
  assert.deepEqual(rows.map((row) => row.attributes.y), ['-23', '1', '25'])
  assert.equal(Number(card(long).attributes.height), 88)
  assert.equal(Number(card('Short').attributes.height), 40)
})

test('icons are drawn before the words in the node colour, and the card is wider for them', () => {
  const plain = renderJam({ child: { color: '#123456', text: 'Child task here' } })
  const iconed = renderJam({ child: { color: '#123456', text: 'Child task here', icons: ['flag', 'fire'] } })
  const icons = iconed.found((e) => e.attributes.class === 'map-node-icon')
  assert.deepEqual(icons.map((e) => e.attributes['data-icon']), ['flag', 'fire'])
  assert.deepEqual(icons.map((e) => e.attributes.stroke), ['#123456', '#123456'])
  const [first, second] = icons.map((e) => Number(/translate\((-?[\d.]+)/.exec(e.attributes.transform)[1]))
  const row = iconed.found((e) => e.name === 'tspan' && e.textContent === 'Child task here')[0]
  assert.ok(first < second && second < Number(row.attributes.x))
  const width = (r) => Number(r.found((e) => e.attributes.class === 'map-idea-card')[0].attributes.width)
  assert.equal(width(iconed), width(plain) + 44)
})
