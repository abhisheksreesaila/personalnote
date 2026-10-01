import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMAND_NAMES, createCommandDispatcher, runHistoryCommand } from './commands.js'
import { installDesktopHost, menuHandlers } from './host.js'
import { applyHostChrome, readHostChrome, setMacFullscreen } from './hostChrome.js'

function fakeDoc() {
  const made = []
  const part = () => ({ children: [], prepend(el) { this.children.unshift(el) } })
  const parts = { '.main-view': part(), '.sidebar': part() }
  return {
    made, parts,
    createElement: () => {
      const el = { className: '', attrs: {}, listeners: {}, setAttribute(k, v) { this.attrs[k] = v }, addEventListener(t, f) { this.listeners[t] = f } }
      made.push(el)
      return el
    },
    querySelector: (s) => parts[s] ?? null,
  }
}
function fakeRoot(doc) {
  const set = new Set()
  return { ownerDocument: doc, classList: { add: (c) => set.add(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) }, has: (c) => set.has(c) }
}

test('host flags: chrome=mac only counts inside the desktop app', () => {
  assert.deepEqual(readHostChrome('?host=desktop&chrome=mac'), { host: 'desktop', chrome: 'mac' })
  assert.deepEqual(readHostChrome('?host=desktop'), { host: 'desktop', chrome: '' })
  assert.deepEqual(readHostChrome('?chrome=mac'), { host: '', chrome: '' })
  assert.deepEqual(readHostChrome(''), { host: '', chrome: '' })
})

test('mac chrome marks the page and adds drag strips that zoom on double click', () => {
  const doc = fakeDoc(); const root = fakeRoot(doc); let zoomed = 0
  assert.equal(applyHostChrome({ root, doc, search: '?host=desktop&chrome=mac', zoomWindow: () => { zoomed += 1 } }), true)
  assert.ok(root.has('chrome-mac'))
  assert.equal(doc.parts['.main-view'].children.length, 1)
  assert.equal(doc.parts['.sidebar'].children.length, 1)
  const strip = doc.parts['.main-view'].children[0]
  assert.match(strip.className, /pywebview-drag-region/)
  assert.equal(strip.attrs['aria-hidden'], 'true')
  strip.listeners.dblclick()
  assert.equal(zoomed, 1)
})

test('browsers and the Linux window are left unchanged', () => {
  for (const search of ['', '?host=desktop']) {
    const doc = fakeDoc(); const root = fakeRoot(doc)
    assert.equal(applyHostChrome({ root, doc, search }), false)
    assert.equal(root.has('chrome-mac'), false)
    assert.equal(doc.made.length, 0)
  }
})

test('full screen drops and restores the reserved space', () => {
  const root = fakeRoot(fakeDoc())
  setMacFullscreen(root, true); assert.ok(root.has('chrome-mac-fullscreen'))
  setMacFullscreen(root, false); assert.equal(root.has('chrome-mac-fullscreen'), false)
})

test('commands run their handler; unknown names and failures are ignored', () => {
  const calls = []
  const handlers = Object.fromEntries(COMMAND_NAMES.map((name) => [name, () => calls.push(name)]))
  handlers.print = () => { throw new Error('boom') }
  const originalError = console.error; console.error = () => {}
  const command = createCommandDispatcher(handlers)
  assert.equal(command('new-note'), true)
  assert.equal(command('skin-night'), true)
  assert.equal(command('print'), false)
  assert.equal(command('rm -rf'), false)
  assert.equal(createCommandDispatcher({})('undo'), false)
  console.error = originalError
  assert.deepEqual(calls, ['new-note', 'skin-night'])
})

test('undo goes to the focused field, else to the note history', () => {
  const asked = []
  const doc = { activeElement: { tagName: 'INPUT' }, execCommand: (n) => { asked.push(['field', n]); return true } }
  runHistoryCommand('undo', { doc, noteHistory: (n) => asked.push(['note', n]) })
  doc.activeElement = { tagName: 'BODY' }
  runHistoryCommand('redo', { doc, noteHistory: (n) => asked.push(['note', n]) })
  assert.deepEqual(asked, [['field', 'undo'], ['note', 'redo']])
})

test('every command name is wired to a main.js handler', () => {
  const calls = []
  const record = (name) => (...args) => calls.push([name, ...args])
  const handlers = { newNote: record('newNote'), exportBackup: record('exportBackup'), exportMarkdown: record('exportMarkdown'), print: record('print'), settings: record('settings'), history: record('history'), zoom: record('zoom'), skin: record('skin'), speedMeter: record('speedMeter') }
  const wired = menuHandlers(handlers, (name, { noteHistory }) => noteHistory(name))
  assert.deepEqual(Object.keys(wired).sort(), [...COMMAND_NAMES].sort())
  for (const name of COMMAND_NAMES) wired[name]()
  assert.deepEqual(calls.filter(([n]) => n === 'zoom'), [['zoom', 1], ['zoom', -1], ['zoom', 'fit']])
  assert.deepEqual(calls.filter(([n]) => n === 'skin').map((c) => c[1]), ['crayon', 'paper', 'night'])
  assert.deepEqual(calls.filter(([n]) => n === 'history').map((c) => c[1]), ['undo', 'redo'])
})

test('installDesktopHost publishes the page API for desktop.py', () => {
  const doc = fakeDoc(); const root = fakeRoot(doc); const api = {}
  const handlers = { newNote: () => {}, exportBackup: () => {}, exportMarkdown: () => {}, print: () => {}, settings: () => {}, history: () => {}, zoom: () => {}, skin: () => {}, speedMeter: () => {} }
  installDesktopHost({ root, search: '?host=desktop&chrome=mac', api, handlers })
  assert.equal(typeof api.command, 'function')
  assert.equal(api.command('zoom-in'), true)
  assert.equal(api.command('nope'), false)
  assert.ok(root.has('chrome-mac'))
})
