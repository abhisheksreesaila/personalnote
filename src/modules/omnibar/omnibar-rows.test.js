import assert from 'node:assert/strict'
import test from 'node:test'
import { createRowHtml, noneHtml, previewHtml, rowHtml } from './omnibar-rows.js'

const NOW = Date.parse('2026-10-17T12:00:00Z')
const note = { kind: 'words', id: 20, resourceId: 'res_a', title: 'Lisbon trip', noteType: 'page', secure: false, excerpt: 'Flights for the spring trip to Lisbon', icon: { emoji: '✈️', tint: 2 }, notebookName: 'My Notes', notebookColor: '#b5603a', updatedAt: '2026-10-17 10:00:00', createdAt: '2026-10-02 08:00:00' }
const view = { tokens: ['trip'], sel: false, now: NOW, glyph: () => '', hint: 'unlock to open' }
const row = (item, extra = {}) => rowHtml(item, 3, { ...view, ...extra })

test('a note row shows its emoji tile, the title and snippet with the match marked, the notebook chip and when it was edited', () => {
  const html = row(note)
  assert.match(html, /<span class="nt" style="--t:var\(--sk-c2\)">✈️<\/span>/)
  assert.match(html, /<span class="omni-title">Lisbon <mark>trip<\/mark><\/span>/)
  assert.match(html, /<span class="omni-sub">Flights for the spring <mark>trip<\/mark> to Lisbon<\/span>/)
  assert.match(html, /<span class="omni-nb"><i style="background:#b5603a"><\/i>My Notes<\/span>/)
  assert.match(html, /<span class="omni-when">2 h ago<\/span>/)
  assert.match(html, /id="omni-row-3"/)
})

test('a note found only by meaning says so and names its notebook; a note with no snippet names its type', () => {
  const html = row({ ...note, kind: 'meaning', excerpt: '' })
  assert.match(html, /<span class="omni-tag">By meaning<\/span>/)
  assert.match(html, /<span class="omni-sub">My Notes<\/span>/)
  assert.doesNotMatch(row(note), /omni-tag/)
  assert.match(row({ ...note, kind: 'note', excerpt: '' }), /<span class="omni-sub">Page<\/span>/)
})

test('a secure note row has a lock, no snippet and no words of the note', () => {
  const html = row({ ...note, secure: true, excerpt: 'ZEBRA-CARD-4111', title: 'Card numbers' })
  assert.match(html, /data-lucide="lock"/)
  assert.match(html, /Secure note · unlock to open/)
  assert.doesNotMatch(html, /ZEBRA|4111|✈️/)
})

test('a notebook result wears the notebook icon and an action keeps a neutral tile', () => {
  const notebook = row({ kind: 'notebook', id: 1, name: 'Travel', color: '#2f9d8f', icon: 'emoji:🧳', noteCount: 3 }, { glyph: () => '<span class="nbi-e">🧳</span>' })
  assert.match(notebook, /<span class="nt" style="--t:#2f9d8f"><span class="nbi-e">🧳<\/span><\/span>/)
  assert.match(notebook, /Notebook · 3 notes/)
  const action = row({ kind: 'action', id: 'new-note', title: 'New note', icon: 'plus', keycap: 'Alt N' })
  assert.match(action, /<span class="nt omni-act"><i data-lucide="plus"><\/i><\/span>/)
  assert.match(action, /<kbd>Alt N<\/kbd>/)
})

test('nothing matching says so with the query escaped, and the New note row follows', () => {
  assert.match(noneHtml('<b>x</b>'), /Nothing matches “&lt;b&gt;x&lt;\/b&gt;”/)
  assert.match(noneHtml(''), /Nothing here yet/)
  assert.match(createRowHtml(0, 'x', true), /New note “x”/)
})

test('the preview shows emoji, title, notebook chip, first lines and type, edited and created', () => {
  const html = previewHtml(note, { tokens: ['trip'], now: NOW, text: 'Flights and hotels\nfor the trip' })
  assert.match(html, /✈️/)
  assert.match(html, /Lisbon trip/)
  assert.match(html, /My Notes/)
  assert.match(html, /Flights and hotels\nfor the <mark>trip<\/mark>/)
  assert.match(html, /<dt>Type<\/dt><dd>Page<\/dd>/)
  assert.match(html, /<dt>Edited<\/dt><dd>2 h ago<\/dd>/)
  assert.match(html, /<dt>Created<\/dt><dd>Oct 2<\/dd>/)
})

test('the preview of a secure note shows no words', () => {
  const html = previewHtml({ ...note, secure: true, title: 'Card numbers' }, { tokens: [], now: NOW, text: 'ZEBRA-CARD-4111' })
  assert.doesNotMatch(html, /ZEBRA|4111/)
  assert.match(html, /Secure note/)
})

test('the preview of a notebook is a small card: icon, name, section and note count', () => {
  const html = previewHtml({ kind: 'notebook', id: 1, name: 'Travel', color: '#2f9d8f', category: 'areas', noteCount: 3 }, { tokens: [], now: NOW, glyph: () => '<span class="nbi-e">🧳</span>' })
  assert.match(html, /🧳/)
  assert.match(html, /<h3>Travel<\/h3>/)
  assert.match(html, /Areas/)
  assert.match(html, /<dt>Notes<\/dt><dd>3<\/dd>/)
})

test('the preview of an action names it and says Enter runs it', () => {
  const html = previewHtml({ kind: 'action', id: 'focus', title: 'Focus mode', icon: 'focus' }, { tokens: [], now: NOW })
  assert.match(html, /<h3>Focus mode<\/h3>/)
  assert.match(html, /Press Enter to run it/)
})
