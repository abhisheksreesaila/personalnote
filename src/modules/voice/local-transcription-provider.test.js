import assert from 'node:assert/strict'
import test from 'node:test'

import { float32ToPcm16, LocalTranscriptionProvider } from './local-transcription-provider.js'

class FakeWebSocket {
  static OPEN = 1

  constructor(endpoint) {
    this.endpoint = endpoint
    this.readyState = FakeWebSocket.OPEN
    this.sent = []
    queueMicrotask(() => this.onopen())
  }

  send(value) {
    this.sent.push(value)
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }

  emit(event) {
    this.onmessage({ data: JSON.stringify(event) })
  }
}

test('configures a local realtime transcription session', async () => {
  const provider = new LocalTranscriptionProvider({ WebSocketImpl: FakeWebSocket })
  await provider.connect({ language: 'en-US', sampleRate: 16000 })

  assert.equal(provider.socket.endpoint, 'ws://127.0.0.1:8080/v1/realtime')
  assert.deepEqual(JSON.parse(provider.socket.sent[0]), {
    type: 'session.update',
    session: {
      sample_rate: 16000,
      language: 'en-US',
      automatic_punctuation: true,
    },
  })
})

test('maps server delta and completed events to partial and final callbacks', async () => {
  const events = []
  const provider = new LocalTranscriptionProvider({ WebSocketImpl: FakeWebSocket })
  await provider.connect({
    onPartial: (text) => events.push(['partial', text]),
    onFinal: (text, words) => events.push(['final', text, words]),
  })

  provider.socket.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Meet' })
  provider.socket.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'Meet Maya tomorrow.',
    words: [{ word: 'Meet', start: 0, end: 0.2 }],
  })

  assert.deepEqual(events, [
    ['partial', 'Meet'],
    ['final', 'Meet Maya tomorrow.', [{ word: 'Meet', start: 0, end: 0.2 }]],
  ])
})

test('sends audio, commit, and clear through the documented protocol', async () => {
  const provider = new LocalTranscriptionProvider({ WebSocketImpl: FakeWebSocket })
  await provider.connect()
  const socket = provider.socket
  const audio = new Int16Array([1, -1]).buffer

  assert.equal(provider.sendAudio(audio), true)
  provider.finish()
  provider.cancel()

  assert.equal(socket.sent[1], audio)
  assert.deepEqual(JSON.parse(socket.sent[2]), { type: 'input_audio_buffer.commit' })
  assert.deepEqual(JSON.parse(socket.sent[3]), { type: 'input_audio_buffer.clear' })
})

test('disconnects without clearing committed audio', async () => {
  const provider = new LocalTranscriptionProvider({ WebSocketImpl: FakeWebSocket })
  await provider.connect()
  const socket = provider.socket

  provider.finish()
  provider.disconnect()

  assert.deepEqual(JSON.parse(socket.sent[1]), { type: 'input_audio_buffer.commit' })
  assert.equal(socket.sent.length, 2)
  assert.equal(provider.socket, null)
})

test('converts browser audio samples to signed PCM16', () => {
  assert.deepEqual([...float32ToPcm16(new Float32Array([-2, -0.5, 0, 0.5, 2]))], [
    -32768, -16384, 0, 16383, 32767,
  ])
})