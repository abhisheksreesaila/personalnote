// Runs Python with the project's own virtual environment when it exists, else python3 / python.
// Usage: node scripts/run-python.mjs main.py   |   node scripts/run-python.mjs -m uvicorn main:app
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function pythonCandidates(root, platform = process.platform, exists = existsSync) {
  const venv = platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python')
  const system = platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
  return [...(exists(venv) ? [venv] : []), ...system]
}

export function run(args, root = fileURLToPath(new URL('..', import.meta.url))) {
  for (const command of pythonCandidates(root)) {
    const result = spawnSync(command, args, { stdio: 'inherit', cwd: root })
    if (result.error?.code === 'ENOENT') continue
    return result.status ?? (result.signal ? 1 : 0)
  }
  console.error('No Python found: create .venv (python -m venv .venv) or install python3.')
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)))
