// The Voice plugin (F-091, ADR 0006): dictation into the open note. The shell imports this file only while Voice is on. Activating shows the
// mic on the tool island and the phone bar and draws the Settings row; `dispose()` stops any dictation and takes all of that away. It never
// starts the voice engine by itself: pressing the mic does, as before. Audio is never kept (AGENTS.md invariant 4).
//
// `shell` (what the page gives every plugin that needs it): { api, state, elements, island, canvas(), edits, pageWidth, inAppWindow(),
// setPropertiesOpen(open), refreshIcons(), countWords(text), contentBounds(objects, sizeOf), setup: { createSetupSection, renderSetupRow, createIslandDownload } }. `state.listening` stays on the shared state: the check scripts read it.

import { createMobileHoldController } from './mobile-hold-controller.js'
import { createPressToTalk } from './press-to-talk.js'
import { DictationSession } from './transcript-session.js'
import { pageBoundedTextLayout, voiceInsertPoint } from './text-layout.js'
import { createVoiceClient, describeVoice, prepareLocalVoice } from './voice-setup.js'

// How loud a chunk of 16-bit audio is, 0 to 1 (every 16th sample is enough for a row of bars).
function pcmLevel(buffer) {
  const samples = new Int16Array(buffer)
  let sum = 0
  let count = 0
  for (let i = 0; i < samples.length; i += 16, count += 1) sum += samples[i] * samples[i]
  return count ? Math.sqrt(sum / count) / 32768 : 0
}

