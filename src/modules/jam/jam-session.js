// One jam on the open mind map (F-092): what was said, the turn in flight, and what the island shows. No DOM and no network in here; the plugin
// hands in the map, the request and the editor's own calls. A turn is one brain call sent when the person says so (the Jam button, or the word
// "jam" ending a sentence), never per word; only one is out at a time, and words said meanwhile wait for the next.
const YES = /^(?:yes|yeah|yep|yes please)[.!]*$/i
const JAM_AT_END = /(?:^|\s)jam[.!?,]*$/i
const NOTHING = 'Nothing to jam on yet: hold the mic and talk.'
const SET_UP = 'Set up a model in Settings → AI.'

export function createJamSession({ getMap, getGhosts, requestTurn, applyEdits, answerGhost, onFace }) {
  let said = [] // finished sentences not yet sent
  let partial = '' // the sentence still being heard
  let mic = false
  let fault = null // { phase: 'error' | 'setup', message } until the next turn
  let inFlight = null
  let closed = false

  const transcript = () => [...said, partial].filter(Boolean).join(' ').trim()
  const show = () => {
    if (closed) return
    const phase = inFlight ? 'thinking' : fault ? fault.phase : mic ? 'listening' : 'idle'
    onFace({ phase, line: transcript(), message: fault?.message ?? '' })
  }

  async function turn() {
    const sent = said.length
    const request = { map: getMap(), transcript: transcript(), ghosts: getGhosts().map((ghost) => ghost.text) }
    fault = null
    try {
      const edits = await requestTurn(request)
      if (closed) return
      applyEdits(edits)
      said = said.slice(sent)
      partial = ''
    } catch (error) {
      if (closed) return
      fault = error.setup ? { phase: 'setup', message: SET_UP } : { phase: 'error', message: error.message }
    }
  }

  return {
    start: show,
    transcript,
    listening(on) { mic = on; show() },

    heard(text, { final }) {
      const words = text.trim()
      if (!final) { partial = words; show(); return }
      partial = ''
      const ghosts = getGhosts()
      if (YES.test(words) && ghosts.length) { answerGhost(ghosts.at(-1).id, true); show(); return }
      const ending = JAM_AT_END.exec(words)
      const rest = ending ? words.slice(0, ending.index).trim() : words
      if (rest) said.push(rest)
      if (ending) void this.jam()
      else show()
    },

    jam() {
      if (closed || inFlight) return Promise.resolve() // (one turn at a time: this press is ignored)
      if (!transcript()) { fault = { phase: 'error', message: NOTHING }; show(); return Promise.resolve() }
      inFlight = turn().finally(() => { inFlight = null; show() })
      show() // (Thinking: the turn has started, the map stays editable)
      return inFlight
    },

    idle: () => inFlight ?? Promise.resolve(),

    // The map was closed or the plugin turned off: a turn still out is dropped when it lands.
    dispose() { closed = true },
  }
}
