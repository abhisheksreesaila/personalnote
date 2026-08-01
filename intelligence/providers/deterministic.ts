import type { IntelligenceProvider } from './types.js'


export const deterministicProvider: IntelligenceProvider = {
  id: 'deterministic',
  capabilities: {
    family: 'deterministic',
    executor: 'deterministic',
    modelConfigured: false,
    cloudCapable: false,
    label: 'Local retrieval',
  },
  async generate() {
    throw new Error('Deterministic provider does not invoke models')
  },
}
