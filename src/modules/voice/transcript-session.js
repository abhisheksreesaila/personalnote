function normalizeTranscript(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function appendTranscript(existing, addition) {
  const current = String(existing || '')
  const next = normalizeTranscript(addition)
  if (!next) return current
  return `${current}${current.trim() ? ' ' : ''}${next}`
}

export class DictationSession {
  constructor() {
    this.active = false
    this.partial = ''
    this.committed = ''
    this.target = null
  }

  start(target = null) {
    this.active = true
    this.partial = ''
    this.committed = String(target?.text || '')
    this.target = target
  }

  preview(text, { append = false } = {}) {
    if (!this.active) return this.renderedText()
    this.partial = append ? appendTranscript(this.partial, text) : normalizeTranscript(text)
    return this.renderedText()
  }

  commit(text) {
    if (!this.active) return this.renderedText()
    this.committed = appendTranscript(this.committed, text)
    this.partial = ''
    return this.renderedText()
  }

  renderedText() {
    return appendTranscript(this.committed, this.partial)
  }

  accept(results, resultIndex = 0) {
    if (!this.active) return { partial: '', stable: [] }

    const stable = []
    const partial = []
    for (let index = resultIndex; index < results.length; index += 1) {
      const text = normalizeTranscript(results[index]?.[0]?.transcript)
      if (!text) continue
      if (results[index].isFinal) stable.push(text)
      else partial.push(text)
    }

    this.partial = normalizeTranscript(partial.join(' '))
    return { partial: this.partial, stable }
  }

  finish() {
    this.active = false
    this.partial = ''
  }

  cancel() {
    this.finish()
    this.target = null
  }
}
