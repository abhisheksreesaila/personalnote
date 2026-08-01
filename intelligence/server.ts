import { createServer, type ServerResponse } from 'node:http'

import { PROTOCOL_VERSION } from './protocol/version.js'
import { legacyRankRequestSchema } from './protocol/schemas.js'
import { runtimeCapabilities } from './providers/registry.js'
import { workerMode, workerProvider } from './providers/model.js'
import { supportedTasks } from './runtime/executor.js'
import { executeTask } from './runtime/executor.js'
import { rankCandidates } from './ambient-agent.js'


const port = Number(process.env.INTELLIGENCE_PORT || 4112)

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

const server = createServer(async (request, response) => {
  const url = request.url?.split('?')[0] ?? ''

  if (request.method === 'GET' && url === '/health') {
    const capabilities = runtimeCapabilities()
    return send(response, 200, {
      status: 'ok',
      framework: 'mastra',
      protocolVersion: PROTOCOL_VERSION,
      mode: workerMode(),
      provider: workerProvider(),
      tier: capabilities.tier,
      tasks: supportedTasks(),
      capabilities,
    })
  }

  if (request.method === 'POST' && url === '/v1/execute') {
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (body.length > 1_000_000) return send(response, 413, { error: 'Request too large' })
    }
    try {
      const result = await executeTask(JSON.parse(body || '{}'))
      return send(response, 200, result)
    } catch (error) {
      console.error(
        `event=intelligence.execute outcome=failed error_class=${error instanceof Error ? error.name : 'UnknownError'}`,
      )
      return send(response, 400, { error: 'Invalid execute request' })
    }
  }

  if (request.method === 'POST' && url === '/rank') {
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (body.length > 1_000_000) return send(response, 413, { error: 'Request too large' })
    }
    try {
      const parsed = legacyRankRequestSchema.parse(JSON.parse(body || '{}'))
      const result = await rankCandidates(parsed)
      return send(response, 200, result)
    } catch (error) {
      console.error(
        `event=intelligence.request outcome=failed error_class=${error instanceof Error ? error.name : 'UnknownError'}`,
      )
      return send(response, 400, { error: 'Invalid rank request' })
    }
  }

  return send(response, 404, { error: 'Not found' })
})

server.listen(port, '127.0.0.1', () => {
  console.log(
    `Personal Note intelligence listening on http://127.0.0.1:${port} (${workerMode()}, protocol ${PROTOCOL_VERSION})`,
  )
})
