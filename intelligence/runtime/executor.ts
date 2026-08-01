import { PROTOCOL_VERSION } from '../protocol/version.js'
import {
  executeRequestSchema,
  type ExecuteRequest,
  type ExecuteResponse,
  type TaskName,
} from '../protocol/schemas.js'
import { executeRankRelated } from '../tasks/rank-related.js'
import { executeScanPage } from '../tasks/scan-page.js'


type TaskHandler = (
  input: Record<string, unknown>,
  preferences: ExecuteRequest['preferences'],
) => Promise<{ output: Record<string, unknown>; execution: ExecuteResponse['execution']; mode: string }>

const handlers: Record<TaskName, TaskHandler> = {
  'rank-related': async (input, preferences) => {
    const result = await executeRankRelated(input, preferences)
    return result
  },
  'scan-page': async (input, preferences) => {
    const result = await executeScanPage(input, preferences)
    return result
  },
}

export async function executeTask(rawRequest: unknown): Promise<ExecuteResponse> {
  const request = executeRequestSchema.parse(rawRequest)
  const handler = handlers[request.task]
  if (!handler) {
    throw new Error(`Unsupported intelligence task: ${request.task}`)
  }

  const result = await handler(request.input, request.preferences)
  return {
    protocolVersion: PROTOCOL_VERSION,
    task: request.task,
    output: result.output,
    execution: result.execution,
    mode: result.mode,
  }
}

export function supportedTasks(): TaskName[] {
  return Object.keys(handlers) as TaskName[]
}
