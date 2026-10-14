import assert from 'node:assert/strict'
import test from 'node:test'
import { countWords, createFocusMode, focusShortcut, focusView } from './focus-mode.js'

test('the shortcut is Cmd+. on a Mac and Ctrl+. elsewhere, never with other modifiers', () => {
  assert.equal(focusShortcut({ key: '.', metaKey: true }, 'MacIntel'), true)
  assert.equal(focusShortcut({ key: '.', ctrlKey: true }, 'MacIntel'), false)
  assert.equal(focusShortcut({ key: '.', ctrlKey: true }, 'Linux x86_64'), true)
  assert.equal(focusShortcut({ key: '.', metaKey: true }, 'Linux x86_64'), false)
  assert.equal(focusShortcut({ key: '.', metaKey: true, shiftKey: true }, 'MacIntel'), false)
  assert.equal(focusShortcut({ key: '.', metaKey: true, altKey: true }, 'MacIntel'), false)
  assert.equal(focusShortcut({ key: ',', metaKey: true }, 'MacIntel'), false)
})

test('the text goes to the middle of the window, at its own size, a little below the top', () => {
  const view = focusView({ viewW: 1400, viewH: 900, text: { x: 80, y: 120, width: 640 }, scale: 1 })
  assert.equal(view.scale, 1)
  assert.equal(view.x, (1400 - 640) / 2 - 80)
  assert.equal(view.y, 96 - 120)
})

test('a zoomed canvas keeps the zoom the writing is shown at', () => {
  const view = focusView({ viewW: 1400, viewH: 800, text: { x: 100, y: 50, width: 500 }, scale: 2 })
  assert.equal(view.x, (1400 - 500 * 2) / 2 - 100 * 2)
  assert.equal(view.y, 96 - 50 * 2)
})

test('a text wider than the window starts at its left edge with a margin', () => {
  const view = focusView({ viewW: 400, viewH: 800, text: { x: 10, y: 0, width: 900 }, scale: 1 })
  assert.equal(view.x, 24 - 10)
})

test('words are counted like a person would', () => {
  assert.equal(countWords(''), 0)
  assert.equal(countWords('  one two\nthree\t four  '), 4)
  assert.equal(countWords(null), 0)
})

function harness({ canFocus = true } = {}) {
  const log = []
  let world = { tool: 'pen', zoom: 1.5, selection: ['a'], note: 'untouched' }
  const focus = createFocusMode({
    canFocus: () => canFocus,
    capture: () => structuredClone(world),
    enter: (saved) => { log.push(['enter', saved]); world = { tool: 'text', zoom: 1, selection: [], note: 'untouched' } },
    leave: (saved) => { log.push(['leave', saved]); world = structuredClone(saved) },
  })
  return { focus, log, world: () => world }
}

test('entering captures everything first, leaving gives exactly that back', () => {
  const { focus, log, world } = harness()
  assert.equal(focus.enter(), true)
  assert.equal(focus.active, true)
  assert.deepEqual(log[0][1], { tool: 'pen', zoom: 1.5, selection: ['a'], note: 'untouched' })
  assert.equal(world().tool, 'text')
  assert.equal(focus.leave(), true)
  assert.equal(focus.active, false)
  assert.deepEqual(world(), { tool: 'pen', zoom: 1.5, selection: ['a'], note: 'untouched' })
})

test('entering twice, or leaving when not in focus, does nothing', () => {
  const { focus, log } = harness()
  assert.equal(focus.leave(), false)
  focus.enter()
  assert.equal(focus.enter(), false)
  assert.equal(log.length, 1)
})

test('a note that cannot be focused refuses', () => {
  const { focus, log } = harness({ canFocus: false })
  assert.equal(focus.enter(), false)
  assert.equal(focus.active, false)
  assert.equal(log.length, 0)
})

test('toggle flips between the two', () => {
  const { focus } = harness()
  focus.toggle()
  assert.equal(focus.active, true)
  focus.toggle()
  assert.equal(focus.active, false)
})
