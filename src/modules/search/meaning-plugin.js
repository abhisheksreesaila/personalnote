// The Search by meaning plugin (F-091, ADR 0006): the omnibar's "By meaning" group and the download row in Settings. The shell imports this file
// only while the plugin is on. Off, the group never appears and no request is made; the server's side (indexer thread, engine) follows the same
// switch (routes.py). Words search never waits on any of this.
//
// `shell`: { api, island, omni (the omnibar's state; this fills omni.meaningHits / meaningReady / meaningPending), renderOmni(), refreshIcons(), latestRequest(), setup }

import { createMeaningClient, describeMeaning, indexIsCatchingUp } from './meaning-setup.js'

const DEBOUNCE_MS = 250
const MIN_CHARS = 3
// "By meaning" (F-080) fills in below everything else, never blocking it: a quiet request after a pause in typing, aborted when the query
// changes, its answer dropped if it is not the newest. Without the download the server answers [] at once and nothing shows. When it is
// installed, a query with no other match shows nothing (not "Nothing matches") while the answer is on its way, for 6 s at most.
const WAIT_MS = 6000

export async function activateMeaning(shell) {
  const { api, omni } = shell
  const client = createMeaningClient(api)
  const { createIslandDownload, createSetupSection, renderSetupRow } = shell.setup
  const islandDownload = createIslandDownload(shell.island)
  const request = shell.latestRequest() // one request at a time (omnibar.js); handed over by the shell so this chunk does not pull the omnibar into a chunk of its own
  const listeners = new AbortController()
  let poll = null
  let timer
  let giveUp

  const section = createSetupSection({ name: 'meaning', label: 'Search by meaning', rowLabel: 'Find by meaning', icon: 'search', actions: ['download', 'cancel'] })
  document.querySelector('#ai-settings').before(section)
  shell.refreshIcons()

  const renderSetup = (status) => { renderSetupRow('meaning', describeMeaning(status)); islandDownload('meaning', 'Search by meaning', status) }
  async function refreshSetup() {
    clearTimeout(poll)
    let status
    try {
      status = await client.status()
    } catch {
      renderSetup({ state: 'error', error: 'The local server did not answer.' })
      return
    }
    renderSetup(status)
    if (status.state === 'downloading') poll = setTimeout(refreshSetup, 1000)
    else if (indexIsCatchingUp(status)) poll = setTimeout(refreshSetup, 3000)
  }
  async function setupAction(action) {
    try {
      renderSetup(await action(client))
    } catch (error) {
      renderSetup({ state: 'error', error: error.message })
      return
    }
    void refreshSetup()
  }
  section.querySelector('#meaning-download').addEventListener('click', () => void setupAction((meaning) => meaning.install()), { signal: listeners.signal })
  section.querySelector('#meaning-cancel').addEventListener('click', () => void setupAction((meaning) => meaning.cancel()), { signal: listeners.signal })

  function cancel() {
    clearTimeout(timer)
    clearTimeout(giveUp)
    request.cancel()
    omni.meaningPending = false
  }

  // The omnibar was opened: is the download installed (then a query waits for it) or not (then nothing is asked)?
  function open() {
    api('/search-meaning/status').then((status) => { omni.meaningReady = status.state === 'ready' }, () => { omni.meaningReady = false })
  }

  function queue(query) {
    cancel()
    if (query.length < MIN_CHARS) return
    omni.meaningPending = omni.meaningReady
    giveUp = setTimeout(() => {
      request.cancel() // after the wait an answer would only move the list under the cursor: drop it
      if (omni.meaningPending) { omni.meaningPending = false; shell.renderOmni() }
    }, WAIT_MS)
    timer = setTimeout(async () => {
      const mine = request.start()
      try {
        const hits = await api(`/search/meaning?q=${encodeURIComponent(query)}&limit=10`, { signal: mine.signal })
        if (!mine.current() || !omni.open) return
        omni.meaningHits = hits
      } catch {
        if (!mine.current()) return // aborted by a newer query; no answer: the omnibar stays as it is
      }
      omni.meaningPending = false
      shell.renderOmni()
    }, DEBOUNCE_MS)
  }

  void refreshSetup()
  if (omni.open) open()

  return {
    open,
    queue,
    cancel,
    onSettingsOpen: refreshSetup,
    // Off: the group goes (an open omnibar redraws without it), the pending request is dropped, the Settings row goes.
    dispose() {
      cancel()
      listeners.abort()
      clearTimeout(poll)
      islandDownload('meaning', 'Search by meaning', null)
      Object.assign(omni, { meaningHits: [], meaningReady: false, meaningPending: false })
      section.remove()
      if (omni.open) shell.renderOmni()
    },
  }
}
