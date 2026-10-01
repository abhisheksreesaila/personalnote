import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_FONT_CHOICE, MONO_STACK, canvasFontFamily, fontChoice } from './fonts.js'

test('new text defaults to the monospace choice, drawn with Geist Mono and a monospace fallback', () => {
  assert.equal(DEFAULT_FONT_CHOICE, 'monospace')
  assert.equal(canvasFontFamily(DEFAULT_FONT_CHOICE), '"Geist Mono", monospace')
})

test('serif and sans choices are untouched, and the mono stack maps back to its choice', () => {
  assert.equal(canvasFontFamily('Source Serif 4'), 'Source Serif 4')
  assert.equal(canvasFontFamily('IBM Plex Sans'), 'IBM Plex Sans')
  assert.equal(fontChoice(MONO_STACK), 'monospace')
  assert.equal(fontChoice('monospace'), 'monospace')
  assert.equal(fontChoice('Source Serif 4'), 'Source Serif 4')
})
