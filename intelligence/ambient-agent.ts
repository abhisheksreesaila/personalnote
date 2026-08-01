/** Backward-compatible exports for tests and legacy imports. */
import { rankRelatedInputSchema } from './protocol/schemas.js'
import { resolveAzureProviderSettings, workerMode, workerProvider } from './providers/model.js'
import { executeRankRelated } from './tasks/rank-related.js'


export { resolveAzureProviderSettings, workerMode, workerProvider }

export async function rankCandidates(input: unknown) {
  const request = rankRelatedInputSchema.parse(input)
  const result = await executeRankRelated(request)
  return {
    selectedId: result.output.selectedId,
    observation: result.output.observation,
    mode: result.mode,
  }
}
