import assert from 'node:assert/strict'
import test from 'node:test'
import { pythonCandidates } from '../scripts/run-python.mjs'

test('prefers the project virtual environment when it exists', () => {
  assert.deepEqual(pythonCandidates('/app', 'linux', () => true), ['/app/.venv/bin/python', 'python3', 'python'])
  assert.deepEqual(pythonCandidates('/app', 'darwin', () => false), ['python3', 'python'])
})

test('uses the Windows virtual environment layout', () => {
  const [first, ...rest] = pythonCandidates('C:\\app', 'win32', () => true)
  assert.match(first, /\.venv.Scripts.python\.exe$/)
  assert.deepEqual(rest, ['python', 'py'])
})
