// Search by meaning setup: what Settings shows for the optional download. The server owns the download and the engine
// (search_runtime.py); this module only reads its status and turns it into words.

const APP_HEADER = { 'X-Personal-Note': '1' } // a custom header cannot be sent cross-site without a preflight the server never answers

export function createMeaningClient(request) {
  return {
    status: () => request('/search-meaning/status'),
    install: () => request('/search-meaning/install', { method: 'POST', headers: APP_HEADER }),
    cancel: () => request('/search-meaning/cancel', { method: 'POST', headers: APP_HEADER }),
  }
}

const PHASES = { engine: 'Downloading the search engine', model: 'Downloading the search model', verifying: 'Checking the download' }

export function describeMeaning(status) {
  const label = (status?.downloadLabel || 'about 315 MB').replace('about ', '≈')
  const resume = status?.partialBytes ? 'Resume download' : null
  switch (status?.state) {
    case 'unsupported':
      return { headline: 'Not available here', detail: 'Search by meaning works on a Mac with Apple Silicon and on 64-bit Linux.', percent: null, download: null, cancel: null }
    case 'downloading':
      return { headline: `Downloading ${status.percent ?? 0}%`, detail: `${PHASES[status.phase] || 'Downloading'}. You can keep working. Cancel keeps what is downloaded, so you can resume later.`, percent: status.percent ?? 0, download: null, cancel: 'Cancel' }
    case 'ready': {
      const index = status.index
      const headline = index?.total ? `Indexed ${index.indexed} of ${index.total} ${index.total === 1 ? 'note' : 'notes'}` : 'Ready'
      const refused = index?.failed ? (index.failed === 1 ? '1 note is too long to index.' : `${index.failed} notes are too long to index.`) : ''
      return { headline, detail: index?.error || status.engineError || refused || 'Runs on this computer, only while the app is open. Nothing leaves this computer.', percent: null, download: null, cancel: null }
    }
    case 'error':
      return { headline: 'Error', detail: status.error || 'Search by meaning could not be set up.', percent: null, download: resume || 'Try again', cancel: null }
    default:
      return { headline: 'Not installed', detail: 'Find notes by what they mean, not only the words in them. It runs on this computer and nothing leaves this computer.', percent: null, download: resume || `Download (${label})`, cancel: null }
  }
}

// Notes are indexed in the background after the download; keep the count moving until it catches up (or the engine failed).
export const indexIsCatchingUp = (status) => status?.state === 'ready' && !status.index?.error && status.index?.indexed + (status.index?.failed || 0) < status.index?.total
