// Shared by every check script that starts a server. A port that is already taken belongs to someone else (often another session's
// server): refuse and say so. Never kill it, never reuse it. The fix is always a different port from the environment.
import net from 'node:net'

const HOST = '127.0.0.1'

// The ports from this list that something is already listening on.
export async function busyPorts(ports) {
  const busy = []
  for (const port of ports) {
    const taken = await new Promise((resolve) => {
      const probe = net.createServer()
      probe.once('error', (error) => resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES'))
      probe.listen(port, HOST, () => probe.close(() => resolve(false)))
    })
    if (taken) busy.push(port)
  }
  return busy
}

// Call before starting anything. Exits 1 on the first busy port; `env` names the variable that moves the whole script.
export async function assertPortsFree(ports, env = 'PN_VERIFY_PORT') {
  if (ports.includes(3137)) {
    console.error(`port 3137 is the real app: never use it for a check script. Set ${env} to a free port.`)
    process.exit(1)
  }
  const [first] = await busyPorts(ports)
  if (first === undefined) return
  console.error(`port ${first} is busy (another session?): set ${env} to a free one. Nothing was started, killed or reused.`)
  process.exit(1)
}

// The base port of a script: PN_VERIFY_PORT when set, else its own default. (assertPortsFree refuses 3137, the real app.)
export const basePort = (fallback) => Number(process.env.PN_VERIFY_PORT || fallback)
