import { createAzure, type AzureOpenAIProviderSettings } from '@ai-sdk/azure'
import { createOpenAI } from '@ai-sdk/openai'
import { Agent } from '@mastra/core/agent'

import type { IntelligenceProvider } from './types.js'


export function resolveAzureProviderSettings(
  endpoint: string,
  apiKey: string,
): AzureOpenAIProviderSettings {
  const url = new URL(endpoint)
  if (url.hostname.endsWith('.services.ai.azure.com') && url.pathname.startsWith('/api/projects/')) {
    return { resourceName: url.hostname.split('.')[0], apiKey }
  }
  if (url.hostname.endsWith('.openai.azure.com')) {
    const openAIPath = url.pathname.match(/^(.*?\/openai)(?:\/|$)/)?.[1] || '/openai'
    return { baseURL: `${url.origin}${openAIPath}`, apiKey }
  }
  return { baseURL: endpoint.replace(/\/$/, ''), apiKey }
}

function readModelConfig() {
  return {
    modelName: process.env.PERSONAL_NOTE_MODEL?.trim() || '',
    modelBaseUrl: process.env.PERSONAL_NOTE_MODEL_URL?.trim() || 'http://127.0.0.1:11434/v1',
    modelKey: process.env.PERSONAL_NOTE_MODEL_KEY?.trim() || 'local',
    deploymentName: process.env.PERSONAL_NOTE_DEPLOYMENT_NAME?.trim() || '',
    modelDisabled: process.env.PERSONAL_NOTE_DISABLE_MODEL === '1',
  }
}

function createConfiguredModel() {
  const config = readModelConfig()
  if (config.modelDisabled) return null

  if (config.deploymentName) {
    const azure = createAzure({
      ...resolveAzureProviderSettings(config.modelBaseUrl, config.modelKey),
      apiVersion: process.env.PERSONAL_NOTE_AZURE_API_VERSION?.trim() || 'v1',
      useDeploymentBasedUrls: process.env.PERSONAL_NOTE_AZURE_DEPLOYMENT_URLS === '1',
    })
    return {
      model: azure.responses(config.deploymentName),
      family: 'azure-openai' as const,
      cloudCapable: true,
      label: 'Azure OpenAI',
    }
  }

  if (!config.modelName) return null

  const isLocalEndpoint = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?/i.test(config.modelBaseUrl)
  return {
    model: createOpenAI({
      baseURL: config.modelBaseUrl,
      apiKey: config.modelKey,
    })(config.modelName),
    family: 'openai-compatible' as const,
    cloudCapable: !isLocalEndpoint,
    label: isLocalEndpoint ? 'Local model' : 'OpenAI-compatible',
  }
}

const configured = createConfiguredModel()
let modelAgent: Agent | null = null

if (configured) {
  modelAgent = new Agent({
    id: 'intelligence-model',
    name: 'Intelligence model executor',
    instructions: 'Follow the system prompt supplied per request.',
    model: configured.model,
  })
}

export const modelProvider: IntelligenceProvider | null = modelAgent
  ? {
      id: configured!.family,
      capabilities: {
        family: configured!.family,
        executor: configured!.cloudCapable ? 'cloud-model' : 'local-model',
        modelConfigured: true,
        cloudCapable: configured!.cloudCapable,
        label: configured!.label,
      },
      async generate({ system, user, maxSteps = 1 }) {
        const response = await modelAgent!.generate(`${system}\n\n${user}`, { maxSteps })
        return response.text
      },
    }
  : null

export function readIntelligenceTier(): 'local-only' | 'local-first' | 'cloud-ok' {
  const value = process.env.PERSONAL_NOTE_INTELLIGENCE_TIER?.trim().toLowerCase()
  if (value === 'local-only' || value === 'local-first' || value === 'cloud-ok') return value
  return 'local-first'
}

export function workerMode() {
  if (!modelProvider) return 'local-retrieval'
  return modelProvider.capabilities.executor === 'cloud-model' ? 'cloud-model' : 'mastra-model'
}

export function workerProvider() {
  if (!modelProvider) return 'local'
  return modelProvider.id
}
