import assert from 'node:assert/strict'
import test from 'node:test'

import { createMeaningClient, describeMeaning, indexIsCatchingUp } from './meaning-setup.js'

test('each state says what it is and offers only the actions that make sense', () => {
  const idle = describeMeaning({ state: 'not-installed', downloadLabel: 'about 315 MB' })
  assert.equal(idle.headline, 'Not installed')
  assert.equal(idle.download, 'Download (≈315 MB)')
  assert.equal(idle.cancel, null)
  assert.match(idle.detail, /nothing leaves this computer/i)

  assert.equal(describeMeaning({ state: 'not-installed', partialBytes: 5000 }).download, 'Resume download')

  const busy = describeMeaning({ state: 'downloading', percent: 42, phase: 'model' })
  assert.equal(busy.headline, 'Downloading 42%')
  assert.equal(busy.percent, 42)
  assert.equal(busy.download, null)
  assert.equal(busy.cancel, 'Cancel')
  assert.match(busy.detail, /Downloading the search model/)

  const ready = describeMeaning({ state: 'ready' })
  assert.equal(ready.headline, 'Ready')
  assert.equal(ready.download, null)
  assert.equal(ready.percent, null)
  assert.match(describeMeaning({ state: 'ready', engineError: 'The search engine did not become ready in time.' }).detail, /did not become ready/)

  const indexing = { state: 'ready', index: { indexed: 123, total: 130, error: '' } }
  assert.equal(describeMeaning(indexing).headline, 'Indexed 123 of 130 notes')
  assert.equal(describeMeaning({ state: 'ready', index: { indexed: 1, total: 1, error: '' } }).headline, 'Indexed 1 of 1 note')
  assert.match(describeMeaning({ state: 'ready', index: { indexed: 3, total: 9, error: 'The search engine did not answer. Try again.' } }).detail, /did not answer/)
  assert.equal(indexIsCatchingUp(indexing), true)
  assert.equal(indexIsCatchingUp({ ...indexing, index: { indexed: 130, total: 130, error: '' } }), false)
  assert.equal(indexIsCatchingUp({ ...indexing, index: { indexed: 3, total: 9, error: 'x' } }), false)

  const refused = { state: 'ready', index: { indexed: 129, total: 130, error: '', failed: 1 } }
  assert.equal(describeMeaning(refused).headline, 'Indexed 129 of 130 notes')
  assert.equal(describeMeaning(refused).detail, '1 note is too long to index.')
  assert.equal(describeMeaning({ state: 'ready', index: { indexed: 120, total: 130, error: '', failed: 10 } }).detail, '10 notes are too long to index.')
  assert.equal(indexIsCatchingUp(refused), false, 'a refused note is done as far as catching up goes')
  assert.equal(indexIsCatchingUp({ state: 'ready', index: { indexed: 100, total: 130, error: '', failed: 1 } }), true)

  const failed = describeMeaning({ state: 'error', error: 'Could not reach the download server.' })
  assert.equal(failed.headline, 'Error')
  assert.match(failed.detail, /Could not reach/)
  assert.equal(failed.download, 'Try again')
  assert.equal(describeMeaning({ state: 'error', error: 'x', partialBytes: 9 }).download, 'Resume download')

  const unsupported = describeMeaning({ state: 'unsupported' })
  assert.equal(unsupported.headline, 'Not available here')
  assert.equal(unsupported.download, null)
  assert.match(unsupported.detail, /Apple Silicon/)
})

test('the client reads status and starts or cancels the download with the header only this app sends', async () => {
  const seen = []
  const client = createMeaningClient(async (path, options = {}) => { seen.push([path, options.method || 'GET', options.headers]); return {} })
  await client.status()
  await client.install()
  await client.cancel()
  assert.deepEqual(seen.map(([path, method]) => `${method} ${path}`), ['GET /search-meaning/status', 'POST /search-meaning/install', 'POST /search-meaning/cancel'])
  assert.equal(seen[0][2], undefined)
  for (const [, , headers] of seen.slice(1)) assert.equal(headers['X-Personal-Note'], '1')
})
