import assert from 'node:assert/strict'
import test from 'node:test'

import { acceptGhost, applyJamEdits, dismissGhost, ghostNodes, MAX_GHOSTS } from './jam.js'
import { BRANCH_COLORS, normalizeDocument } from './model.js'

const freshMap = () => normalizeDocument({
  title: 'Pet shop',
  rootId: 'root',
  nodes: [
    { id: 'root', parentId: null, text: 'Pet shop', x: 0, y: 0, color: '#ef684b' },
    { id: 'a', parentId: 'root', text: 'Customers', x: 260, y: 0, color: '#efad28' },
  ],
})
const branch = (parentId, text, extra = {}) => ({ op: 'add_branch', parentId, text, emoji: '', id: '', ...extra })
const byText = (map, text) => map.nodes.find((node) => node.text === text)

test('new branches hang off the named parent with the brain’s words and emoji', () => {
  const map = freshMap()
  applyJamEdits(map, [branch('a', 'Dog owners', { emoji: '🐕' })])
  const added = byText(map, 'Dog owners')
  assert.equal(added.parentId, 'a')
  assert.equal(added.emoji, '🐕')
  assert.equal(added.color, '#efad28') // a sub-branch keeps its main branch’s colour
})

test('each main branch gets its own colour', () => {
  const map = freshMap()
  applyJamEdits(map, [branch('root', 'Stock'), branch('root', 'Staff'), branch('root', 'Shop')])
  const colours = map.nodes.filter((node) => node.parentId === 'root').map((node) => node.color)
  assert.equal(new Set(colours).size, 4)
  colours.forEach((colour) => assert.ok(BRANCH_COLORS.includes(colour)))
})

test('a later edit can hang off a branch the same answer just added', () => {
  const map = freshMap()
  applyJamEdits(map, [branch('a', 'Dog owners', { id: 'n1' }), branch('n1', 'Weekend walkers')])
  assert.equal(byText(map, 'Weekend walkers').parentId, byText(map, 'Dog owners').id)
  assert.notEqual(byText(map, 'Dog owners').id, 'n1') // the brain’s id is only a handle; ids stay the map’s own
})

test('the person’s branches are never removed, renamed or moved', () => {
  const map = freshMap()
  const before = structuredClone(map.nodes)
  applyJamEdits(map, [
    branch('root', 'Stock'), branch('a', 'Dog owners'),
    { op: 'react', nodeId: 'a', vote: 'up', reason: 'Clear first audience' },
  ])
  for (const original of before) {
    const now = map.nodes.find((node) => node.id === original.id)
    for (const key of ['parentId', 'text', 'x', 'y', 'color']) assert.equal(now[key], original[key], `${original.id}.${key}`)
  }
})

test('a reaction puts a thumb and a one-line reason on the branch, and a new one replaces it', () => {
  const map = freshMap()
  applyJamEdits(map, [{ op: 'react', nodeId: 'a', vote: 'up', reason: 'Clear first audience' }])
  assert.deepEqual([byText(map, 'Customers').vote, byText(map, 'Customers').reason], ['up', 'Clear first audience'])
  applyJamEdits(map, [{ op: 'react', nodeId: 'a', vote: 'down', reason: 'Too broad' }])
  assert.deepEqual([byText(map, 'Customers').vote, byText(map, 'Customers').reason], ['down', 'Too broad'])
})

test('new branches never land on top of an existing one', () => {
  const map = freshMap()
  applyJamEdits(map, ['Stock', 'Staff', 'Shop', 'Pets', 'Food', 'Toys'].map((text) => branch('a', text)))
  const added = map.nodes.filter((node) => node.parentId === 'a')
  for (const node of added) {
    for (const other of map.nodes.filter((item) => item !== node)) {
      assert.ok(Math.abs(node.x - other.x) >= 150 || Math.abs(node.y - other.y) >= 56, `${node.text} sits on ${other.text}`)
    }
  }
})

