import { createServer, type ServerResponse } from 'node:http'

import { rankCandidates, workerMode } from './ambient-agent.js'


const port = Number(process.env.INTELLIGENCE_PORT || 4112)

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    return send(response, 200, { status: 'ok', framework: 'mastra', mode: workerMode() })
  }
  if (request.method !== 'POST' || request.url !== '/rank') {
    return send(response, 404, { error: 'Not found' })
  }

  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 1_000_000) return send(response, 413, { error: 'Request too large' })
  }
  try {
    const result = await rankCandidates(JSON.parse(body || '{}'))
    return send(response, 200, result)
  } catch (error) {
    console.error(`event=intelligence.request outcome=failed error_class=${error instanceof Error ? error.name : 'UnknownError'}`)
    return send(response, 400, { error: 'Invalid rank request' })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Personal Note intelligence listening on http://127.0.0.1:${port} (${workerMode()})`)
})