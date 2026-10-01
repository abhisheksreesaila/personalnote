import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function pythonCandidates(root, platform = process.platform, exists = existsSync) {
  const venv = platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python')
  const system = platform === 'win32' ? ['py', 'python'] : ['python3', 'python']
  return [...(exists(venv) ? [venv] : []), ...system]
}
