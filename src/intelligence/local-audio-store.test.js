import assert from 'node:assert/strict'
import test from 'node:test'

import { DurableAudioSession } from './local-audio-store.js'

class MemoryAudioRepository {
  constructor() {
    this.sessions = []
    this.chunks = []
  }

  async putSession(session) {
    this.sessions.push({ ...session })
  }

  async putChunk(chunk) {
    this.chunks.push({ ...chunk })
  }
}

test('persists audio chunks in capture order', async () => {
  const repository = new MemoryAudioRepository()
  const session = await DurableAudioSession.start({
    noteId: 42,
    repository,
    createId: () => 'voice-session',
  })

  const first = new Int16Array([1, 2]).buffer
  const second = new Int16Array([3, 4]).buffer
  await Promise.all([session.append(first), session.append(second)])

  assert.deepEqual(repository.chunks.map((chunk) => chunk.index), [0, 1])
  assert.deepEqual([...new Int16Array(repository.chunks[0].data)], [1, 2])
  assert.deepEqual([...new Int16Array(repository.chunks[1].data)], [3, 4])
})

test('records completed session size and duration', async () => {
  const repository = new MemoryAudioRepository()
  let time = 1000
  const session = await DurableAudioSession.start({
    noteId: 7,
    sampleRate: 16000,
    repository,
    now: () => time,
    createId: () => 'voice-session',
  })

  await session.append(new ArrayBuffer(32000))
  time = 2100
  await session.finish()

  assert.deepEqual(repository.sessions.at(-1), {
    id: 'voice-session',
    noteId: 7,
    sampleRate: 16000,
    channels: 1,
    encoding: 'pcm_s16le',
    status: 'completed',
    startedAt: 1000,
    updatedAt: 2100,
    endedAt: 2100,
    chunkCount: 1,
    totalBytes: 32000,
    durationMs: 1000,
  })
})