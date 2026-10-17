import assert from 'node:assert/strict'
import test from 'node:test'

import { MicrophonePcmCapture, resampleAudio } from './microphone-pcm-capture.js'

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
test('an audio buffer queued when capture stops is dropped, not read from a cleared context', async () => {
  const track = { stop() {} }
  const node = { connect() {}, disconnect() {} }
  let processor
  class FakeContext {
    sampleRate = 16000
    destination = {}
    async resume() {}
    createMediaStreamSource() { return node }
    createScriptProcessor() { processor = { ...node }; return processor }
    async close() {}
  }
  const capture = new MicrophonePcmCapture({ mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) }, AudioContextImpl: FakeContext })
  const heard = []
  await capture.start((buffer) => heard.push(buffer.byteLength))
  const queued = { inputBuffer: { getChannelData: () => new Float32Array(4) } }
  processor.onaudioprocess(queued)
  await capture.stop()
  processor.onaudioprocess?.(queued)
  assert.deepEqual(heard, [8])
})
