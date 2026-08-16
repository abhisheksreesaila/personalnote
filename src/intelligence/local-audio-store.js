const DATABASE_NAME = 'personal-note-audio'
const DATABASE_VERSION = 1
const SESSION_STORE = 'sessions'
const CHUNK_STORE = 'chunks'

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Local audio write failed'))
    transaction.onabort = () => reject(transaction.error || new Error('Local audio write was aborted'))
  })
}

export class IndexedDbAudioRepository {
  constructor({ indexedDBImpl = globalThis.indexedDB } = {}) {
    this.indexedDB = indexedDBImpl
    this.databasePromise = null
  }

  open() {
    if (this.databasePromise) return this.databasePromise
    if (!this.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'))

    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(SESSION_STORE)) {
          database.createObjectStore(SESSION_STORE, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(CHUNK_STORE)) {
          database.createObjectStore(CHUNK_STORE, { keyPath: ['sessionId', 'index'] })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('Local audio storage could not open'))
    })
    return this.databasePromise
  }

  async putSession(session) {
    const database = await this.open()
    const transaction = database.transaction(SESSION_STORE, 'readwrite')
    transaction.objectStore(SESSION_STORE).put(session)
    await transactionDone(transaction)
  }

  async putChunk(chunk) {
    const database = await this.open()
    const transaction = database.transaction(CHUNK_STORE, 'readwrite')
    transaction.objectStore(CHUNK_STORE).put(chunk)
    await transactionDone(transaction)
  }
}

export class DurableAudioSession {
  constructor({ repository, session, now = () => Date.now() }) {
    this.repository = repository
    this.session = session
    this.now = now
    this.nextChunkIndex = 0
    this.pendingWrite = Promise.resolve()
  }

  static async start({
    noteId,
    sampleRate = 16000,
    repository = new IndexedDbAudioRepository(),
    now = () => Date.now(),
    createId = () => crypto.randomUUID(),
  } = {}) {
    const startedAt = now()
    const session = {
      id: createId(),
      noteId,
      sampleRate,
      channels: 1,
      encoding: 'pcm_s16le',
      status: 'recording',
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
      chunkCount: 0,
      totalBytes: 0,
      durationMs: 0,
    }
    await repository.putSession(session)
    return new DurableAudioSession({ repository, session, now })
  }

  append(audio) {
    const data = audio.slice(0)
    const index = this.nextChunkIndex
    this.nextChunkIndex += 1
    this.pendingWrite = this.pendingWrite.then(async () => {
      await this.repository.putChunk({
        sessionId: this.session.id,
        index,
        data,
        byteLength: data.byteLength,
      })
      this.session.chunkCount += 1
      this.session.totalBytes += data.byteLength
      this.session.durationMs = Math.round(
        this.session.totalBytes / (this.session.sampleRate * this.session.channels * 2) * 1000,
      )
      this.session.updatedAt = this.now()
      await this.repository.putSession({ ...this.session })
    })
    return this.pendingWrite
  }

  flush() {
    return this.pendingWrite
  }

  finish(status = 'completed') {
    this.pendingWrite = this.pendingWrite.then(async () => {
      const endedAt = this.now()
      this.session.status = status
      this.session.updatedAt = endedAt
      this.session.endedAt = endedAt
      await this.repository.putSession({ ...this.session })
    })
    return this.pendingWrite
  }
}