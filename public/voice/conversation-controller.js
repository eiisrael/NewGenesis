import { VOICE_STATES, VoiceStateMachine } from './state-machine.js';
import { normalizeSpokenText, similarityToPlayback, takeStableSentences } from './speech-normalizer.js';

export class VoiceConversationController {
  constructor({ settings, inputEngines, playback, submitTranscript, onInterim, onState, onLevel, onStatus, onMetric } = {}) {
    this.settings = settings;
    this.inputEngines = inputEngines;
    this.playback = playback;
    this.callbacks = { submitTranscript, onInterim, onState, onLevel, onStatus, onMetric };
    this.machine = new VoiceStateMachine();
    this.machine.subscribe(event => this.callbacks.onState?.(event));
    this.conversationEnabled = settings.conversationMode === true;
    this.inputEngine = null;
    this.inputActive = false;
    this.bargeMonitor = false;
    this.bargeCandidate = false;
    this.chatFinished = true;
    this.chatBuffer = '';
    this.firstTextSeen = false;
    this.suppressPlaybackIdle = false;
    this.restartQueued = false;
    this.manualSpeech = false;
    this.microphoneTestActive = false;
    this.pushToTalkDeadline = 0;
    this.pushToTalkRetry = null;
    this.pushToTalkTimeout = null;
    this.metrics = [];
    this.destroyed = false;
    this.#bindPlayback();
  }

  updateSettings(settings) {
    this.settings = settings;
    this.conversationEnabled = settings.conversationMode === true;
  }

  async startConversation() {
    this.conversationEnabled = true;
    this.settings.conversationMode = true;
    if ([VOICE_STATES.THINKING, VOICE_STATES.SPEAKING, VOICE_STATES.TRANSCRIBING].includes(this.machine.current)) return;
    await this.listen({ once: false });
  }

  stopConversation() {
    this.conversationEnabled = false;
    this.settings.conversationMode = false;
    this.stopAll('conversation-disabled');
  }

  async togglePushToTalk() {
    if ([VOICE_STATES.LISTENING, VOICE_STATES.SPEECH_DETECTED, VOICE_STATES.TRANSCRIBING].includes(this.machine.current)) {
      this.#cancelPushToTalkRetry();
      this.stopInput();
      this.machine.reset({ reason: 'push-to-talk-stop' });
      return;
    }
    this.#cancelPlayback('push-to-talk');
    this.#armPushToTalkWindow({ testOnly: false });
    await this.listen({ once: true });
  }

  async testMicrophone() {
    if ([VOICE_STATES.LISTENING, VOICE_STATES.SPEECH_DETECTED, VOICE_STATES.TRANSCRIBING].includes(this.machine.current)) {
      this.#cancelPushToTalkRetry();
      this.microphoneTestActive = false;
      this.stopInput();
      this.machine.reset({ reason: 'microphone-test-stop' });
      this.callbacks.onStatus?.('idle');
      return false;
    }
    this.#cancelPlayback('microphone-test');
    this.microphoneTestActive = true;
    this.#armPushToTalkWindow({ testOnly: true });
    await this.listen({ once: true, testOnly: true });
    return true;
  }