test('ghosts wait beside the map without being part of it, three at most, oldest dropped first', () => {
  const map = freshMap()
  const ghost = (text) => ({ op: 'ghost', parentId: 'root', text, why: `why ${text}` })
  applyJamEdits(map, [ghost('One'), ghost('Two'), ghost('Three')])
  assert.deepEqual(map.ghosts.map((item) => item.text), ['One', 'Two', 'Three'])
  assert.equal(map.nodes.length, 2)
  applyJamEdits(map, [ghost('Four')])
  assert.equal(map.ghosts.length, MAX_GHOSTS)
  assert.deepEqual(map.ghosts.map((item) => item.text), ['Two', 'Three', 'Four'])
})

test('a ghost that repeats a branch already on the map is not offered', () => {
  const map = freshMap()
  applyJamEdits(map, [{ op: 'ghost', parentId: 'root', text: 'customers', why: 'again' }])
  assert.deepEqual(map.ghosts ?? [], [])
})

test('ghosts have places next to their parent, each its own', () => {
  const map = freshMap()
  applyJamEdits(map, [{ op: 'ghost', parentId: 'root', text: 'One', why: 'a' }, { op: 'ghost', parentId: 'root', text: 'Two', why: 'b' }])
  const [one, two] = ghostNodes(map)
  assert.notDeepEqual([one.x, one.y], [two.x, two.y])
  assert.equal(one.parentId, 'root')
  assert.ok(Math.abs(one.x) > 150)
})

test('yes turns a ghost into a real branch where it was, and it leaves the waiting list', () => {
  const map = freshMap()
  applyJamEdits(map, [{ op: 'ghost', parentId: 'root', text: 'Delivery', why: 'Heavy food' }])
  const [placed] = ghostNodes(map)
  acceptGhost(map, placed.id)
  assert.deepEqual(map.ghosts ?? [], [])
  const real = byText(map, 'Delivery')
  assert.deepEqual([real.parentId, real.x, real.y], ['root', placed.x, placed.y])
  assert.equal(real.vote, undefined)
})

test('no makes the ghost go and adds nothing', () => {
  const map = freshMap()
  applyJamEdits(map, [{ op: 'ghost', parentId: 'root', text: 'Delivery', why: 'Heavy food' }])
  dismissGhost(map, map.ghosts[0].id)
  assert.deepEqual(map.ghosts ?? [], [])
  assert.equal(map.nodes.length, 2)
})

test('emoji, thumbs, jam mode and waiting ghosts survive normalizing; junk does not', () => {
  const map = normalizeDocument({
    title: 'T', jam: true,
    nodes: [
      { id: 'r', parentId: null, text: 'R' },
      { id: 'c', parentId: 'r', text: 'C', emoji: '🐕', vote: 'up', reason: 'Good' },
      { id: 'd', parentId: 'r', text: 'D', emoji: 'not an emoji at all, far too long', vote: 'sideways', reason: 5 },
    ],
    ghosts: [{ id: 'g1', parentId: 'r', text: 'Idea', why: 'Because' }, { id: 'g2', parentId: 'missing', text: 'Orphan', why: 'x' }, 'junk'],
  })
  assert.equal(map.jam, true)
  assert.deepEqual([map.nodes[1].emoji, map.nodes[1].vote, map.nodes[1].reason], ['🐕', 'up', 'Good'])
  assert.deepEqual([map.nodes[2].emoji, map.nodes[2].vote, map.nodes[2].reason], [undefined, undefined, undefined])
  assert.deepEqual(map.ghosts.map((ghost) => ghost.text), ['Idea'])
})

test('an ordinary map gains no new keys by being normalized', () => {
  const map = normalizeDocument({ title: 'T', nodes: [{ id: 'r', parentId: null, text: 'R' }] })
  assert.equal('jam' in map, false)
  assert.equal('ghosts' in map, false)
  assert.equal('emoji' in map.nodes[0], false)
})
