/**
 * Built-in desktop voice capture boundary.
 *
 * PCM exists only in memory long enough to stream to the loopback
 * transcription service. The module exposes no recorder or media store; its
 * sole durable output is transcript text returned through provider callbacks.
 */
export { LocalTranscriptionProvider } from './local-transcription-provider.js'
export { MicrophonePcmCapture } from './microphone-pcm-capture.js'
