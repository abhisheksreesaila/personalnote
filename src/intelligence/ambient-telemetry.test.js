import assert from 'node:assert/strict'
import test from 'node:test'

import { AmbientTelemetry } from './ambient-telemetry.js'


test('measures an ambient suggestion from queue through interaction', () => {
  let now = 100
  const telemetry = new AmbientTelemetry(() => now)

  telemetry.queue()
  now = 1200
  telemetry.requestStarted()
  now = 1340
  telemetry.response({ retrievalMs: 8.2, enrichmentMs: 120.4, serverMs: 130, mode: 'mastra-model' })
  now = 1360
  const presented = telemetry.presented()

  assert.equal(presented.last.presentationMs, 1260)
  assert.equal(presented.last.requestMs, 140)
  assert.equal(presented.last.server.mode, 'mastra-model')

  now = 1600
  const interacted = telemetry.interaction('open')
  assert.equal(interacted.last.action, 'open')
  assert.equal(interacted.last.interactionMs, 240)
})

test('counts superseded work without retaining an incomplete sample', () => {
  const telemetry = new AmbientTelemetry(() => 10)

  telemetry.queue()
  telemetry.cancel()

  assert.deepEqual(telemetry.snapshot(), { cancellations: 1, last: null })
})

test('records a completed silent check separately from cancellation', () => {
  let now = 0
  const telemetry = new AmbientTelemetry(() => now)

  telemetry.queue()
  now = 1100
  telemetry.requestStarted()
  now = 1120
  telemetry.response({ serverMs: 15, mode: 'silent' })
  const result = telemetry.silent()

  assert.equal(result.last.outcome, 'silent')
  assert.equal(result.last.completionMs, 1120)
  assert.equal(result.cancellations, 0)
})