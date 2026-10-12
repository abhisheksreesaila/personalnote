// A page note's stored document (ADR 0003): { version, markdown, ink: { marks, drawings, ...more } }. The Markdown is canonical and
// never holds ink. Mirrors page_note.py: broken parts fall back to empty, unknown ink fields are kept as they are.

export const PAGE_DOCUMENT_VERSION = 1

export function emptyPageDocument() {
  return { version: PAGE_DOCUMENT_VERSION, markdown: '', ink: { marks: [], drawings: [] } }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function normalizePageDocument(document) {
  if (!isObject(document)) return emptyPageDocument()
  const ink = isObject(document.ink) ? document.ink : {}
  const list = (value) => (Array.isArray(value) ? value.filter(isObject) : [])
  return {
    version: PAGE_DOCUMENT_VERSION,
    markdown: typeof document.markdown === 'string' ? document.markdown : '',
    ink: { ...ink, marks: list(ink.marks), drawings: list(ink.drawings) },
  }
}
