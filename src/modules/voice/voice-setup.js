// Voice setup: what Settings > Voice shows, and what the microphone button does when voice is not ready.
// The server owns the download and the engine (voice_runtime.py); this module only reads its status and
// turns it into words. Audio never passes through here.

// A custom header cannot be sent by another web page without a CORS preflight, which the server never answers,
// so only this app can start a download, start the engine or remove voice.
const APP_HEADER = { 'X-Personal-Note': '1' }

export function createVoiceClient(request) {
  return {
    status: () => request('/voice/status'),
    install: () => request('/voice/install', { method: 'POST', headers: APP_HEADER }),
    cancel: () => request('/voice/cancel', { method: 'POST', headers: APP_HEADER }),
    startEngine: () => request('/voice/engine/start', { method: 'POST', headers: APP_HEADER }),
    remove: () => request('/voice', { method: 'DELETE', headers: APP_HEADER }),
  }
}

const PHASES = { engine: 'Downloading the voice engine', model: 'Downloading the speech model', verifying: 'Checking the download' }

export function describeVoice(status) {
  const label = status?.downloadLabel || 'about 750 MB'
  switch (status?.state) {
    case 'unsupported':
      return {
        headline: 'Not available here',
        detail: 'Voice download works on a Mac with Apple Silicon and on 64-bit Linux. Dictation needs a local voice service on this system.',
        percent: null, download: null, cancel: null, remove: null,
      }
    case 'downloading':
      return {
        headline: `Downloading ${status.percent ?? 0}%`,
        detail: `${PHASES[status.phase] || 'Downloading voice'}. You can keep working. Cancel keeps what is downloaded, so you can resume later.`,
        percent: status.percent ?? 0, download: null, cancel: 'Cancel', remove: null,
      }
    case 'ready':
      return {
        headline: 'Ready',
        detail: [
          status.engineError || (status.running
            ? 'Runs on this computer. Hold the mic button to dictate. Audio is never stored.'
            : 'Runs on this computer and starts with the app. Audio is never stored.'),
          status.note,
        ].filter(Boolean).join(' '),
        percent: null, download: null, cancel: null, remove: 'Remove voice',
      }
    case 'error':
      return {
        headline: 'Error',
        detail: status.error || 'Voice could not be set up.',
        percent: null, download: status.partialBytes ? 'Resume download' : 'Try again', cancel: null, remove: 'Remove voice',
      }
    default:
      return {
        headline: 'Not installed',
        detail: `Dictation runs on this computer. Download the voice engine and model once (${label}); audio is never stored.`,
        percent: null,
        cancel: null,
        download: status?.partialBytes ? 'Resume download' : `Download voice (${label.replace('about ', '≈')})`,
        remove: status?.partialBytes ? 'Discard partial download' : null,
      }
  }
}

export function voiceBlockedMessage(status) {
  switch (status?.state) {
    case 'downloading': return `Voice is still downloading (${status.percent ?? 0}%). It will work when it finishes.`
    case 'error': return `Voice setup failed: ${status.error || 'unknown error'} Open Settings › Voice to try again.`
    default: return 'Voice is not installed yet. Download it in Settings › Voice (about 750 MB, one time).'
  }
}

/**
 * Decide how the microphone button gets its transcription service.
 *  - { endpoint }  the engine is running (started now if it was installed but stopped)
 *  - { legacy }    this system has no voice download (Windows, other CPUs) or the server cannot say:
 *                  keep the older behaviour of looking for a local service on the default port
 *  - { blocked }   voice is not ready: a short reason, and Settings > Voice should open
 */
export async function prepareLocalVoice(client, { onStarting } = {}) {
  let status
  try {
    status = await client.status()
  } catch {
    return { legacy: true }
  }
  if (status.state === 'unsupported') return { legacy: true }
  if (status.state !== 'ready') return { blocked: voiceBlockedMessage(status), status }
  if (!status.running || !status.endpoint) {
    onStarting?.()
    try {
      status = await client.startEngine()
    } catch (error) {
      return { blocked: `${error.message} Open Settings › Voice to reinstall it.`, status }
    }
  }
  return status.endpoint ? { endpoint: status.endpoint } : { blocked: 'The voice engine did not start. Open Settings › Voice.', status }
}
