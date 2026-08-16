export const VOICE_SCAN_HOLD_MS = 1800

export class VoiceScanGesture {
  constructor({ moveTolerance = 12 } = {}) {
    this.moveTolerance = moveTolerance
    this.reset()
  }

  begin(x, y) {
    this.origin = { x, y }
    this.holdComplete = false
    this.cancelled = false
  }

  move(x, y) {
    if (!this.origin || this.cancelled) return false
    if (Math.hypot(x - this.origin.x, y - this.origin.y) <= this.moveTolerance) return true
    this.cancelled = true
    return false
  }

  completeHold() {
    if (!this.origin || this.cancelled) return false
    this.holdComplete = true
    return true
  }

  release() {
    if (!this.origin || this.cancelled) {
      this.reset()
      return null
    }
    const intent = this.holdComplete ? 'scan' : 'dictate'
    this.reset()
    return intent
  }

  reset() {
    this.origin = null
    this.holdComplete = false
    this.cancelled = false
  }
}