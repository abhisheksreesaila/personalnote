import { z } from 'zod'

import { PROTOCOL_VERSION } from './version.js'


export const intelligenceTierSchema = z.enum([
  'local-only',
  'local-first',
  'cloud-ok',
])

export const executorKindSchema = z.enum([
  'deterministic',
  'local-model',
  'cloud-model',
])

export const relatedCandidateSchema = z.object({
  noteId: z.number().int(),
  title: z.string(),
  notebookName: z.string(),
  notebookColor: z.string(),
  excerpt: z.string(),
  reason: z.string(),
  sourceUpdatedAt: z.string(),
  score: z.number(),
  confidence: z.number(),
  mode: z.string(),
})

export const rankRelatedInputSchema = z.object({
  currentText: z.string().max(24_000),
  candidates: z.array(relatedCandidateSchema).max(5),
})

export const rankRelatedOutputSchema = z.object({
  selectedId: z.number().int().nullable(),
  observation: z.string(),
})

export const executionMetaSchema = z.object({
  executor: executorKindSchema,
  provider: z.string(),
  latencyMs: z.number(),
  fallback: z.boolean(),
  tier: intelligenceTierSchema,
})

export const executePreferencesSchema = z.object({
  tier: intelligenceTierSchema.optional(),
  latencyBudgetMs: z.number().min(100).max(30_000).optional(),
})

export const scanPageActionsSchema = z.object({
  canTidy: z.boolean(),
  tidyFocused: z.boolean(),
  tidyCount: z.number().int(),
})

export const calendarDraftSchema = z.object({
  title: z.string(),
  startAt: z.string(),
  dateText: z.string(),
  hasExplicitTime: z.boolean(),
  durationMinutes: z.number(),
  priority: z.boolean().optional(),
})

export const scanPageInputSchema = z.object({
  currentText: z.string().max(24_000),
  segments: z.array(z.string().max(8_000)).max(80),
  focusSegments: z.array(z.string().max(8_000)).max(40).optional(),
  calendarDrafts: z.array(calendarDraftSchema),
  people: z.array(z.record(z.unknown())),
  relatedCandidates: z.array(relatedCandidateSchema).max(5),
  actions: scanPageActionsSchema,
})

export const scanPageOutputSchema = z.object({
  calendarDrafts: z.array(calendarDraftSchema),
  people: z.array(z.record(z.unknown())),
  related: relatedCandidateSchema.nullable(),
  relatedCandidates: z.array(relatedCandidateSchema),
  actions: scanPageActionsSchema,
  scanSummary: z.string(),
})

export const taskNameSchema = z.enum(['rank-related', 'scan-page'])

export const executeRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION).optional(),
  task: taskNameSchema,
  input: z.record(z.unknown()),
  preferences: executePreferencesSchema.optional(),
})

export const executeResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  task: taskNameSchema,
  output: z.record(z.unknown()),
  execution: executionMetaSchema,
  mode: z.string(),
})

/** Legacy `/rank` body — kept for backward compatibility. */
export const legacyRankRequestSchema = rankRelatedInputSchema

export const legacyRankResponseSchema = z.object({
  selectedId: z.number().int().nullable(),
  observation: z.string(),
  mode: z.string(),
})

export type IntelligenceTier = z.infer<typeof intelligenceTierSchema>
export type ExecutorKind = z.infer<typeof executorKindSchema>
export type RelatedCandidate = z.infer<typeof relatedCandidateSchema>
export type RankRelatedInput = z.infer<typeof rankRelatedInputSchema>
export type RankRelatedOutput = z.infer<typeof rankRelatedOutputSchema>
export type ExecutionMeta = z.infer<typeof executionMetaSchema>
export type ExecutePreferences = z.infer<typeof executePreferencesSchema>
export type ScanPageInput = z.infer<typeof scanPageInputSchema>
export type ScanPageOutput = z.infer<typeof scanPageOutputSchema>
export type TaskName = z.infer<typeof taskNameSchema>
export type ExecuteRequest = z.infer<typeof executeRequestSchema>
export type ExecuteResponse = z.infer<typeof executeResponseSchema>
