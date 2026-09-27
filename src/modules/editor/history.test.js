import assert from 'node:assert/strict'
import test from 'node:test'
import { flushPendingHistory } from './history.js'

test('flushing pending typing before an immediate editor action keeps typing as a separate undo step', () => {
  let canvasText = 'Draft'
  let pending = false
  const history = [canvasText]

  const commit = () => {
    if (history.at(-1) === canvasText) return false
    history.push(canvasText)
    return true
  }
  const scheduleTypingSnapshot = () => { pending = true }
  const cancelTypingSnapshot = () => { pending = false }

  canvasText = 'Draft  '
  scheduleTypingSnapshot()
  flushPendingHistory({ cancel: cancelTypingSnapshot, commit })

  canvasText = 'Draft'
  commit()

  assert.equal(pending, false)
  assert.deepEqual(history, ['Draft', 'Draft  ', 'Draft'])
  assert.equal(history.at(-2), 'Draft  ')
})
