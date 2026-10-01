// Runs Python with the project's own virtual environment when it exists, else python3 / python (py / python on Windows).
// Usage: node scripts/run-python.mjs main.py   |   node scripts/run-python.mjs -m uvicorn main:app
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pythonCandidates } from './python-command.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
for (const command of pythonCandidates(root)) {
  const result = spawnSync(command, process.argv.slice(2), { stdio: 'inherit', cwd: root })
  if (result.error?.code === 'ENOENT') continue
  process.exit(result.status ?? 1)
}
console.error('No Python found: create .venv (python -m venv .venv) or install python3.')
process.exit(1)
