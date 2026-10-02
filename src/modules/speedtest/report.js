// The speed test's numbers (F-034): percentile summaries of frame times, and the report as text the person can copy and paste.
// Pure JS, tested in Node.

export function percentile(sorted, q) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

// p50, p95 and max of a list of milliseconds (one decimal), the count, and how many were slower than `slowMs`.
export function summarize(values, slowMs = 20) {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  const round = (value) => Math.round(value * 10) / 10
  return { p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), max: round(sorted.at(-1) ?? 0), n: sorted.length, slow: sorted.filter((value) => value > slowMs).length }
}

// What a frame time means to the eye, for the panel: 60 fps is 16.7 ms.
export function verdict(p95) {
  if (p95 <= 17.5) return 'smooth'
  if (p95 <= 34) return 'a few dropped frames'
  return 'choppy'
}

const pad = (text, width) => String(text).padEnd(width)
const num = (value) => (value === null || value === undefined ? '-' : value.toFixed(1))

// `run`: { when (ISO string), app, engine, host, dpr, screen, cores, note: { objects, pages }, results: [{ name, unit?, p50, p95, max, n, slow }] }
export function formatReport(run) {
  const lines = []
  lines.push(`Personal Note speed test  ${run.when}`)
  lines.push(`${run.engine} on ${run.platform}, ${run.host}, devicePixelRatio ${run.dpr} (${run.screen}), ${run.cores} cores${run.gpu ? `, ${run.gpu}` : ''}`)
  lines.push(`Stress note: ${run.note.objects} objects on ${run.note.pages} pages. Times are milliseconds per frame (16.7 = 60 fps) unless noted.`)
  lines.push('')
  const width = Math.max(...run.results.map((row) => row.name.length), 8)
  lines.push(`${pad('', width)}  ${pad('p50', 7)}${pad('p95', 7)}${pad('max', 7)}${pad('n', 5)}verdict`)
  for (const row of run.results) {
    const verdictText = row.verdict ?? (row.unit === 'ms' ? '' : verdict(row.p95))
    lines.push(`${pad(row.name, width)}  ${pad(num(row.p50), 7)}${pad(num(row.p95), 7)}${pad(num(row.max), 7)}${pad(row.n, 5)}${verdictText}`)
  }
  if (run.failed?.length) { lines.push(''); lines.push(`Could not measure: ${run.failed.join('; ')}`) }
  return lines.join('\n')
}
