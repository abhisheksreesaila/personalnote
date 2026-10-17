import assert from 'node:assert/strict'
import test from 'node:test'
import { iconOf } from '../library/notebook-icon.js'
import { CARD_SIZE, newNoteLink, noteLinkFace as face } from './note-link.js'

const noteLinkFace = (object, info) => face(object, info, iconOf)

const card = { noteRef: 'res_x', title: 'Lisbon trip' }
const notebook = { name: 'Travel', color: '#4D839C', icon: '' }

test('a card shows the live title, the first lines and the notebook icon', () => {
  const face = noteLinkFace(card, { title: 'Lisbon trip (2027)', excerpt: 'Harbour walk\nBuy tickets\nPack the camera\nFourth line', secure: false, notebook: { ...notebook, icon: 'emoji:✈️' } })
  assert.deepEqual(face, { state: 'ok', title: 'Lisbon trip (2027)', detail: 'Harbour walk · Buy tickets · Pack the camera', badge: { color: '#4D839C', glyph: '✈️' } })
})

test('a notebook without an emoji shows its first letter on its colour, the X notebook its X', () => {
  assert.equal(noteLinkFace(card, { title: 't', excerpt: '', secure: false, notebook }).badge.glyph, 'T')
  assert.equal(noteLinkFace(card, { title: 't', excerpt: '', secure: false, notebook: { ...notebook, name: 'X bookmarks', icon: 'brand:x' } }).badge.glyph, 'X')
})

test('a removed note says so, a secure note shows only its title', () => {
  assert.deepEqual(noteLinkFace(card, null), { state: 'removed', title: 'Note removed', detail: 'Lisbon trip', badge: { color: '#8a8a85', glyph: '×' } })
  const secure = noteLinkFace(card, { title: 'Card numbers', excerpt: 'never shown', secure: true, notebook })
  assert.deepEqual([secure.state, secure.title, secure.detail], ['secure', 'Card numbers', 'Secure note'])
})

test('before the server has answered the card shows the title it was linked with', () => {
  assert.deepEqual(noteLinkFace(card, undefined), { state: 'ok', title: 'Lisbon trip', detail: '', badge: { color: '#8a8a85', glyph: '·' } })
})

test('a new card is centred on the point', () => {
  const made = newNoteLink({ id: 'a', z: 3, point: { x: 500, y: 400 }, ref: 'res_x', title: 'Lisbon trip' })
  assert.deepEqual([made.type, made.noteRef, made.title, made.geometry.x, made.geometry.y, made.geometry.width, made.geometry.height], ['notelink', 'res_x', 'Lisbon trip', 500 - CARD_SIZE.width / 2, 400 - CARD_SIZE.height / 2, 280, 96])
})
