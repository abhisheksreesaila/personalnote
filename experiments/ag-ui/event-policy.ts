export const personalNoteEventPolicy = {
  RUN_STARTED: 'quiet-progress',
  RUN_FINISHED: 'finalize-enrichment',
  RUN_ERROR: 'keep-local-result',
  TEXT_MESSAGE_CONTENT: 'stream-enrichment-preview',
  TOOL_CALL_START: 'show-proposed-action',
  TOOL_CALL_RESULT: 'render-grounded-result',
  STATE_SNAPSHOT: 'not-enabled',
  STATE_DELTA: 'not-enabled',
} as const

export function eventPolicy(eventType: string) {
  return personalNoteEventPolicy[eventType as keyof typeof personalNoteEventPolicy] || 'ignore'
}