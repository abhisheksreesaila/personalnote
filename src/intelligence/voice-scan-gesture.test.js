import assert from 'node:assert/strict'
import test from 'node:test'

import { VoiceScanGesture } from './voice-scan-gesture.js'

test('a quick release keeps the default dictation action', () => {
  const gesture = new VoiceScanGesture()
  gesture.begin(40, 40)

  assert.equal(gesture.release(), 'dictate')
})

test('a completed hold changes release to a page scan', () => {
  const gesture = new VoiceScanGesture()
  gesture.begin(40, 40)

  assert.equal(gesture.completeHold(), true)
  assert.equal(gesture.release(), 'scan')
})

test('moving away cancels both actions', () => {
  const gesture = new VoiceScanGesture({ moveTolerance: 10 })
  gesture.begin(40, 40)

  assert.equal(gesture.move(55, 40), false)
  assert.equal(gesture.completeHold(), false)
  assert.equal(gesture.release(), null)
})