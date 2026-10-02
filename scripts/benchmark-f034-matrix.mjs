// F-034: runs scripts/benchmark-f034.mjs over the whole matrix and writes the before/after tables of docs/story/engine-race/leafer-optimizations.md.
//
//   node scripts/benchmark-f034-matrix.mjs run    --out=DIR --label=after  [--root=CHECKOUT] [--only=gpu|sw] [--notes=600,stress] [--dprs=1,2]
//   node scripts/benchmark-f034-matrix.mjs flags  --out=DIR [--mode=sw|gpu] [--dpr=1]            one switch off at a time, on the stress note
//   node scripts/benchmark-f034-matrix.mjs report --out=DIR --before=before --after=after        markdown tables from the saved results
//
// `--root` is another checkout to measure (the commit before the performance pass, for "before"): its own copy of the benchmark script is used,
// so copy scripts/benchmark-f034.mjs and src/modules/speedtest/stress-note.js into it first. Results are JSON files in DIR.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const [command = 'run', ...rest] = process.argv.slice(2)
const args = Object.fromEntries(rest.map((arg) => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.length ? value.join('=') : 'true'] }))
const out = args.out ?? '/var/tmp/f034-results'
fs.mkdirSync(out, { recursive: true })
const root = path.resolve(args.root ?? new URL('..', import.meta.url).pathname)
const modes = args.only ? [args.only] : ['gpu', 'sw']
const notes = (args.notes ?? '600,stress').split(',')
const dprs = (args.dprs ?? '1,2').split(',').map(Number)

function bench(file, extra) {
  const result = spawnSync('node', ['scripts/benchmark-f034.mjs', `--out=${file}`, ...extra], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', env: { ...process.env } })
  if (result.status !== 0) console.error(`benchmark failed (${result.status}): ${extra.join(' ')}`)
  return result.status === 0
}

if (command === 'run') {
  const label = args.label ?? 'after'
  for (const mode of modes) for (const note of notes) for (const dpr of dprs) {
    const file = path.join(out, `${label}-${mode}-${note}-dpr${dpr}.json`)
    console.log(`run ${label} ${mode} ${note} dpr ${dpr}`)
    bench(file, [`--note=${note}`, `--dpr=${dpr}`, ...(mode === 'gpu' ? ['--gpu'] : [])])
  }
} else if (command === 'flags') {
  const mode = args.mode ?? 'sw'
  const dpr = args.dpr ?? '1'
  const sets = {
    'default': {},
    'baked-shadow-off': { bakedShadow: false },
    'bitmaps-off': { pageBitmaps: 'off' },
    'bitmaps-always': { pageBitmaps: 'always' },
    'bitmaps-always-cull-off': { pageBitmaps: 'always', cull: false },
    'bitmaps-off-baked-off': { pageBitmaps: 'off', bakedShadow: false },
  }
  for (const [name, flags] of Object.entries(sets)) {
    const file = path.join(out, `flag-${mode}-${name}-dpr${dpr}.json`)
    console.log(`flags ${mode} ${name} dpr ${dpr}`)
    bench(file, ['--note=stress', `--dpr=${dpr}`, `--flags=${JSON.stringify(flags)}`, '--only=pan,zoom,drag', ...(mode === 'gpu' ? ['--gpu'] : [])])
  }
  // the dense desk where culling can matter: 16,000 objects on 6x6 pages
  for (const [name, flags] of Object.entries({ 'big-bitmaps-off': { pageBitmaps: 'off' }, 'big-bitmaps-always': { pageBitmaps: 'always' }, 'big-bitmaps-always-cull-off': { pageBitmaps: 'always', cull: false } })) {
    const file = path.join(out, `flag-${mode}-${name}-dpr${dpr}.json`)
    console.log(`flags ${mode} ${name} dpr ${dpr}`)
    bench(file, ['--note=stress', '--count=16000', '--grid=6x6', `--dpr=${dpr}`, `--flags=${JSON.stringify(flags)}`, '--only=pan,zoom', ...(mode === 'gpu' ? ['--gpu'] : [])])
  }
} else if (command === 'report') {
  const read = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).results[0] : null)
  const cell = (row, key = 'p50') => (row && row[key] !== null && row[key] !== undefined ? String(row[key]) : '-')
  const lines = []
  const before = args.before ?? 'before'
  const after = args.after ?? 'after'
  for (const mode of modes) for (const note of notes) for (const dpr of dprs) {
    const a = read(path.join(out, `${before}-${mode}-${note}-dpr${dpr}.json`))
    const b = read(path.join(out, `${after}-${mode}-${note}-dpr${dpr}.json`))
    if (!a && !b) continue
    const title = `${(b ?? a).note}, devicePixelRatio ${dpr}, ${mode === 'gpu' ? 'with the graphics card' : 'software rendering (no graphics card)'}`
    lines.push(`#### ${title}`, '', '| scenario | before p50 | before p95 | before max | after p50 | after p95 | after max |', '|---|---:|---:|---:|---:|---:|---:|')
    const names = [...new Set([...(a?.rows ?? []), ...(b?.rows ?? [])].map((row) => row.scenario))]
    for (const name of names) {
      const x = a?.rows.find((row) => row.scenario === name)
      const y = b?.rows.find((row) => row.scenario === name)
      lines.push(`| ${name} | ${cell(x)} | ${cell(x, 'p95')} | ${cell(x, 'max')} | ${cell(y)} | ${cell(y, 'p95')} | ${cell(y, 'max')} |`)
    }
    lines.push('')
  }
  // one switch at a time
  const flagFiles = fs.readdirSync(out).filter((name) => name.startsWith('flag-')).sort()
  if (flagFiles.length) {
    lines.push('#### One switch at a time', '', '| run | scenario | p50 | p95 | max | slow frames |', '|---|---|---:|---:|---:|---:|')
    for (const name of flagFiles) {
      const r = read(path.join(out, name))
      if (!r) continue
      for (const row of r.rows.filter((entry) => !entry.scenario.startsWith('open'))) lines.push(`| ${name.replace(/^flag-|\.json$/g, '')} | ${row.scenario} | ${cell(row)} | ${cell(row, 'p95')} | ${cell(row, 'max')} | ${row.slow ?? '-'} |`)
    }
  }
  console.log(lines.join('\n'))
}
