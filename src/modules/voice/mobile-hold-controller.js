/**
 * Keeps the mobile press-and-hold contract independent from transcription.
 * The shell provides the capture lifecycle; this controller only ensures a
 * deliberate primary press starts it and release finalizes the same capture.
 */
export function createMobileHoldController({ start, finish, cancel = async () => {} }) {
  let holding = false

  return {
    async press(event) {
      if (event.button !== 0 || holding) return false
      holding = true
      await start()
      return true
    },
    async release() {
      if (!holding) return false
      holding = false
      await finish()
      return true
    },
    async cancel() {
      if (!holding) return false
      holding = false
      await cancel()
      return true
    },
  }
}
