const DEFAULT_ENDPOINT = 'ws://127.0.0.1:8080/v1/realtime'

function eventText(event) {
  return String(event?.delta || event?.transcript || event?.text || '').trim()
}

export class LocalTranscriptionProvider {
  constructor({ endpoint = DEFAULT_ENDPOINT, WebSocketImpl = globalThis.WebSocket, connectionTimeout = 800 } = {}) {
    this.endpoint = endpoint
    this.WebSocketImpl = WebSocketImpl
    this.connectionTimeout = connectionTimeout
    this.socket = null
    this.handlers = null
  }

  connect({ language = 'auto', sampleRate = 16000, onPartial, onFinal, onError } = {}) {
    if (!this.WebSocketImpl) return Promise.reject(new Error('WebSocket is unavailable'))

    this.handlers = { onPartial, onFinal, onError }
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.endpoint)
      this.socket = socket
      let opened = false
      const timeout = setTimeout(() => {
        if (opened) return
        socket.close()
        reject(new Error('Local transcription service timed out'))
      }, this.connectionTimeout)

      socket.binaryType = 'arraybuffer'
      socket.onopen = () => {
        opened = true
        clearTimeout(timeout)
        socket.send(JSON.stringify({
          type: 'session.update',
          session: {
            sample_rate: sampleRate,
            language,
            automatic_punctuation: true,
          },
        }))
        resolve()
      }
      socket.onmessage = ({ data }) => this.#handleMessage(data)
      socket.onerror = () => {
        const error = new Error('Local transcription service is unavailable')
        if (opened) this.handlers?.onError?.(error)
        else {
          clearTimeout(timeout)
          reject(error)
        }
      }
      socket.onclose = () => {
        clearTimeout(timeout)
        if (this.socket === socket) this.socket = null
      }
    })
  }

  sendAudio(audio) {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) return false
    this.socket.send(audio)
    return true
  }

  finish() {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) return
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
  }

  disconnect() {
    this.socket?.close()
    this.socket = null
  }

  cancel() {
    if (!this.socket) return
    if (this.socket.readyState === this.WebSocketImpl.OPEN) {
      this.socket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }))
    }
    this.socket.close()
    this.socket = null
  }

  #handleMessage(data) {
    if (typeof data !== 'string') return
    let event
    try {
      event = JSON.parse(data)
    } catch {
      return
    }

    const text = eventText(event)
    if (event.type === 'conversation.item.input_audio_transcription.delta' && text) {
      this.handlers?.onPartial?.(text)
    } else if (event.type === 'conversation.item.input_audio_transcription.completed' && text) {
      this.handlers?.onFinal?.(text, event.words || [])
    } else if (event.type === 'error') {
      this.handlers?.onError?.(new Error(event.error?.message || 'Local transcription failed'))
    }
  }
}

export function float32ToPcm16(samples) {
  const pcm = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return pcm
}