  async listen({ once = false, playbackActive = false, testOnly = false } = {}) {
    if (this.destroyed) return;
    const engine = this.#selectInputEngine();
    if (!engine) {
      const error = voiceError('stt_unavailable', this.settings.preferLocal
        ? 'O modo 100% local está ativo, mas o Whisper local não está disponível.'
        : 'Nenhum mecanismo de reconhecimento de voz está disponível.');
      this.#fail(error);
      throw error;
    }
    this.stopInput();
    this.inputEngine = engine;
    this.bargeMonitor = playbackActive;
    this.bargeCandidate = false;
    if (!playbackActive) this.#transition(VOICE_STATES.LISTENING, { engine: engine.id, once });
    const options = {
      lang: 'pt-BR',
      vadThreshold: this.settings.vadThreshold,
      vadSilenceMs: this.settings.vadSilenceMs,
      quality: this.settings.quality,
      playbackActive,
      onStart: () => {
        this.inputActive = true;
        this.callbacks.onStatus?.(playbackActive ? 'barge-ready' : 'listening');
      },
      onLevel: level => this.callbacks.onLevel?.(level),
      onSpeechStart: detail => this.#onSpeechStart(detail),
      onInterim: text => this.callbacks.onInterim?.(text),
      onTranscribing: detail => this.#onTranscribing(detail),
      onFinal: (text, detail) => this.#onTranscript(text, detail, { once, testOnly }),
      onEnd: detail => this.#onInputEnd(detail, { once, playbackActive, testOnly }),
      onError: error => this.#onInputError(error, { once, playbackActive, testOnly })
    };
    try { await engine.start(options); }
    catch (error) { this.#onInputError(error, { once, playbackActive }); throw error; }
  }

  stopInput() {
    this.inputEngine?.stop?.();
    this.inputActive = false;
    this.bargeMonitor = false;
  }

  onChatStart() {
    if ([VOICE_STATES.LISTENING, VOICE_STATES.SPEECH_DETECTED].includes(this.machine.current)) this.stopInput();
    this.chatFinished = false;
    this.chatBuffer = '';
    this.firstTextSeen = false;
    this.mark('voice.chat_start');
    if (this.machine.current !== VOICE_STATES.THINKING) this.#transition(VOICE_STATES.THINKING, { source: 'chat' });
  }

  onChatDelta(delta) {
    const value = String(delta || '');
    if (!value) return;
    if (!this.firstTextSeen) {
      this.firstTextSeen = true;
      this.mark('voice.first_text');
    }
    this.chatBuffer += value;
    if (!this.settings.autoSpeak) return;
    const { chunks, rest } = takeStableSentences(this.chatBuffer);
    this.chatBuffer = rest;
    this.#enqueueChunks(chunks);
  }

  onChatEnd(fullText = '') {
    this.chatFinished = true;
    if (this.settings.autoSpeak) {
      if (!this.firstTextSeen && fullText) this.chatBuffer = fullText;
      const { chunks } = takeStableSentences(this.chatBuffer, { flush: true });
      this.chatBuffer = '';
      this.#enqueueChunks(chunks);
    }
    if (!this.settings.autoSpeak || (!this.playback.running && !this.playback.queue.length)) this.#resumeAfterTurn();
  }

  onChatError(error) {
    this.chatFinished = true;
    this.chatBuffer = '';
    this.#cancelPlayback('chat-error');
    this.callbacks.onStatus?.('chat-error', error);
    this.#resumeAfterTurn();
  }

  speakText(text) {
    const spoken = normalizeSpokenText(text);
    if (!spoken) return false;
    if (this.manualSpeech && this.playback.running) {
      this.callbacks.onStatus?.('tts-busy');
      return false;
    }
    this.stopInput();
    this.#cancelPlayback('manual-speak');
    this.manualSpeech = true;
    this.chatFinished = true;
    this.playback.enqueue(spoken, this.settings);
    return true;
  }

  interrupt() {
    if (this.machine.current !== VOICE_STATES.SPEAKING) return;
    this.#transition(VOICE_STATES.INTERRUPTING, { reason: 'barge-in' });
    this.mark('voice.barge_in');
    this.playback.cancel('barge-in');
    this.callbacks.onStatus?.('interrupted');
  }

  stopAll(reason = 'cancelled') {
    this.#cancelPushToTalkRetry();
    this.manualSpeech = false;
    this.microphoneTestActive = false;
    this.stopInput();
    this.#cancelPlayback(reason);
    this.chatBuffer = '';
    this.machine.reset({ reason });
    this.callbacks.onLevel?.(0);
    this.callbacks.onStatus?.('idle');
  }

  async destroy() {
    this.destroyed = true;
    this.stopAll('destroy');
    await Promise.allSettled(Object.values(this.inputEngines).map(engine => engine?.close?.()));
  }

  mark(name, detail = {}) {
    const event = Object.freeze({ name, at: performanceNow(), detail: { ...detail } });
    this.metrics.push(event);
    if (this.metrics.length > 200) this.metrics.shift();
    this.callbacks.onMetric?.(event);
    return event;
  }

  diagnostics() {
    return {
      state: this.machine.current,
      conversationEnabled: this.conversationEnabled,
      inputActive: this.inputActive,
      playbackActive: this.playback.running,
      metrics: [...this.metrics]
    };
  }

  #selectInputEngine() {
    const local = this.inputEngines.local;
    const browser = this.inputEngines.browser;
    if (this.settings.preferLocal) return local?.available ? withId(local, 'local') : null;
    if (this.settings.sttEngine === 'local') return local?.available ? withId(local, 'local') : null;
    if (this.settings.sttEngine === 'browser') return browser?.available ? withId(browser, 'browser') : null;
    if (local?.available) return withId(local, 'local');
    return browser?.available ? withId(browser, 'browser') : null;
  }

