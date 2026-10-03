// The speed test (F-034): the panel, the stress note it measures, and the report. Loaded when the test is run (Settings, the View menu, or
// the page opened with ?speedtest=1 by `npm run speedtest`); nothing of it is in the app's first load.
//
// The test runs on a note of its own (a generated stress note of 5,000+ objects in a notebook the person already has, named "Speed test (safe to
// delete)", removed when the test ends) and saves nothing while it runs, so no note of the person's is touched. The results are shown, can be
// copied as text, and are saved to a file in the app's data folder.
import { createSpeedTest } from './driver.js'
import { comparisonRows, formatComparison, formatReport, mergeRuns, verdict } from './report.js'
import { generateStressNote } from './stress-note.js'

const STRESS_OBJECTS = 5400
const REALISTIC_OBJECTS = 600 // a busy but ordinary desk, for the render-mode comparison
const NOTE_TITLE = 'Speed test (safe to delete)'
// The render modes the comparison runs, in turn (perf.js RENDER_MODES has the switches). Another mode is one more entry here and one more entry there.
// 'default' is the gesture transform (the drawn canvas is moved by the compositor while the view is panned or zoomed); 'classic' is what shipped before.
export const COMPARE_MODES = [
  { id: 'default', label: 'Default (gesture transform)' },
  { id: 'classic', label: 'Draw every step (before)' },
  { id: 'bitmaps', label: 'Bitmaps always' },
  { id: 'dpr1', label: 'DPR 1' },
  { id: 'noShadow', label: 'Shadows off' },
  { id: 'fullRender', label: 'Full redraw' },
]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
  } catch { return '' }
}

const escape = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])

function environment({ engine, hostName }) {
  const dpr = globalThis.devicePixelRatio || 1
  const platform = navigator.userAgentData?.platform || navigator.platform || 'unknown'
  return { engine, host: hostName, platform, dpr, screen: `${Math.round(screen.width * dpr)}x${Math.round(screen.height * dpr)}`, cores: navigator.hardwareConcurrency ?? '?', gpu: gpuName() }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch { /* the page may not be allowed the clipboard: select and copy instead */ }
  const area = document.createElement('textarea')
  area.value = text
  area.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.append(area)
  area.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { /* no */ }
  area.remove()
  return ok
}

