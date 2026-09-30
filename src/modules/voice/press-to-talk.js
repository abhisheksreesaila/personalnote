/**
 * Desktop mic button: hold it to talk and release to finish, or tap it once to keep
 * listening and tap again to stop. The shell owns the capture lifecycle via `toggle`.
 */
export function createPressToTalk({ toggle, isListening, holdMs = 450, now = () => performance.now() }) {
  let pressedAt = null
  let stopOnRelease = false

  return {
    async press() {
      if (isListening()) {
        stopOnRelease = true
        return
      }
      pressedAt = now()
      await toggle()
    },
    async release() {
      if (stopOnRelease) {
        stopOnRelease = false
        await toggle()
        return 'stopped'
      }
      if (pressedAt === null) return 'idle'
      const held = now() - pressedAt >= holdMs
      pressedAt = null
      if (!held) return 'listening'
      await toggle()
      return 'stopped'
    },
  }
}
