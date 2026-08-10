import { z } from 'zod'


export const workspaceProtocolVersionSchema = z.literal('1')

export const workspaceOperationSchema = z.enum([
  'workspace.describe',
  'resource.get',
  'workspace.query',
])

export const workspaceRequestSchema = z.object({
  protocolVersion: workspaceProtocolVersionSchema,
  requestId: z.string().min(1).max(128),
  operation: workspaceOperationSchema,
  input: z.record(z.unknown()),
})

export const textSourceRefSchema = z.object({
  type: z.literal('block_text'),
  resourceId: z.string().min(1),
  noteId: z.string().min(1),
  noteRevision: z.number().int().positive(),
  blockId: z.string().min(1),
  textSpan: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
  valueHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  excerpt: z.string(),
})

export const workspaceErrorSchema = z.object({
  protocolVersion: workspaceProtocolVersionSchema,
  requestId: z.string().nullable(),
  error: z.object({
    code: z.enum([
      'authentication_required',
      'cursor_expired',
      'internal_error',
      'invalid_cursor',
      'invalid_request',
      'not_found',
      'scope_denied',
      'unsupported_operation',
      'unsupported_version',
    ]),
    message: z.string(),
  }),
})

export type WorkspaceRequest = z.infer<typeof workspaceRequestSchema>
export type TextSourceRef = z.infer<typeof textSourceRefSchema>