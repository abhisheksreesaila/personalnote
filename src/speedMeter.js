// Pure logic for the speed meter: engine and host detection, rolling frame statistics, the shortcut.
export function detectEngine({ userAgentData, userAgent = '' } = {}) {
  const brands = (userAgentData?.brands ?? []).map((entry) => entry.brand)
  if (brands.includes('Chromium')) return 'Chromium'
  if (/Firefox\//.test(userAgent)) return 'Firefox'
  if (/Chrome\/|Chromium\/|Edg\//.test(userAgent)) return 'Chromium'
  if (/AppleWebKit\//.test(userAgent)) return 'WebKit'
  return 'Unknown'
}

// Best effort: pywebview injects window.pywebview in the desktop app; a standalone or --app window has
// no browser menu bar. Anything else is called a browser.
export function detectHost({ pywebview, standalone, menubarVisible } = {}) {
  if (pywebview) return 'Desktop app'
  if (standalone || menubarVisible === false) return 'App window'
  return 'Browser'
}

export function createFrameStats(windowMs = 2000) {
  let times = []
  return {
    record(now) {
      times.push(now)
      const cutoff = now - windowMs
      let drop = 0
      while (drop < times.length - 1 && times[drop] < cutoff) drop += 1
      if (drop) times = times.slice(drop)
    },
    snapshot() {
      if (times.length < 2) return { fps: 0, slowestMs: 0 }
      let slowest = 0
      for (let i = 1; i < times.length; i += 1) slowest = Math.max(slowest, times[i] - times[i - 1])
      const span = times[times.length - 1] - times[0]
      return { fps: span > 0 ? ((times.length - 1) * 1000) / span : 0, slowestMs: slowest }
    },
    reset() { times = [] },
  }
}

export function isSpeedMeterShortcut(event, { blocked = false } = {}) {
  return Boolean(!blocked && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey
    && event.key.toLowerCase() === 'f')
}

// rAF loop that only exists while the meter is visible.
export function createSpeedMeter({ onUpdate, raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame, intervalMs = 500 }) {
  const stats = createFrameStats()
  let handle = null
  let lastReport = 0
  function frame(now) {
    stats.record(now)
    if (now - lastReport >= intervalMs) { lastReport = now; onUpdate(stats.snapshot()) }
    handle = raf(frame)
  }
  return {
    start() { if (handle === null) { stats.reset(); lastReport = 0; handle = raf(frame) } },
    stop() { if (handle !== null) { caf(handle); handle = null } },
    get running() { return handle !== null },
  }
}
