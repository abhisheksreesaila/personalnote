import assert from 'node:assert/strict'
import test from 'node:test'
import { NOTE_LINK, loadNoteLinks, noteLinkMarkdown, onNoteLinks, peekNoteLink } from './note-links.js'

const REF = `res_${'b'.repeat(32)}`
const GONE = `res_${'c'.repeat(32)}`

test('a link is Markdown with the title as its words, kept on one line', () => {
  assert.equal(noteLinkMarkdown(REF, 'Trip [draft]\nplan'), `[Trip draft plan](personal-note://note/${REF})`)
  assert.equal(noteLinkMarkdown(REF, ''), `[Untitled note](personal-note://note/${REF})`)
  const found = [...`See ${noteLinkMarkdown(REF, 'Trip')} now`.matchAll(NOTE_LINK)]
  assert.deepEqual(found.map((match) => [match[1], match[2]]), [['Trip', REF]])
})

test('the answers are asked for once, shared, and a gone note is null', async () => {
  const calls = []
  globalThis.fetch = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ [REF]: { id: 4, title: 'Trip', excerpt: 'words', secure: false, notebook: null }, [GONE]: null }) } }
  const heard = []
  onNoteLinks((refs) => heard.push(refs))
  assert.equal(peekNoteLink(REF), undefined)
  await loadNoteLinks([REF, GONE, REF])
  assert.equal(peekNoteLink(REF).title, 'Trip')
  assert.equal(peekNoteLink(GONE), null)
  await loadNoteLinks([REF, GONE])
  assert.deepEqual([calls.length, heard], [1, [[REF, GONE]]])
  await loadNoteLinks([REF], { fresh: true })
  assert.equal(calls.length, 2)
})

test('an unreachable server leaves the cards as they were', async () => {
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await loadNoteLinks([`res_${'d'.repeat(32)}`])
  assert.equal(peekNoteLink(`res_${'d'.repeat(32)}`), undefined)
})
