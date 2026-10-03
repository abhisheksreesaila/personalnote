// The speed test (F-034): drives the real note on screen the way a person does (wheel, mouse, pen, keyboard events sent to the page, one per
// frame) and times what the screen does with them. It runs inside the app, so a result is the machine's own: its screen, its graphics
// card, its device pixel ratio. The same code is run by scripts/benchmark-f034.mjs in a test browser.
//
// What is measured, per scenario: the gap between animation frames (16.7 ms is 60 fps), and for the pen and typing also the time from the
// event to the frame that shows it. A scenario that cannot run (nothing to drag, no editor) is reported as not measured, never as fast.
//
// The driver knows nothing about main.js; `host` gives it the pieces:
//   workspace      the element that hears the wheel (pan, zoom)
//   canvasHost     the element the Leafer canvas lives in (mouse events go to what is under the point)
//   scene          the Leafer scene (screenBox, select, clearSelection, editText, view, stats)
//   edits          the note's history (undo, redo, stats)
//   inkSurface     the element the pen draws on
//   setTool(name)  switches the toolbar tool
//   setView({ zoom }) puts the view at the opening view ('fit') or 100% (1) and returns when it is there
//   pageToScreen(x, y) a page point -> client coordinates
import { summarize } from './report.js'

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
const after = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createSpeedTest({ host, onProgress = () => {}, now = () => performance.now() }) {
  let stopped = false
  let k = 1 // how much of each scenario is run: 1 is the full speed test, less is the quick version the render-mode comparison runs once per mode
  const n = (count) => Math.max(8, Math.round(count * k))
  // Before every step: stopped by the person, and (the host's guard) still on the stress note. Edits never land in any other note.
  const check = () => { if (stopped) throw Object.assign(new Error('stopped'), { stopped: true }); host.guard?.() }

  // Frame gaps while `run` goes on.
  async function gaps(run) {
    const list = []
    let last = now()
    let live = true
    const tick = (time) => { if (!live) return; list.push(time - last); last = time; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    try { await run() } finally { live = false }
    return list.slice(2)
  }

  // Event-to-frame times: `send()` makes one event and returns when it has been delivered; the time runs to the frame after it.
  async function latencies(send, count) {
    const list = []
    const waits = []
    for (let i = 0; i < count; i += 1) {
      check()
      const t0 = now()
      await send(i)
      waits.push(after().then(() => list.push(now() - t0)))
      await frame()
    }
    await Promise.all(waits)
    return list
  }

  const wheel = (target, { dx = 0, dy = 0, ctrl = false, x, y }) => target.dispatchEvent(new WheelEvent('wheel', { deltaX: dx, deltaY: dy, ctrlKey: ctrl, clientX: x, clientY: y, bubbles: true, cancelable: true, deltaMode: 0 }))

  const pointer = (target, type, { x, y, id = 1, kind = 'mouse', pressure = 0.5, buttons = 1 }) => target.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: kind, isPrimary: true, clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : buttons,
    pressure: type === 'pointerup' ? 0 : pressure, bubbles: true, cancelable: true, composed: true,
  }))

  const viewport = () => { const rect = host.workspace.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }

  async function pan() {
    const box = viewport()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    return gaps(async () => {
      const total = n(120)
      for (let i = 0; i < total; i += 1) { check(); wheel(host.workspace, { dx: i < total / 2 ? 6 : -6, dy: i < total / 2 ? 24 : -24, x, y }); await frame() }
    })
  }

  async function zoom() {
    const box = viewport()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    return gaps(async () => {
      const total = n(120)
      for (let i = 0; i < total; i += 1) { check(); wheel(host.workspace, { dy: i < total / 2 ? -12 : 12, ctrl: true, x, y }); await frame() }
    })
  }

  // Objects fully on screen (away from the toolbars), by type.
  function visible(types) {
    const rect = host.canvasHost.getBoundingClientRect()
    const out = []
    for (const object of host.edits.doc.objects) {
      if (!types.includes(object.type)) continue
      const box = host.scene.screenBox(object.id)
      if (!box) continue
      const left = rect.left + box.x
      const top = rect.top + box.y
      const under = document.elementFromPoint(left + box.width / 2, top + box.height / 2)
      if (under && !host.canvasHost.contains(under)) continue // something (the speed test's own panel) is over it
      if (left > rect.left + 120 && top > rect.top + 80 && left + box.width < rect.right - 120 && top + box.height < rect.bottom - 120 && box.width > 14 && box.height > 14) {
        out.push({ id: object.id, x: left + box.width / 2, y: top + box.height / 2, width: box.width, height: box.height })
      }
    }
    return out
  }
  const find = (id, types) => visible(types).find((entry) => entry.id === id)

  async function press(point) {
    check()
    const target = document.elementFromPoint(point.x, point.y) ?? host.canvasHost
    pointer(target, 'pointerdown', point)
    await frame()
    return target
  }

  async function dragTo(from, to, steps) {
    const target = await press(from)
    for (let i = 1; i <= steps; i += 1) {
      check()
      const t = i / steps
      pointer(target, 'pointermove', { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t + Math.sin(t * Math.PI * 2) * 30 })
      await frame()
    }
    pointer(target, 'pointerup', { x: to.x, y: to.y })
    await frame()
  }

  async function click(point) {
    const target = await press(point)
    pointer(target, 'pointerup', point)
    await frame()
  }

  async function drag() {
    const out = {}
    const picks = visible(['sticky', 'shape'])
    const one = picks[Math.floor(picks.length / 2)]
    if (!one) return { failed: 'nothing to drag in view' }
    await click(one)
    out.one = await gaps(() => dragTo(one, { x: one.x + 160, y: one.y + 90 }, n(90)))
    const crowd = visible(['sticky', 'shape', 'text']).slice(0, 40)
    host.scene.select(crowd.map((entry) => entry.id))
    await frame()
    const lead = find(crowd[0].id, ['sticky', 'shape', 'text']) ?? crowd[0]
    out.many = await gaps(() => dragTo(lead, { x: lead.x + 120, y: lead.y + 70 }, n(60)))
    out.crowd = crowd.length
    host.scene.clearSelection()
    return out
  }

  // Many separate drags make many undo steps, then undo and redo run back and forth over them.
  async function undo() {
    const movers = visible(['sticky', 'shape', 'text']).slice(0, 30)
    const before = host.edits.stats().undoSteps
    for (const mover of movers) {
      check()
      const current = find(mover.id, ['sticky', 'shape', 'text'])
      if (!current) continue
      await click(current)
      await dragTo(current, { x: current.x + 25, y: current.y + 15 }, 6)
    }
    host.scene.clearSelection()
    const steps = host.edits.stats().undoSteps - before
    if (steps < 5) return { failed: 'the drags made no undo steps' }
    const out = {}
    for (const kind of ['undo', 'redo']) {
      const calls = []
      const toFrame = []
      for (let i = 0; i < Math.min(25, steps); i += 1) {
        check()
        const t = now()
        host.edits[kind]()
        calls.push(now() - t)
        await after()
        toFrame.push(now() - t)
      }
      out[kind] = { calls, toFrame }
    }
    return out
  }

  async function pen() {
    host.setTool('pen')
    await sleep(150)
    const target = host.inkSurface
    const rect = host.canvasHost.getBoundingClientRect()
    const gapList = []
    const lat = []
    const gapsRun = gaps(async () => {
      for (let s = 0; s < (k < 1 ? 1 : 4); s += 1) {
        const x0 = rect.left + 200 + s * 14
        const y0 = rect.top + 160 + s * 60
        const point = (i) => ({ x: x0 + (360 * i) / 60, y: y0 + Math.sin((i / 60) * Math.PI * 2) * 50, kind: 'pen', pressure: 0.3 + 0.6 * Math.sin((i / 60) * Math.PI) })
        pointer(target, 'pointerdown', point(0))
        await frame()
        const part = await latencies((i) => pointer(target, 'pointermove', point(i + 1)), 60)
        lat.push(...part)
        pointer(target, 'pointerup', point(60))
        await frame()
      }
    })
    gapList.push(...await gapsRun)
    host.setTool('select')
    return { frames: gapList, lat }
  }

  const TEXT = 'The quick brown fox jumps over the lazy dog, and then types a few more words to fill a line or two. '
  async function typing() {
    const target = host.edits.doc.objects.findLast((object) => object.type === 'text')
    if (!target) return { failed: 'no text in the note to type into' }
    host.scene.editText(target.id)
    await sleep(150)
    const area = document.querySelector('.leafer-text-editor')
    if (!area) return { failed: 'the text editor did not open' }
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
    let lat = []
    const list = await gaps(async () => {
      lat = await latencies((i) => { area.dispatchEvent(new KeyboardEvent('keydown', { key: TEXT[i % TEXT.length], bubbles: true })); document.execCommand('insertText', false, TEXT[i % TEXT.length]) }, n(80))
    })
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await sleep(100)
    return { frames: list, lat }
  }

  async function run() {
    stopped = false
    const results = []
    const failed = []
    const add = (name, values, extra = {}) => results.push({ name, ...summarize(values), ...extra })
    const steps = ['Pan (whole desk, zoomed out)', 'Zoom', 'Pan (100%)', 'Drag one object', 'Drag 40 objects', 'Undo and redo', 'Pen (frames)', 'Pen (input to frame)', 'Typing (frames)', 'Typing (key to frame)']
    let done = 0
    const step = (name) => { check(); onProgress({ name, done, total: 8 }); done += 1 }
    try {
      await host.setView({ zoom: 'fit' })
      await sleep(400)
      step('Pan, whole desk zoomed out')
      add(steps[0], await pan())
      step('Zoom in and out')
      add(steps[1], await zoom())
      await host.setView({ zoom: 1 })
      await sleep(500)
      step('Pan at 100%')
      add(steps[2], await pan())
      step('Drag')
      const dragged = await drag()
      if (dragged.failed) failed.push(`Drag: ${dragged.failed}`)
      else { add(steps[3], dragged.one); add(`Drag ${dragged.crowd} objects`, dragged.many) }
      step('Undo and redo')
      const undone = await undo()
      if (undone.failed) failed.push(`Undo: ${undone.failed}`)
      else {
        add('Undo (the call, ms)', undone.undo.calls, { unit: 'ms' })
        add('Undo (to the next frame, ms)', undone.undo.toFrame, { unit: 'ms' })
        add('Redo (to the next frame, ms)', undone.redo.toFrame, { unit: 'ms' })
      }
      await sleep(300)
      step('Pen')
      const pen1 = await pen()
      add(steps[6], pen1.frames)
      add(steps[7], pen1.lat, { unit: 'ms' })
      step('Typing')
      const typed = await typing()
      if (typed.failed) failed.push(`Typing: ${typed.failed}`)
      else { add(steps[8], typed.frames); add(steps[9], typed.lat, { unit: 'ms' }) }
      onProgress({ name: 'Done', done: 8, total: 8 })
    } catch (error) {
      if (!error.stopped) throw error
      failed.push('stopped before the end')
    } finally {
      host.scene.clearSelection()
    }
    return { results, failed }
  }

  // The quick version for the render-mode comparison: pan, zoom, drag, pen and typing on the note that is open, one row each (named for the table).
  async function runQuick() {
    k = 0.35 // (a stop pressed earlier stays: only the session starts un-stopped, see `reset`)
    const rows = {}
    const failed = []
    const add = (name, values, unit) => { rows[name] = { ...summarize(values), ...(unit ? { unit } : {}) } }
    try {
      await host.setView({ zoom: 'fit' })
      await sleep(300)
      check(); add('Pan (zoomed out)', await pan())
      check(); add('Zoom', await zoom())
      await host.setView({ zoom: 1 })
      await sleep(300)
      check(); add('Pan (100%)', await pan())
      check()
      const dragged = await drag()
      if (dragged.failed) failed.push(`Drag: ${dragged.failed}`)
      else { add('Drag one object', dragged.one); add('Drag many objects', dragged.many) }
      check()
      const pen1 = await pen()
      add('Pen (frames)', pen1.frames)
      add('Pen (input to frame)', pen1.lat, 'ms')
      check()
      const typed = await typing()
      if (typed.failed) failed.push(`Typing: ${typed.failed}`)
      else { add('Typing (frames)', typed.frames); add('Typing (key to frame)', typed.lat, 'ms') }
    } finally {
      k = 1
      host.scene.clearSelection()
    }
    return { rows, failed }
  }

  // Unmeasured: the same kind of moves as the scenarios, so the first measured run after a mode switch does not pay for warming up (new bitmaps,
  // first draws, shader and cache fills).
  async function warm() {
    k = 0.35
    try {
      await host.setView({ zoom: 'fit' })
      await sleep(200)
      check(); await pan()
      await host.setView({ zoom: 1 })
      await sleep(200)
      check(); await pan()
    } finally { k = 1 }
  }

  return { run, runQuick, warm, check, reset() { stopped = false }, stop() { stopped = true } }
}
