import assert from 'node:assert/strict'
import test from 'node:test'

import { createMeaningClient, describeMeaning } from './meaning-setup.js'

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
