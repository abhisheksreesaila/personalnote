// F-098: the canvas engine (Leafer and the scene) is a chunk of its own, fetched while the notes panel and the note's title are drawn. The shell
// talks to `lazyCanvas(...)` from the first line it runs: until the engine is there it answers like a canvas with nothing on it (no selection, not
// editing, no objects), so the handlers that ask never throw; once there, every call goes straight to the real canvas.
// What cannot be answered meanwhile is a press that places something: the shell holds that itself and places it when the engine arrives
// (main.js: `earlyPress`).

// Calls made before the engine arrives that are kept and made, in order, when it does: the listeners the shell registers once.
const REPLAYED = new Set(['onSelection'])

// What a canvas with nothing on it answers (a function is called to make the answer, so nothing is shared).
const EMPTY = {
  isEditingText: () => false,
  isCommitting: () => false,
  isLinking: () => false,
  isLocked: () => false,
  selectionLinked: () => false,
  allFolded: () => false,
  hasLinks: () => false,
  selection: () => [],
  selectedText: () => [],
  boxes: () => new Set(),
  sizeOf: () => ({}),
  view: () => ({ x: 0, y: 0, scale: 1 }),
  touchHit: () => 'empty',
  pageAt: () => ({ x: 0, y: 0 }),
  toggleFoldAt: () => false,
  editText: () => false,
  clearAll: () => false,
  addImages: () => [],
  textCaret: () => null,
  screenBox: () => null,
  flushText: () => null,
  followConnectors: (doc) => doc,
}

// `load()` resolves to the real canvas. `ready` resolves with it; `isReady()` says whether it is there yet.
export function lazyCanvas(load) {
  let real = null
  const replay = []
  const ready = load().then((canvas) => {
    real = canvas
    for (const [name, args] of replay.splice(0)) real[name](...args)
    return canvas
  })
  const waiting = (name) => (...args) => ready.then((canvas) => canvas[name]?.(...args))
  const handler = {
    get(_, name) {
      if (name === 'then' || typeof name === 'symbol') return real ? real[name] : undefined // (not a thenable: `await canvas` and a promise resolved with it must settle)
      if (name === 'ready') return ready
      if (name === 'isReady') return () => real !== null
      if (real) return real[name]
      if (REPLAYED.has(name)) return (...args) => { replay.push([name, args]) }
      if (/^when[A-Z]/.test(name)) return waiting(name)
      return EMPTY[name] ?? (() => undefined)
    },
  }
  return new Proxy({}, handler)
}
