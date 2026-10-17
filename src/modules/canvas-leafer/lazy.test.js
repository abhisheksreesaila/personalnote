import assert from 'node:assert/strict'
import test from 'node:test'
import { lazyCanvas } from './lazy.js'

const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve }); return { promise, open } }

test('until the engine arrives the canvas answers as one with nothing on it, and says it is not ready', () => {
  const canvas = lazyCanvas(() => gate().promise)
  assert.equal(canvas.isReady(), false)
  assert.deepEqual(canvas.selection(), [])
  assert.deepEqual(canvas.selectedText(), [])
  assert.equal(canvas.isEditingText(), false)
  assert.equal(canvas.touchHit(10, 10), 'empty')
  assert.deepEqual(canvas.view(), { x: 0, y: 0, scale: 1 })
  assert.equal(canvas.followConnectors('doc'), 'doc')
  assert.equal(canvas.createText({ x: 1, y: 2 }), undefined) // placing is held by the shell (earlyPress), not made here
})

test('once the engine is there every call goes to it, and ready resolves with it', async () => {
  const { promise, open } = gate()
  const real = { selection: () => ['a'], view: () => ({ x: 5, y: 6, scale: 2 }) }
  const canvas = lazyCanvas(() => promise)
  open(real)
  assert.equal(await canvas.ready, real)
  assert.equal(canvas.isReady(), true)
  assert.deepEqual(canvas.selection(), ['a'])
  assert.deepEqual(canvas.view(), { x: 5, y: 6, scale: 2 })
})

test('a listener registered before the engine arrives is registered on it, once, when it does', async () => {
  const { promise, open } = gate()
  const heard = []
  const canvas = lazyCanvas(() => promise)
  canvas.onSelection('listener')
  assert.deepEqual(heard, [])
  open({ onSelection: (listener) => heard.push(listener) })
  await canvas.ready
  assert.deepEqual(heard, ['listener'])
})

test('a when... call made early waits for the engine and returns what the engine answers', async () => {
  const { promise, open } = gate()
  const canvas = lazyCanvas(() => promise)
  const settled = canvas.whenSettled()
  open({ whenSettled: () => 'drawn' })
  assert.equal(await settled, 'drawn')
})

test('an engine that does not arrive rejects ready, and the canvas stays empty', async () => {
  const canvas = lazyCanvas(() => Promise.reject(new Error('chunk gone')))
  await assert.rejects(canvas.ready, /chunk gone/)
  assert.equal(canvas.isReady(), false)
  assert.deepEqual(canvas.selection(), [])
})

test('the canvas is not a thenable: awaiting it, or resolving a promise with it, settles at once', async () => {
  const canvas = lazyCanvas(() => gate().promise)
  assert.equal(await canvas, canvas)
  assert.equal(await Promise.resolve(canvas), canvas)
})
