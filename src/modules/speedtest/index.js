// The speed test (F-034): the panel, the stress note it measures, and the report. Loaded when the test is run (Settings, the View menu, or
// the page opened with ?speedtest=1 by `npm run speedtest`); nothing of it is in the app's first load.
//
// The test runs on a note of its own (a generated stress note of 5,000+ objects in a notebook the person already has, named "Speed test (safe to
// delete)", removed when the test ends) and saves nothing while it runs, so no note of the person's is touched. The results are shown, can be
// copied as text, and are saved to a file in the app's data folder.
import './speedtest.css'
import { createSpeedTest } from './driver.js'
import { formatReport, verdict } from './report.js'
import { generateStressNote } from './stress-note.js'

const STRESS_OBJECTS = 5400
const NOTE_TITLE = 'Speed test (safe to delete)'

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
  const panel = document.createElement('section')
  panel.className = 'speedtest-panel'
  panel.setAttribute('role', 'status')
  panel.setAttribute('aria-live', 'polite')
  document.body.append(panel)
  let test = null
  let noteId = null
  let finished = false

  const header = (lead) => `<h2>Speed test</h2><p>${lead}</p>`
  panel.innerHTML = `${header('Making a stress note of 5,000+ objects. Your notes are not touched. Please leave the mouse and keyboard alone for about a minute.')}<progress max="9" value="0"></progress><div class="speedtest-step">Starting</div><div class="speedtest-actions"><button data-act="stop">Stop</button></div>`
  panel.querySelector('[data-act="stop"]').addEventListener('click', () => test?.stop())

  let report = null
  try {
    const stress = generateStressNote(STRESS_OBJECTS)
    const note = await env.api('/notes', { method: 'POST', body: JSON.stringify({ title: NOTE_TITLE, notebookId: env.notebookId, noteType: 'canvas' }) })
    noteId = note.id
    await env.api(`/notes/${note.id}`, { method: 'PUT', body: JSON.stringify({ title: NOTE_TITLE, notebookId: env.notebookId, revision: note.revision, pageState: stress.pageState, content: stress.content }) })
    env.pause(true)
    const t0 = performance.now()
    await env.openNote(note.id)
    const openMs = performance.now() - t0
    const objects = env.host.edits.doc.objects.length
    test = createSpeedTest({
      host: env.host,
      onProgress: ({ name, done, total }) => {
        const bar = panel.querySelector('progress')
        if (bar) { bar.max = total; bar.value = done }
        const step = panel.querySelector('.speedtest-step')
        if (step) step.textContent = name
      },
    })
    const { results, failed } = await test.run()
    const run = {
      when: new Date().toISOString(), app: 'Personal Note', ...environment(env),
      note: { objects, pages: env.pageCount() },
      results: [{ name: 'Open the note (ms)', unit: 'ms', p50: Math.round(openMs), p95: null, max: null, n: 1, slow: 0 }, ...results.map((row) => ({ ...row, verdict: row.unit === 'ms' ? '' : verdict(row.p95) }))],
      failed,
    }
    report = { run, text: formatReport(run) }
  } catch (error) {
    console.error('Speed test failed', error)
    panel.innerHTML = `${header(`The speed test could not run: ${escape(error.message || error)}`)}<div class="speedtest-actions"><button data-act="close">Close</button></div>`
    panel.querySelector('[data-act="close"]').addEventListener('click', () => panel.remove())
  } finally {
    env.pause(false)
    try { await env.restore() } catch (error) { console.error(error) }
    if (noteId !== null) {
      try { await env.api(`/notes/${noteId}`, { method: 'DELETE' }) } catch (error) { console.error('The speed test note could not be removed', error) }
      env.forgetNote(noteId)
    }
  }
  if (!report) return null
  finished = true
  let saved = ''
  try {
    const result = await env.api('/speedtest/report', { method: 'POST', headers: { 'x-personal-note': '1' }, body: JSON.stringify({ text: report.text, data: report.run }) })
    saved = result.path
  } catch (error) { console.error('The results could not be saved', error) }
  const rows = report.run.results.map((row) => {
    const bad = row.unit !== 'ms' && row.p95 > 34
    return `<tr><td>${escape(row.name)}</td><td>${row.p50 ?? '-'}</td><td>${row.p95 ?? '-'}</td><td>${row.max ?? '-'}</td><td class="speedtest-verdict${bad ? ' speedtest-bad' : ''}">${escape(row.verdict ?? '')}</td></tr>`
  }).join('')
  panel.classList.add('is-done')
  panel.innerHTML = `${header('Milliseconds per frame, so 16.7 is 60 frames a second. Lower is better.')}
    <div class="speedtest-where">${escape(report.run.engine)} on ${escape(report.run.platform)}, ${escape(report.run.host)}, ${escape(report.run.dpr)}x screen (${escape(report.run.screen)}), ${escape(report.run.cores)} cores${report.run.gpu ? `, ${escape(report.run.gpu)}` : ''}. Stress note: ${report.run.note.objects} objects on ${escape(report.run.note.pages)} pages.</div>
    <table><thead><tr><th></th><th>p50</th><th>p95</th><th>max</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    ${report.run.failed.length ? `<p class="speedtest-bad">Could not measure: ${escape(report.run.failed.join('; '))}</p>` : ''}
    <div class="speedtest-actions"><button class="primary" data-act="copy">Copy results</button><button data-act="again">Run again</button><button data-act="close">Close</button></div>
    <div class="speedtest-saved">${saved ? `Saved to ${escape(saved)}` : 'The results could not be saved to a file; use Copy results.'}</div>`
  const copy = panel.querySelector('[data-act="copy"]')
  copy.addEventListener('click', async () => { copy.textContent = (await copyText(report.text)) ? 'Copied' : 'Could not copy' })
  panel.querySelector('[data-act="close"]').addEventListener('click', () => panel.remove())
  panel.querySelector('[data-act="again"]').addEventListener('click', () => { panel.remove(); void runSpeedTest(env) })
  document.documentElement.dataset.speedtestDone = '1'
  void finished
  return report
}