  #onSpeechStart(detail) {
    this.mark('voice.vad_start', { engine: detail.engine });
    if (this.machine.current === VOICE_STATES.SPEAKING) {
      this.bargeCandidate = true;
      this.interrupt();
    }
    this.#transition(VOICE_STATES.SPEECH_DETECTED, { engine: detail.engine, bargeIn: this.bargeCandidate });
    this.callbacks.onStatus?.('speech-detected');
  }

  #onTranscribing(detail) {
    this.mark('voice.vad_end', { engine: detail.engine });
    this.mark('voice.stt_start', { engine: detail.engine });
    this.#transition(VOICE_STATES.TRANSCRIBING, { engine: detail.engine });
    this.callbacks.onStatus?.('transcribing');
  }

  #onTranscript(text, detail, { once, testOnly = false }) {
    const transcript = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 12000);
    if (!transcript) return;
    if (once) this.#cancelPushToTalkRetry();
    if (this.bargeCandidate && transcript.split(/\s+/).length >= 3 && similarityToPlayback(transcript, this.playback.lastSpokenText) >= 0.72) {
      this.callbacks.onStatus?.('feedback-ignored');
      this.mark('voice.feedback_ignored', { engine: detail.engine });
      this.bargeCandidate = false;
      this.#resumeAfterTurn();
      return;
    }
    this.mark('voice.stt_final', { engine: detail.engine, latencyMs: detail.latencyMs });
    if (testOnly) {
      this.microphoneTestActive = false;
      this.stopInput();
      this.#cancelPushToTalkRetry();
      this.machine.reset({ reason: 'microphone-test-complete' });
      this.callbacks.onStatus?.('microphone-ok', { transcript, engine: detail.engine });
      return;
    }
    this.callbacks.onInterim?.(transcript, { final: true });
    if (!this.settings.autoSend) {
      this.machine.reset({ reason: 'transcript-ready' });
      return;
    }
    this.#transition(VOICE_STATES.THINKING, { engine: detail.engine });
    this.callbacks.onStatus?.('thinking');
    const submitted = this.callbacks.submitTranscript?.(transcript, { once, engine: detail.engine });
    if (submitted === false) {
      this.callbacks.onStatus?.('chat-error', voiceError('chat_busy', 'O chat não aceitou a transcrição porque já existe uma resposta em andamento.'));
      this.#resumeAfterTurn();
    }
  }

  #onInputEnd(detail, { once, playbackActive, testOnly = false }) {
    this.inputActive = false;
    if (detail.transcript || this.machine.current === VOICE_STATES.THINKING) return;
    if (this.machine.current === VOICE_STATES.TRANSCRIBING) {
      this.#recoverNoSpeech({ once, playbackActive, engine: detail.engine, testOnly });
      return;
    }
    if (playbackActive && this.playback.running) {
      queueMicrotask(() => this.#armBargeMonitor());
      return;
    }
    if (this.conversationEnabled && !once && this.chatFinished) this.#scheduleConversationListen();
    else if (this.machine.current !== VOICE_STATES.ERROR) this.machine.reset({ reason: 'input-ended' });
  }

  #onInputError(error, { once, playbackActive, testOnly = false }) {
    this.inputActive = false;
    if (error?.code === 'browser_stt_no-speech') {
      this.#recoverNoSpeech({ once, playbackActive, engine: 'browser', testOnly });
      return;
    }
    this.#fail(error);
  }

  #recoverNoSpeech({ once, playbackActive, engine, testOnly = false }) {
    this.bargeCandidate = false;
    this.callbacks.onInterim?.('', { final: true });
    this.callbacks.onStatus?.('no-speech');
    this.mark('voice.stt_empty', { engine });
    if (playbackActive && this.playback.running) {
      queueMicrotask(() => this.#armBargeMonitor());
      return;
    }
    if (once && Date.now() < this.pushToTalkDeadline) {
      this.#transition(VOICE_STATES.LISTENING, { reason: 'push-to-talk-waiting' });
      this.#schedulePushToTalkListen({ testOnly });
      return;
    }
    if (once) this.#cancelPushToTalkRetry();
    if (this.conversationEnabled && !once && this.chatFinished) {
      this.#transition(VOICE_STATES.LISTENING, { reason: 'no-speech' });
      this.#scheduleConversationListen();
    } else if (this.machine.current !== VOICE_STATES.ERROR) {
      this.machine.reset({ reason: 'no-speech' });
    }
  }

  #scheduleConversationListen() {
    if (this.restartQueued) return;
    this.restartQueued = true;
    queueMicrotask(() => {
      this.restartQueued = false;
      if (this.destroyed || !this.conversationEnabled || !this.chatFinished || this.inputActive) return;
      this.listen({ once: false }).catch(() => {});
    });
  }

  #schedulePushToTalkListen({ testOnly = this.microphoneTestActive } = {}) {
    if (this.pushToTalkRetry) return;
    this.pushToTalkRetry = setTimeout(() => {
      this.pushToTalkRetry = null;
      if (this.destroyed || Date.now() >= this.pushToTalkDeadline || this.inputActive || this.machine.current !== VOICE_STATES.LISTENING) {
        if (Date.now() >= this.pushToTalkDeadline && this.machine.current !== VOICE_STATES.ERROR) this.machine.reset({ reason: 'push-to-talk-timeout' });
        return;
      }
      this.listen({ once: true, testOnly }).catch(() => {});
    }, 250);
  }

  #armPushToTalkWindow({ testOnly }) {
    this.#cancelPushToTalkRetry();
    this.microphoneTestActive = testOnly === true;
    this.pushToTalkDeadline = Date.now() + 15_000;
    this.pushToTalkTimeout = setTimeout(() => {
      this.pushToTalkTimeout = null;
      this.pushToTalkDeadline = 0;
      if (this.destroyed || ![VOICE_STATES.LISTENING, VOICE_STATES.SPEECH_DETECTED].includes(this.machine.current)) return;
      this.stopInput();
      this.microphoneTestActive = false;
      this.machine.reset({ reason: testOnly ? 'microphone-test-timeout' : 'push-to-talk-timeout' });
      this.callbacks.onStatus?.(testOnly ? 'microphone-timeout' : 'no-speech');
    }, 15_000);
  }

  #cancelPushToTalkRetry() {
    if (this.pushToTalkRetry) clearTimeout(this.pushToTalkRetry);
    if (this.pushToTalkTimeout) clearTimeout(this.pushToTalkTimeout);
    this.pushToTalkRetry = null;
    this.pushToTalkTimeout = null;
    this.pushToTalkDeadline = 0;
  }

  #enqueueChunks(chunks) {
    for (const chunk of chunks) {
      const spoken = normalizeSpokenText(chunk);
      if (spoken) this.playback.enqueue(spoken, this.settings);
    }
  }

  #bindPlayback() {
    Object.assign(this.playback.callbacks, {
      ...this.playback.callbacks,
      onPrepare: detail => {
        this.#transition(VOICE_STATES.SPEAKING, { engine: detail.engine, preparing: true });
        this.callbacks.onStatus?.('tts-preparing', detail);
      },
      onStart: detail => {
        this.mark('voice.tts_start', { engine: detail.engine });
        this.#transition(VOICE_STATES.SPEAKING, { engine: detail.engine });
        this.callbacks.onStatus?.('speaking', detail);
        if (!this.manualSpeech) this.#armBargeMonitor();
      },
      onFirstAudio: detail => this.mark('voice.first_audio', detail),
      onEnd: detail => this.mark('voice.tts_end', detail),
      onIdle: detail => {
        if (this.suppressPlaybackIdle) return;
        if (detail.cancelled && [VOICE_STATES.INTERRUPTING, VOICE_STATES.SPEECH_DETECTED, VOICE_STATES.TRANSCRIBING].includes(this.machine.current)) return;
        this.stopInput();
        if (this.manualSpeech) {
          this.manualSpeech = false;
          this.machine.reset({ reason: 'manual-speech-complete' });
          this.callbacks.onStatus?.('idle');
          return;
        }
        if (this.chatFinished) this.#resumeAfterTurn();
        else this.#transition(VOICE_STATES.THINKING, { reason: 'awaiting-text' });
      },
      onFallback: detail => this.callbacks.onStatus?.('tts-fallback', detail),
      onError: error => this.#fail(error)
    });
  }

  #armBargeMonitor() {
    if (!this.conversationEnabled || !this.playback.running || this.inputActive) return;
    this.listen({ playbackActive: true }).catch(error => {
      this.callbacks.onStatus?.('barge-unavailable', error);
    });
  }

  #cancelPlayback(reason) {
    this.suppressPlaybackIdle = true;
    try { this.playback.cancel(reason); }
    finally { this.suppressPlaybackIdle = false; }
  }

  #resumeAfterTurn() {
    if (this.conversationEnabled) {
      this.#transition(VOICE_STATES.LISTENING, { reason: 'auto-resume' });
      this.#scheduleConversationListen();
    } else {
      this.machine.reset({ reason: 'turn-complete' });
      this.callbacks.onStatus?.('idle');
    }
  }

  #fail(error) {
    this.#cancelPushToTalkRetry();
    this.manualSpeech = false;
    this.microphoneTestActive = false;
    this.stopInput();
    if (this.machine.current !== VOICE_STATES.ERROR) this.#transition(VOICE_STATES.ERROR, { code: error?.code, message: error?.message });
    this.callbacks.onStatus?.('error', error);
  }

  #transition(next, detail) {
    if (this.machine.current === next) return;
    if (this.machine.can(next)) this.machine.transition(next, detail);
    else {
      this.machine.reset({ reason: 'transition-recovery' });
      if (next !== VOICE_STATES.IDLE) this.machine.transition(next, detail);
    }
  }
}

function withId(engine, id) {
  engine.id = id;
  return engine;
}

function performanceNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function voiceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
