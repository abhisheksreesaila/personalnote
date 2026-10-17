import assert from 'node:assert/strict'
import test from 'node:test'

import { createJamSession } from './jam-session.js'

function harness({ ghosts = [], turn = async () => [{ op: 'add_branch', parentId: 'root', text: 'Stock' }] } = {}) {
  const log = { asked: [], applied: [], answered: [], faces: [] }
  const waiting = [...ghosts]
  const session = createJamSession({
    getMap: () => ({ title: 'Pet shop', nodes: [{ id: 'root', text: 'Pet shop' }] }),
    getGhosts: () => waiting,
    requestTurn: async (request) => { log.asked.push(request); return turn(request) },
    applyEdits: (edits) => log.applied.push(edits),
    answerGhost: (id, yes) => log.answered.push([id, yes]),
    onFace: (face) => log.faces.push(face),
  })
  return { session, log, face: () => log.faces.at(-1) }
}

test('a fresh jam invites you to talk', () => {
  const { session, face } = harness()
  session.start()
  assert.deepEqual(face(), { phase: 'idle', line: '', message: '' })
})

test('what you say is the live line, and Jam sends it as one turn with the map and the ghosts waiting', async () => {
  const { session, log, face } = harness({ ghosts: [{ id: 'g1', text: 'Loyalty card' }] })
  session.start()
  session.listening(true)
  session.heard('we sell food', { final: false })
  assert.deepEqual(face(), { phase: 'listening', line: 'we sell food', message: '' })
  session.heard('we sell food for dogs', { final: true })
  session.heard('and cats', { final: false })
  assert.equal(face().line, 'we sell food for dogs and cats')
  await session.jam()
  assert.deepEqual(log.asked, [{ map: { title: 'Pet shop', nodes: [{ id: 'root', text: 'Pet shop' }] }, transcript: 'we sell food for dogs and cats', ghosts: ['Loyalty card'] }])
  assert.deepEqual(log.applied, [[{ op: 'add_branch', parentId: 'root', text: 'Stock' }]])
  assert.deepEqual(face(), { phase: 'listening', line: '', message: '' })
})

test('saying jam at the end of a sentence sends the turn, without the word jam', async () => {
  const { session, log } = harness()
  session.start()
  session.heard('then there is delivery jam.', { final: true })
  await session.idle()
  assert.equal(log.asked[0].transcript, 'then there is delivery')
})

test('jam in the middle of a sentence is just a word', async () => {
  const { session, log } = harness()
  session.start()
  session.heard('strawberry jam sells well', { final: true })
  await session.idle()
  assert.deepEqual(log.asked, [])
  assert.equal(session.transcript(), 'strawberry jam sells well')
})

test('yes accepts the newest ghost and is not part of what Claude hears', async () => {
  const { session, log } = harness({ ghosts: [{ id: 'g1', text: 'One' }, { id: 'g2', text: 'Two' }] })
  session.start()
  session.heard('Yes.', { final: true })
  assert.deepEqual(log.answered, [['g2', true]])
  assert.equal(session.transcript(), '')
})

test('yes with no ghost waiting is only a word you said', () => {
  const { session, log } = harness()
  session.start()
  session.heard('yes', { final: true })
  assert.deepEqual(log.answered, [])
  assert.equal(session.transcript(), 'yes')
})

test('only one turn is out at a time; words said meanwhile wait for the next', async () => {
  let release
  const { session, log, face } = harness({ turn: () => new Promise((resolve) => { release = () => resolve([]) }) })
  session.start()
  session.heard('first idea', { final: true })
  const first = session.jam()
  assert.equal(face().phase, 'thinking')
  session.heard('second idea', { final: true })
  await session.jam()
  assert.equal(log.asked.length, 1)
  release()
  await first
  assert.equal(session.transcript(), 'second idea')
  assert.equal(face().line, 'second idea')
})

test('a brain error is said plainly, the map is untouched and Try again sends the same words', async () => {
  let fail = true
  const { session, log, face } = harness({ turn: async () => { if (fail) throw new Error('Claude Code took longer than 90 seconds; try again.'); return [] } })
  session.start()
  session.heard('some idea', { final: true })
  await session.jam()
  assert.deepEqual(face(), { phase: 'error', line: 'some idea', message: 'Claude Code took longer than 90 seconds; try again.' })
  assert.deepEqual(log.applied, [])
  fail = false
  await session.jam()
  assert.deepEqual(log.asked.map((ask) => ask.transcript), ['some idea', 'some idea'])
  assert.equal(face().phase, 'idle')
})

test('no model set up points at Settings', async () => {
  const error = Object.assign(new Error('Claude Code is not installed here. Install it and sign in, or pick another brain in Settings.'), { setup: true })
  const { session, face } = harness({ turn: async () => { throw error } })
  session.start()
  session.heard('some idea', { final: true })
  await session.jam()
  assert.deepEqual(face(), { phase: 'setup', line: 'some idea', message: 'Set up a model in Settings → AI.' })
})

test('jamming with nothing said asks you to talk, and asks nothing of the brain', async () => {
  const { session, log, face } = harness()
  session.start()
  await session.jam()
  assert.deepEqual(log.asked, [])
  assert.deepEqual(face(), { phase: 'error', line: '', message: 'Nothing to jam on yet: hold the mic and talk.' })
})

test('a turn that comes back after the map was closed changes nothing', async () => {
  let release
  const { session, log } = harness({ turn: () => new Promise((resolve) => { release = () => resolve([{ op: 'add_branch', parentId: 'root', text: 'Late' }]) }) })
  session.start()
  session.heard('some idea', { final: true })
  const pending = session.jam()
  session.dispose()
  release()
  await pending
  assert.deepEqual(log.applied, [])
})
