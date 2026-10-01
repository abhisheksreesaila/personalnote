// Desktop-window wiring (F-022), loaded only when the page is opened with ?host=desktop.
// `handlers` come from main.js; this maps each menu command name (see commands.js) onto them and
// publishes window.personalNote.command / setFullscreen / setMacChrome for desktop.py to call.
import { createCommandDispatcher, runHistoryCommand } from './commands.js'
import { applyHostChrome, MAC_CHROME_CLASS, setMacFullscreen } from './hostChrome.js'

export function menuHandlers(h, runHistory = runHistoryCommand) {
  const skin = (id) => () => h.skin(id)
  return {
    'new-note': h.newNote,
    'quick-note': h.newNote,
    'export-backup': h.exportBackup,
    'export-markdown': h.exportMarkdown,
    print: h.print,
    settings: h.settings,
    undo: () => runHistory('undo', { noteHistory: h.history }),
    redo: () => runHistory('redo', { noteHistory: h.history }),
    'zoom-in': () => h.zoom(1),
    'zoom-out': () => h.zoom(-1),
    'zoom-fit': () => h.zoom('fit'),
    'skin-crayon': skin('crayon'),
    'skin-paper': skin('paper'),
    'skin-night': skin('night'),
    'speed-meter': h.speedMeter,
  }
}

export function installDesktopHost({ root, search, api, handlers, zoomWindow }) {
  applyHostChrome({ root, search, zoomWindow: () => { try { void zoomWindow?.() } catch { /* best effort */ } } })
  api.command = createCommandDispatcher(menuHandlers(handlers))
  api.setFullscreen = (on) => setMacFullscreen(root, on)
  api.setMacChrome = (on) => root.classList.toggle(MAC_CHROME_CLASS, Boolean(on))
  return api
}
