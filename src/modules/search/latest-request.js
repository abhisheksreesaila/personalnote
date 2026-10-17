/** One request at a time: starting a new one aborts the one before, and `current()` says whether this one is still the newest. */
export function latestRequest() {
  let controller = null
  return {
    start() {
      controller?.abort()
      const mine = (controller = new AbortController())
      return { signal: mine.signal, current: () => controller === mine }
    },
    cancel() {
      controller?.abort()
      controller = null
    },
  }
}
