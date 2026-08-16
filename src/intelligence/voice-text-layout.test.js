import assert from 'node:assert/strict'
import test from 'node:test'

import { pageBoundedTextLayout } from './voice-text-layout.js'

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