export async function activateVoice(shell) {
  const { api, state, elements, island, pageWidth } = shell
  const { voiceButton, voiceCaption, voiceStatus, mobileSpeak } = elements
  const voiceDivider = document.querySelector('#voice-divider')
  const dictationSession = new DictationSession()
  const client = createVoiceClient(api)
  const { createIslandDownload, createSetupSection, renderSetupRow } = shell.setup
  const islandDownload = createIslandDownload(island)
  const listeners = new AbortController()
  const on = (target, type, handler) => target.addEventListener(type, handler, { signal: listeners.signal })
  let poll = null
  let recordingMoment = false
  let voiceWords = 0
  let voiceShown = '' // the words last put in the editor
  let recognition = null
  let voiceError = null
  let voiceMode = null
  let localTranscription = null
  let microphoneCapture = null
  let finishTimer = null
  let attemptCount = 0

  const section = createSetupSection({ name: 'voice', label: 'Voice', rowLabel: 'Dictation', icon: 'mic', actions: ['download', 'cancel', 'remove'] })
  document.querySelector('#settings-plugins').after(section)
  shell.refreshIcons()

  // ---- the Settings row ----
  const renderSetup = (status) => { renderSetupRow('voice', describeVoice(status)); islandDownload('voice', 'Voice model', status) }
  async function refreshSetup() {
    clearTimeout(poll)
    let status
    try {
      status = await client.status()
    } catch {
      renderSetup({ state: 'error', error: 'The local server did not answer.' })
      return null
    }
    renderSetup(status)
    if (status.state === 'downloading') poll = setTimeout(refreshSetup, 1000) // keep the progress bar moving while the server downloads
    return status
  }
  async function setupAction(action) {
    try {
      renderSetup(await action(client))
    } catch (error) {
      renderSetup({ state: 'error', error: error.message })
      return
    }
    void refreshSetup()
  }
  function openSettings() {
    shell.setPropertiesOpen(true)
    void refreshSetup()
    section.scrollIntoView?.({ block: 'center' })
    section.querySelector('button:not([hidden])')?.focus({ preventScroll: true })
  }
  on(section.querySelector('#voice-download'), 'click', () => void setupAction((voice) => voice.install()))
  on(section.querySelector('#voice-cancel'), 'click', () => void setupAction((voice) => voice.cancel()))
  on(section.querySelector('#voice-remove'), 'click', () => void setupAction((voice) => voice.remove()))

  // ---- the mic's state, on the buttons, the caption and the island ----
  function setListening(listening, message = 'Listening') {
    state.listening = listening
    const live = listening && (voiceMode === 'local' || voiceMode === 'browser') // (connecting is not recording yet)
    if (live && !recordingMoment) { recordingMoment = true; voiceWords = 0; island.model.recording(true, Date.now()) }
    else if (!live && recordingMoment) { recordingMoment = false; island.model.recording(false, voiceWords) }
    shell.voiceSink?.listening(live) // (a jam hears the mic through its sink; see toggle())
    voiceButton.classList.toggle('active', listening)
    voiceButton.setAttribute('aria-pressed', String(listening))
    voiceButton.setAttribute('aria-label', listening ? 'Stop voice dictation' : 'Start voice dictation')
    mobileSpeak.classList.toggle('active', listening)
    mobileSpeak.setAttribute('aria-pressed', String(listening))
    mobileSpeak.setAttribute('aria-label', listening ? 'Release to finish speaking' : 'Hold to speak')
    shell.canvas()?.setListening(listening)
    voiceCaption.hidden = !listening
    voiceStatus.textContent = message
  }

  // The words go into the text being edited through the overlay (the selected text, the open one, or a new text box).
  // The "target" is only what the dictation session reads: the words in the editor now.
  // Where a new dictation box goes when nothing is being edited: under the note's content.
  const insertPoint = () => voiceInsertPoint(shell.contentBounds(shell.edits.doc.objects, (object) => shell.canvas().sizeOf(object) ?? {}), { columns: state.pages.columns, pageWidth })
  function createTextBox() {
    const layout = pageBoundedTextLayout(insertPoint(), { pageWidth })
    const { fresh } = shell.canvas().beginDictation({ x: layout.x, y: layout.y }, { width: layout.width })
    voiceShown = shell.canvas().dictationText() ?? ''
    return { __voiceDictationBox: fresh, get text() { return shell.canvas().dictationText() ?? '' } }
  }
  function removeEmptyTextBox() {
    const target = dictationSession.target
    if (dictationSession.active && dictationSession.partial) updateTextBox(dictationSession.preview(''), { create: false })
    if (target?.__voiceDictationBox && !target.text.trim() && shell.canvas().isEditingText()) shell.canvas().finishTextEdit() // a new box nothing was said into is never made
  }
  function updateTextBox(text, { record = false, create = true } = {}) {
    if (shell.voiceSink) return // words go to the sink, never into a box
    const canvas = shell.canvas()
    if (!dictationSession.target || !canvas.isEditingText()) { // the editor was closed meanwhile: what comes next goes in a new text box
      if (!create) return
      const shown = voiceShown
      dictationSession.target = createTextBox()
      dictationSession.committed = ''
      text = text.startsWith(shown) ? text.slice(shown.length).trim() : text
    }
    canvas.setDictation(text)
    voiceShown = text
    if (record) canvas.flushText() // final words are in the document (and a save) now, inside the same typing session
  }
  const previewTranscript = (transcript, options) => {
    const text = dictationSession.preview(transcript, options)
    if (shell.voiceSink) shell.voiceSink.heard(dictationSession.partial, { final: false })
    else updateTextBox(text)
  }
  function insertTranscript(transcript) {
    if (!transcript) return
    if (shell.voiceSink) { // a jam is listening: the finished sentence goes to it, not into a text box (and counts no words for the island)
      dictationSession.commit(transcript)
      shell.voiceSink.heard(transcript, { final: true })
      return
    }
    voiceWords += shell.countWords(transcript)
    updateTextBox(dictationSession.commit(transcript), { record: true })
  }
  let noticeTimer
  function showNotice(message, duration = 2600) {
    voiceCaption.hidden = false
    voiceStatus.textContent = message
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => { if (!state.listening) voiceCaption.hidden = true }, duration)
  }
  // Every way a dictation ends without words ends the same way: the box nothing was said into goes, the session stops, the mic is idle.
  function abandon() {
    voiceMode = null
    removeEmptyTextBox()
    dictationSession.cancel()
    setListening(false)
  }

  // ---- the local engine ----
  function completeLocal(message = '') {
    clearTimeout(finishTimer)
    localTranscription?.disconnect()
    localTranscription = null
    microphoneCapture = null
    voiceMode = null
    removeEmptyTextBox()
    dictationSession.finish()
    setListening(false)
    if (message) showNotice(message)
  }
  async function stopLocal({ cancel = false } = {}) {
    attemptCount += 1
    await microphoneCapture?.stop()
    microphoneCapture = null
    if (cancel) {
      localTranscription?.cancel()
      localTranscription = null
      abandon()
      return
    }
    localTranscription?.finish()
    voiceStatus.textContent = 'Finishing transcript'
    finishTimer = setTimeout(() => completeLocal(), 4000)
  }
  async function startLocal(attempt, endpoint) {
    const { LocalTranscriptionProvider, MicrophonePcmCapture } = await import('./capture.js')
    // The server picks the engine's port (8080 when free), so the page uses the endpoint it reports.
    const provider = new LocalTranscriptionProvider(endpoint ? { endpoint, connectionTimeout: 3000 } : {})
    localTranscription = provider
    await provider.connect({
      language: (navigator.language || 'en').split('-')[0],
      onPartial: (text) => {
        voiceStatus.textContent = text || 'Listening locally'
        previewTranscript(text, { append: true })
      },
      onFinal: (text) => {
        if (!dictationSession.active) return
        voiceStatus.textContent = text || 'Listening locally'
        insertTranscript(text)
        if (!microphoneCapture) completeLocal()
      },
      onError: async () => {
        await microphoneCapture?.stop()
        completeLocal('Local transcription became unavailable; no audio was saved')
      },
    })
    if (attempt !== attemptCount) {
      provider.cancel()
      return false
    }
    const capture = new MicrophonePcmCapture()
    microphoneCapture = capture
    await capture.start((audio) => { provider.sendAudio(audio); island.level(pcmLevel(audio)) })
    if (attempt !== attemptCount) {
      await capture.stop()
      provider.cancel()
      return false
    }
    voiceMode = 'local'
    setListening(true, 'Listening locally')
    return true
  }

  // ---- the browser's own recognition, when the local engine cannot be used ----
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
  if (SpeechRecognition) {
    recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-US'
    recognition.onstart = () => {
      voiceMode = 'browser'
      setListening(true, 'Local service unavailable · using browser voice; Personal Note retains transcript only')
    }
    recognition.onresult = (event) => {
      const update = dictationSession.accept(event.results, event.resultIndex)
      voiceStatus.textContent = update.partial || update.stable.at(-1) || 'Listening'
      update.stable.forEach(insertTranscript)
      previewTranscript(update.partial)
    }
    recognition.onerror = (event) => {
      voiceError = event.error === 'not-allowed' ? 'Microphone permission is required' : 'Voice input stopped'
      if (event.error === 'not-allowed') dictationSession.cancel()
    }
    recognition.onend = () => {
      voiceMode = null
      removeEmptyTextBox()
      dictationSession.finish()
      setListening(false)
      if (voiceError) {
        showNotice(voiceError)
        voiceError = null
      }
    }
  }

  async function toggle() {
    if (state.listening) {
      if (voiceMode === 'browser') recognition.stop()
      else await stopLocal({ cancel: voiceMode !== 'local' })
      return
    }
    dictationSession.start(shell.voiceSink ? { text: '' } : createTextBox())
    const attempt = attemptCount + 1
    attemptCount = attempt
    voiceMode = 'connecting'
    setListening(true, 'Connecting local voice')
    const plan = await prepareLocalVoice(client, { onStarting: () => { voiceStatus.textContent = 'Starting voice' } })
    if (attempt !== attemptCount) return
    if (plan.blocked && (shell.inAppWindow() || !recognition)) {
      // Not ready: say why and take the user to where it is fixed, never fail silently.
      abandon()
      showNotice(plan.blocked, 6000)
      openSettings()
      return
    }
    try {
      if (!plan.blocked && await startLocal(attempt, plan.endpoint)) return
    } catch (error) {
      localTranscription?.cancel()
      localTranscription = null
      await microphoneCapture?.stop()
      microphoneCapture = null
      if (attempt !== attemptCount) return
      if (error?.name === 'NotAllowedError') {
        abandon()
        showNotice('Microphone permission is required')
        return
      }
    }
    if (!recognition) {
      abandon()
      showNotice('Voice is unavailable. Start the loopback transcription service; no audio was retained.')
      return
    }
    try {
      recognition.start()
    } catch {
      abandon()
      showNotice('Voice input could not start')
    }
  }

  // Dictation ends when a switch to another note starts: the words already final stay in the note being left (and go out with its save);
  // an interim result still being heard is dropped, and nothing more arrives for the new note.
  async function stopForSwitch() {
    if (!state.listening) return
    if (dictationSession.active && dictationSession.partial) updateTextBox(dictationSession.preview(''), { create: false }) // the interim words go first (before anything is awaited)
    if (voiceMode === 'browser') {
      recognition?.abort?.()
      abandon()
    } else await stopLocal({ cancel: true })
    shell.canvas()?.finishTextEdit()
  }

  // ---- the buttons ----
  // Hold to talk (release stops), or tap once to keep listening and tap again to stop.
  const pressToTalk = createPressToTalk({ toggle, isListening: () => state.listening })
  on(voiceButton, 'pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    voiceButton.setPointerCapture?.(event.pointerId)
    void pressToTalk.press()
  })
  on(voiceButton, 'pointerup', (event) => {
    voiceButton.releasePointerCapture?.(event.pointerId)
    void pressToTalk.release()
  })
  on(voiceButton, 'pointercancel', () => void pressToTalk.release())
  on(voiceButton, 'contextmenu', (event) => event.preventDefault())
  // Keyboard activation arrives as a click with no pointer; pointer clicks are handled above.
  on(voiceButton, 'click', (event) => { if (event.detail === 0) void toggle() })

  const mobileHold = createMobileHoldController({
    start: async () => { if (!state.listening) await toggle() },
    finish: async () => { if (state.listening) await toggle() },
    cancel: async () => { if (state.listening) await toggle() },
  })
  on(mobileSpeak, 'pointerdown', async (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    mobileSpeak.setPointerCapture?.(event.pointerId)
    await mobileHold.press(event)
  })
  on(mobileSpeak, 'pointerup', async (event) => {
    event.preventDefault()
    mobileSpeak.releasePointerCapture?.(event.pointerId)
    await mobileHold.release()
  })
  on(mobileSpeak, 'pointercancel', async () => mobileHold.cancel())
  on(mobileSpeak, 'contextmenu', (event) => event.preventDefault())

  for (const part of [voiceButton, voiceDivider, mobileSpeak]) part.hidden = false
  void refreshSetup()

  return {
    toggle,
    stopForSwitch,
    refreshSetup,
    onSettingsOpen: refreshSetup,
    voiceBoxPoint: () => pageBoundedTextLayout(insertPoint(), { pageWidth }),
    // Off: dictation stops (words already final stay in the note), the mic and the Settings row go, nothing is left listening or polling.
    async dispose() {
      await stopForSwitch()
      listeners.abort()
      clearTimeout(poll)
      clearTimeout(noticeTimer)
      islandDownload('voice', 'Voice model', null)
      for (const part of [voiceButton, voiceDivider, mobileSpeak, voiceCaption]) part.hidden = true
      section.remove()
    },
  }
}
