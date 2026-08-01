import type { ExecutorKind, IntelligenceTier } from '../protocol/schemas.js'


export type ProviderFamily = 'deterministic' | 'openai-compatible' | 'azure-openai' | 'local'

export interface ProviderCapabilities {
  family: ProviderFamily
  executor: ExecutorKind
  modelConfigured: boolean
  cloudCapable: boolean
  label: string
}

export interface ModelGenerateOptions {
  system: string
  user: string
  maxSteps?: number
}

export interface IntelligenceProvider {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  generate(options: ModelGenerateOptions): Promise<string>
}

export interface ProviderContext {
  tier: IntelligenceTier
  modelDisabled: boolean
}
