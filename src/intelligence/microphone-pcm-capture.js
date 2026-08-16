import { float32ToPcm16 } from './local-transcription-provider.js'

export function resampleAudio(samples, sourceRate, targetRate = 16000) {
  if (sourceRate === targetRate) return samples.slice()
  const outputLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate))
  const output = new Float32Array(outputLength)
  const ratio = sourceRate / targetRate

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, samples.length - 1)
    const weight = position - left
    output[index] = samples[left] * (1 - weight) + samples[right] * weight
  }
  return output
}

export class MicrophonePcmCapture {
  constructor({ mediaDevices = navigator.mediaDevices, AudioContextImpl = window.AudioContext || window.webkitAudioContext } = {}) {
    this.mediaDevices = mediaDevices
    this.AudioContextImpl = AudioContextImpl
    this.stream = null
    this.context = null
    this.source = null
    this.processor = null
  }

  async start(onAudio) {
    if (!this.mediaDevices?.getUserMedia || !this.AudioContextImpl) {
      throw new Error('Microphone capture is unavailable')
    }

    this.stream = await this.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    this.context = new this.AudioContextImpl({ sampleRate: 16000 })
    await this.context.resume()
    this.source = this.context.createMediaStreamSource(this.stream)
    this.processor = this.context.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0)
      const resampled = resampleAudio(samples, this.context.sampleRate)
      onAudio(float32ToPcm16(resampled).buffer)
    }
    this.source.connect(this.processor)
    this.processor.connect(this.context.destination)
  }

  async stop() {
    this.processor?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    const context = this.context
    this.stream = null
    this.context = null
    this.source = null
    this.processor = null
    await context?.close()
  }
}