// env: { api, notebookId, engine, hostName, openNote(id) (resolves when the note is on screen), restore() (back to what was open),
//        pause(on) (no saves while on), forgetNote(id), host (the driver's host, see driver.js), pageCount() }
export async function runSpeedTest(env) {
  // A popover (top layer) in a corner while the test runs; only its Stop button takes clicks, the rest is inert so the test's events reach the note.
  const panel = document.createElement('section')
  panel.className = 'speedtest-panel'
  panel.setAttribute('popover', 'manual')
  panel.setAttribute('role', 'status')
  panel.setAttribute('aria-live', 'polite')
  document.body.append(panel)
  if (typeof panel.showPopover === 'function') panel.showPopover() // (a browser without popovers shows it as a plain fixed box: the same styles)
  let test = null
  const noteIds = [] // every note this run made; all are removed at the end
  let currentId = null // the note the test may touch right now
  let comparing = false

  const header = (lead) => `<h2>Speed test</h2><p>${lead}</p>`
  // Before it starts: one choice, and one click.
  panel.innerHTML = `${header('Measures how smoothly this computer draws a note: panning, zooming, dragging, pen and typing. Your notes are not touched.')}
    <label class="setting-row" for="speedtest-compare"><span>Compare render modes</span><input type="checkbox" id="speedtest-compare" checked /></label>
    <p class="portability-help">Also runs a shorter version of the test under each way of drawing the canvas, on the big note and on a note of ${REALISTIC_OBJECTS} objects, and puts them side by side. Each mode is run twice. About 3 minutes in all on a fast computer; without it, about 1 minute.</p>
    <div class="portability-actions"><button data-act="start">Start</button><button data-act="cancel">Cancel</button></div>`
  const choice = await new Promise((resolve) => {
    panel.querySelector('[data-act="start"]').addEventListener('click', () => resolve({ compare: panel.querySelector('#speedtest-compare').checked }))
    panel.querySelector('[data-act="cancel"]').addEventListener('click', () => resolve(null))
  })
  if (!choice) { panel.remove(); return null }
  panel.innerHTML = `${header('Making a stress note of 5,000+ objects. Your notes are not touched. Please leave the mouse and keyboard alone.')}<div inert><progress max="9" value="0"></progress><div class="speedtest-step">Starting</div></div><div class="portability-actions"><button data-act="stop">Stop</button></div>`
  panel.querySelector('[data-act="stop"]').addEventListener('click', () => test?.stop())
  const progress = ({ name, done, total }) => {
    const bar = panel.querySelector('progress')
    if (bar) { bar.max = total; bar.value = done }
    const step = panel.querySelector('.speedtest-step')
    if (step) step.textContent = name
  }

  let report = null
  try {
    const stress = generateStressNote(STRESS_OBJECTS)
    const makeNote = async (made) => {
      const note = await env.api('/notes', { method: 'POST', body: JSON.stringify({ title: NOTE_TITLE, notebookId: env.notebookId, noteType: 'canvas' }) })
      noteIds.push(note.id)
      await env.api(`/notes/${note.id}`, { method: 'PUT', body: JSON.stringify({ title: NOTE_TITLE, notebookId: env.notebookId, revision: note.revision, pageState: made.pageState, content: made.content }) })
      return note
    }
    const note = await makeNote(stress)
    env.pause(true) // before anything is opened: nothing is saved while the test runs
    const t0 = performance.now()
    await env.openNote(note.id)
    currentId = note.id
    if (env.activeNoteId() !== note.id) throw new Error('the stress note did not open')
    const openMs = performance.now() - t0
    const objects = env.host.edits.doc.objects.length
    const stressSnapshot = JSON.parse(JSON.stringify(env.host.edits.doc)) // as opened: the full run edits the note (pen strokes), the comparison starts from this
    test = createSpeedTest({
      host: { ...env.host, guard: () => { if (env.activeNoteId() !== currentId) throw Object.assign(new Error('the open note is not the stress note'), { aborted: true }) } },
      onProgress: progress,
    })
    const { results, failed } = await test.run()
    let comparison = null
    if (choice.compare && !failed.some((entry) => /stopped/.test(entry))) {
      comparing = true
      comparison = { modes: COMPARE_MODES, notes: [] }
      // A B C D E E D C B A: every mode twice, so what drifts over the minutes (heat, other programs) does not land on one mode only.
      const order = [...COMPARE_MODES, ...[...COMPARE_MODES].reverse()]
      const total = order.length * 2
      let done = 0
      try {
        const sets = [{ label: 'the stress note', objects, snapshot: stressSnapshot }, { label: 'a realistic note', make: () => generateStressNote(REALISTIC_OBJECTS, { columns: 2, rows: 3 }) }]
        let stoppedEarly = false
        for (const set of sets) {
          if (set.make) {
            const made = await makeNote(set.make())
            await env.openNote(made.id)
            currentId = made.id
            if (env.activeNoteId() !== made.id) throw new Error('the realistic note did not open')
            set.objects = env.host.edits.doc.objects.length
          }
          // Every run of every mode starts from the same document: edits one run made (the drags, the pen, the typing) are put back.
          const snapshot = set.snapshot ?? JSON.parse(JSON.stringify(env.host.edits.doc))
          const entry = { label: set.label, objects: set.objects, results: {}, starts: {} } // (starts: how many objects each run began with; all equal the note's)
          comparison.notes.push(entry)
          const runs = {}
          for (const mode of order) {
            try {
              test.check()
              progress({ name: `Comparing render modes: ${set.label}, ${mode.label}`, done, total })
              await env.host.setRenderMode(mode.id, snapshot)
              await sleep(300)
              await test.warm()
              ;(entry.starts[mode.id] ??= []).push(env.host.edits.doc.objects.length)
              const result = await test.runQuick()
              ;(runs[mode.id] ??= []).push(result)
              done += 1
            } catch (error) {
              if (!error.stopped) throw error
              stoppedEarly = true
              failed.push('comparison stopped before the end')
              break
            }
          }
          for (const mode of COMPARE_MODES) if (runs[mode.id]?.length === 2) entry.results[mode.id] = mergeRuns(runs[mode.id][0], runs[mode.id][1])
          if (stoppedEarly) break
        }
        progress({ name: 'Done', done: total, total })
      } catch (error) {
        // The main results are kept; the comparison says how far it got.
        console.error('The render-mode comparison failed', error)
        failed.push(`Render-mode comparison failed: ${error.message || error}`)
      }
    }
    const run = {
      when: new Date().toISOString(), app: 'Personal Note', ...environment(env),
      note: { objects, pages: env.pageCount() },
      results: [{ name: 'Open the note (ms)', unit: 'ms', p50: Math.round(openMs), p95: null, max: null, n: 1, slow: 0 }, ...results.map((row) => ({ ...row, verdict: row.unit === 'ms' ? '' : verdict(row.p95) }))],
      failed,
      ...(comparison ? { comparison } : {}),
    }
    report = { run, text: formatReport(run) + (comparison ? `\n${formatComparison(comparison)}` : '') }
  } catch (error) {
    console.error('Speed test failed', error)
    panel.innerHTML = `${header(`The speed test could not run: ${escape(error.message || error)}`)}<div class="portability-actions"><button data-act="close">Close</button></div>`
    panel.querySelector('[data-act="close"]').addEventListener('click', () => panel.remove())
  } finally {
    env.pause(false)
    if (comparing) { try { await env.host.setRenderMode('saved') } catch (error) { console.error(error) } } // the person's own render mode again
    try { await env.restore() } catch (error) { console.error(error) }
    for (const id of noteIds) {
      try { await env.api(`/notes/${id}`, { method: 'DELETE' }) } catch (error) { console.error('The speed test note could not be removed', error) }
      env.forgetNote(id)
    }
  }
  if (!report) return null
  let saved = ''
  try {
    const result = await env.api('/speedtest/report', { method: 'POST', headers: { 'x-personal-note': '1' }, body: JSON.stringify({ text: report.text, data: report.run }) })
    saved = result.path
  } catch (error) { console.error('The results could not be saved', error) }
  const rows = report.run.results.map((row) => {
    const bad = row.unit !== 'ms' && row.p95 > 34
    return `<tr><td>${escape(row.name)}</td><td>${row.p50 ?? '-'}</td><td>${row.p95 ?? '-'}</td><td>${row.max ?? '-'}</td><td>${bad ? '! ' : ''}${escape(row.verdict ?? '')}</td></tr>`
  }).join('')
  panel.classList.add('is-done')
  panel.innerHTML = `${header('Milliseconds per frame, so 16.7 is 60 frames a second. Lower is better.')}
    <p class="portability-help">${escape(report.run.engine)} on ${escape(report.run.platform)}, ${escape(report.run.host)}, ${escape(report.run.dpr)}x screen (${escape(report.run.screen)}), ${escape(report.run.cores)} cores${report.run.gpu ? `, ${escape(report.run.gpu)}` : ''}. Stress note: ${report.run.note.objects} objects on ${escape(report.run.note.pages)} pages.</p>
    <table><thead><tr><th></th><th>p50</th><th>p95</th><th>max</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    ${(report.run.comparison?.notes ?? []).map((note) => `<h3>Render modes on ${escape(note.label)} (${escape(note.objects)} objects)</h3>
    <p class="portability-help">p50/p95/max in milliseconds per frame (lower is better), the median of two runs; noisy: the two runs differed by more than 1.5x.</p>
    <table class="speedtest-compare"><thead><tr><th></th>${report.run.comparison.modes.map((mode) => `<th>${escape(mode.label)}</th>`).join('')}</tr></thead><tbody>${comparisonRows(note, report.run.comparison.modes).map((row) => `<tr><td>${escape(row.name)}</td>${row.cells.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('')}
    ${report.run.failed.length ? `<p class="portability-help">Could not measure: ${escape(report.run.failed.join('; '))}</p>` : ''}
    <div class="portability-actions"><button data-act="copy">Copy results</button><button data-act="again">Run again</button><button data-act="close">Close</button></div>
    <p class="portability-help">${saved ? `Saved to ${escape(saved)}` : 'The results could not be saved to a file; use Copy results.'}</p>`
  const copy = panel.querySelector('[data-act="copy"]')
  copy.addEventListener('click', async () => { copy.textContent = (await copyText(report.text)) ? 'Copied' : 'Could not copy' })
  panel.querySelector('[data-act="close"]').addEventListener('click', () => panel.remove())
  panel.querySelector('[data-act="again"]').addEventListener('click', () => { panel.remove(); void runSpeedTest(env) })
  document.documentElement.dataset.speedtestDone = '1'
  return report
}
