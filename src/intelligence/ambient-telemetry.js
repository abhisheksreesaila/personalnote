function milliseconds(value) {
  return Math.max(0, Math.round(value))
}

export class AmbientTelemetry {
  constructor(clock = () => performance.now()) {
    this.clock = clock
    this.current = null
    this.last = null
    this.cancellations = 0
  }

  queue() {
    this.current = { queuedAt: this.clock() }
  }

  requestStarted() {
    if (!this.current) this.queue()
    this.current.requestStartedAt = this.clock()
  }

  response(server = {}) {
    if (!this.current) return
    const responseAt = this.clock()
    this.current.responseAt = responseAt
    this.current.requestMs = milliseconds(responseAt - (this.current.requestStartedAt ?? responseAt))
    this.current.server = {
      retrievalMs: Number(server.retrievalMs) || 0,
      enrichmentMs: Number(server.enrichmentMs) || 0,
      serverMs: Number(server.serverMs) || 0,
      mode: server.mode || 'unknown',
    }
  }

  presented() {
    if (!this.current) return this.snapshot()
    const presentedAt = this.clock()
    this.last = {
      ...this.current,
      presentedAt,
      presentationMs: milliseconds(presentedAt - this.current.queuedAt),
    }
    this.current = null
    return this.snapshot()
  }

  silent() {
    if (!this.current) return this.snapshot()
    const completedAt = this.clock()
    this.last = {
      ...this.current,
      completedAt,
      outcome: 'silent',
      completionMs: milliseconds(completedAt - this.current.queuedAt),
    }
    this.current = null
    return this.snapshot()
  }

  cancel() {
    if (!this.current) return this.snapshot()
    this.cancellations += 1
    this.current = null
    return this.snapshot()
  }

  interaction(action) {
    if (!this.last) return this.snapshot()
    this.last = {
      ...this.last,
      action,
      interactionMs: milliseconds(this.clock() - this.last.presentedAt),
    }
    return this.snapshot()
  }

  snapshot() {
    return {
      cancellations: this.cancellations,
      last: this.last ? { ...this.last, server: { ...this.last.server } } : null,
    }
  }
}