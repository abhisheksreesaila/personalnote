import assert from 'node:assert/strict'
import test from 'node:test'

import { resampleAudio } from './microphone-pcm-capture.js'

test('keeps 16 kHz input unchanged', () => {
  const samples = new Float32Array([0, 0.5, -0.5])
  const output = resampleAudio(samples, 16000)

  assert.notEqual(output, samples)
  assert.deepEqual([...output], [...samples])
})

test('resamples browser audio to 16 kHz with linear interpolation', () => {
  const samples = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75])
  const output = resampleAudio(samples, 48000, 16000)

  assert.deepEqual([...output], [0, 0.75])
})