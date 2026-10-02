import assert from 'node:assert/strict'
import test from 'node:test'

import { pageBoundedTextLayout, voiceInsertPoint } from './text-layout.js'

test('sizes voice text to the current page right margin', () => {
  assert.deepEqual(pageBoundedTextLayout({ x: 96, y: 140 }), {
    x: 96,
    y: 140,
    width: 700,
  })
})

test('keeps voice text inside a later page column', () => {
  assert.deepEqual(pageBoundedTextLayout({ x: 940, y: 140 }), {
    x: 940,
    y: 140,
    width: 716,
  })
})

test('preserves a usable width when dictation begins near a page edge', () => {
  assert.deepEqual(pageBoundedTextLayout({ x: 820, y: 140 }), {
    x: 576,
    y: 140,
    width: 220,
  })
})
test('a dictation box goes 42 px below the content, and at the top left of an empty note', () => {
  assert.deepEqual(voiceInsertPoint(null), { x: 96, y: 96 })
  assert.deepEqual(voiceInsertPoint({ left: 120, top: 40, right: 500, bottom: 300 }), { x: 120, y: 342 })
  assert.deepEqual(voiceInsertPoint({ left: 10, top: 0, right: 50, bottom: 20 }), { x: 64, y: 62 })
  assert.deepEqual(voiceInsertPoint({ left: 2000, top: 0, right: 2100, bottom: 20 }, { columns: 2 }), { x: 1460, y: 62 })
})
