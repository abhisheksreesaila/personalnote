import { deterministicProvider } from './deterministic.js'
import { modelProvider, readIntelligenceTier } from './model.js'
import type { IntelligenceProvider, ProviderContext } from './types.js'


export function listProviders(): IntelligenceProvider[] {
  const providers: IntelligenceProvider[] = [deterministicProvider]
  if (modelProvider) providers.push(modelProvider)
  return providers
}

export function selectProviderChain(context: ProviderContext): IntelligenceProvider[] {
  const chain: IntelligenceProvider[] = [deterministicProvider]

  if (!modelProvider || context.modelDisabled) return chain

  const tier = context.tier || readIntelligenceTier()
  if (tier === 'local-only' && modelProvider.capabilities.cloudCapable) return chain

  if (tier === 'cloud-ok' || tier === 'local-first') {
    if (tier === 'local-first' && modelProvider.capabilities.cloudCapable) {
      // local-first prefers on-device models; cloud is fallback only when no local model exists
      return chain
    }
    return [modelProvider, ...chain]
  }

  if (tier === 'local-only' && !modelProvider.capabilities.cloudCapable) {
    return [modelProvider, ...chain]
  }

  return chain
}

export function runtimeCapabilities() {
  const tier = readIntelligenceTier()
  const providers = listProviders().map(provider => ({
    id: provider.id,
    executor: provider.capabilities.executor,
    family: provider.capabilities.family,
    label: provider.capabilities.label,
    cloudCapable: provider.capabilities.cloudCapable,
  }))

  return {
    tier,
    mode: workerModeFromProviders(),
    provider: modelProvider?.id ?? 'local',
    providers,
    modelConfigured: Boolean(modelProvider),
  }
}

function workerModeFromProviders() {
  if (!modelProvider) return 'local-retrieval'
  return modelProvider.capabilities.executor === 'cloud-model' ? 'cloud-model' : 'mastra-model'
}
