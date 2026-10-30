// The pencil's scratch (F-107): quiet filtered noise whose loudness follows the pointer's speed. Made with Web Audio, no sound file, and it
// follows the system mute. Anything that stops it working (no audio, a blocked context) leaves the strike silent, never broken.
let audio

export function scratchSound() {
  try {
    audio ||= new (globalThis.AudioContext || globalThis.webkitAudioContext)()
    if (audio.state === 'suspended') audio.resume()
    const buffer = audio.createBuffer(1, audio.sampleRate / 2, audio.sampleRate)
    buffer.getChannelData(0).forEach((_, i, data) => { data[i] = Math.random() * 2 - 1 })
    const source = audio.createBufferSource()
    const filter = audio.createBiquadFilter()
    const gain = audio.createGain()
    source.buffer = buffer
    source.loop = true
    filter.type = 'bandpass'
    filter.frequency.value = 2800
    filter.Q.value = 0.9
    gain.gain.value = 0
    source.connect(filter).connect(gain).connect(audio.destination)
    source.start()
    return {
      speed: (pixelsPerMs) => gain.gain.setTargetAtTime(Math.min(0.06, pixelsPerMs * 0.03), audio.currentTime, 0.03),
      stop() {
        gain.gain.setTargetAtTime(0, audio.currentTime, 0.05)
        source.stop(audio.currentTime + 0.3)
      },
    }
  } catch {
    return { speed() {}, stop() {} }
  }
}
