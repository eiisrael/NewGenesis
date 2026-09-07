import { MicrophoneAudioInput } from './audio-input.js';

export class BrowserSpeechInputEngine {
  constructor(Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null) {
    this.Recognition = Recognition;
    this.recognition = null;
    this.finalTranscript = '';
    this.generation = 0;
  }

  get available() { return Boolean(this.Recognition); }

  start(options = {}) {
    if (!this.available) throw engineError('browser_stt_unavailable', 'Reconhecimento de voz do navegador indisponível.');
    this.stop();
    this.finalTranscript = '';
    const recognition = new this.Recognition();
    const generation = this.generation;
    let finalTranscript = '';
    let terminalError = false;
    const current = () => this.recognition === recognition && this.generation === generation;
    this.recognition = recognition;
    recognition.lang = options.lang || 'pt-BR';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => { if (current()) options.onStart?.({ engine: 'browser' }); };
    recognition.onspeechstart = () => { if (current()) options.onSpeechStart?.({ engine: 'browser' }); };
    recognition.onresult = event => {
      if (!current()) return;
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = String(event.results[index]?.[0]?.transcript || '').trim();
        if (event.results[index].isFinal) finalTranscript = `${finalTranscript} ${transcript}`.trim();
        else interim = `${interim} ${transcript}`.trim();
      }
      this.finalTranscript = finalTranscript;
      options.onInterim?.(`${finalTranscript} ${interim}`.trim());
    };
    recognition.onerror = event => {
      if (!current()) return;
      terminalError = true;
      options.onError?.(engineError(browserRecognitionCode(event.error), browserRecognitionMessage(event.error)));
    };
    recognition.onend = () => {
      if (!current()) return;
      const transcript = finalTranscript.trim();
      this.recognition = null;
      if (terminalError) return;
      if (transcript) {
        options.onTranscribing?.({ engine: 'browser' });
        options.onFinal?.(transcript, { engine: 'browser' });
      }
      if (generation === this.generation) options.onEnd?.({ engine: 'browser', transcript });
    };
    recognition.start();
  }

  stop() {
    const recognition = this.recognition;
    this.recognition = null;
    this.generation += 1;
    if (!recognition) return;
    for (const name of ['onstart', 'onspeechstart', 'onresult', 'onerror', 'onend']) recognition[name] = null;
    try { recognition.abort?.(); } catch { /* já finalizado */ }
  }

  close() { this.stop(); }
}

export class LocalSpeechInputEngine {
  constructor({ endpoint = '/api/voice/transcribe', audioInput, requestTimeoutMs = 20_000 } = {}) {
    this.endpoint = endpoint;
    this.audioInput = audioInput || new MicrophoneAudioInput();
    this.activeController = null;
    this.callbacks = {};
    this.serverAvailable = false;
    this.requestTimeoutMs = Number.isFinite(Number(requestTimeoutMs)) && Number(requestTimeoutMs) > 0 ? Number(requestTimeoutMs) : null;
    this.generation = 0;
    this.audioInput.callbacks = {
      onLevel: level => this.callbacks.onLevel?.(level),
      onSpeechStart: detail => this.callbacks.onSpeechStart?.({ ...detail, engine: 'local' }),
      onSpeechEnd: (blob, detail) => this.#transcribe(blob, detail),
      onError: error => this.callbacks.onError?.(error)
    };
  }

  get available() { return this.serverAvailable && this.audioInput.available; }

  setAvailable(available) { this.serverAvailable = available === true; }

  async start(options = {}) {
    if (!this.available) throw engineError('local_stt_unavailable', 'Whisper local não está instalado ou configurado.');
    this.stop();
    const generation = this.generation;
    this.callbacks = options;
    let armed;
    try {
      armed = await this.audioInput.arm({
        threshold: options.vadThreshold,
        silenceMs: options.vadSilenceMs,
        playbackActive: options.playbackActive === true
      });
    } catch (error) {
      if (generation !== this.generation) return false;
      throw error;
    }
    if (generation !== this.generation || armed === false) return false;
    options.onStart?.({ engine: 'local' });
    return true;
  }

  stop() {
    this.generation += 1;
    this.activeController?.abort();
    this.activeController = null;
    this.audioInput.disarm();
  }

  setPlaybackActive(active) { this.audioInput.setPlaybackActive(active); }

  async close() {
    this.stop();
    await this.audioInput.close();
  }

  async #transcribe(blob, detail) {
    const controller = new AbortController();
    const generation = this.generation;
    const callbacks = this.callbacks;
    const quality = ['rapid', 'balanced', 'accurate'].includes(callbacks.quality) ? callbacks.quality : 'rapid';
    const requestTimeoutMs = this.requestTimeoutMs || ({ rapid: 20_000, balanced: 32_000, accurate: 52_000 }[quality]);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    this.activeController = controller;
    callbacks.onTranscribing?.({ ...detail, engine: 'local' });
    try {
      const response = await fetch(`${this.endpoint}?quality=${encodeURIComponent(quality)}&segmented=1`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', 'x-genesis-client': 'web' },
        body: blob,
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw engineError(payload?.error?.code || 'local_stt_failed', payload?.error?.message || `Whisper local falhou (${response.status}).`);
      const transcript = String(payload.text || '').trim();
      if (generation !== this.generation) return;
      const resultDetail = { ...detail, engine: 'local', latencyMs: payload.latencyMs, confidence: payload.confidence, noSpeechProbability: payload.noSpeechProbability };
      if (transcript) callbacks.onFinal?.(transcript, resultDetail);
      if (generation === this.generation) callbacks.onEnd?.({ ...resultDetail, transcript });
    } catch (error) {
      if (timedOut && generation === this.generation) callbacks.onError?.(engineError('local_stt_timeout', `A transcrição local excedeu ${Math.round(requestTimeoutMs / 1000)} segundos. Tente novamente ou use o reconhecimento do navegador.`));
      else if (error?.name !== 'AbortError' && generation === this.generation) callbacks.onError?.(error);
    } finally {
      clearTimeout(timer);
      if (this.activeController === controller) this.activeController = null;
    }
  }
}

export class LocalTextToSpeechEngine {
  constructor({ endpoint = '/api/voice/synthesize', engine, requestTimeoutMs } = {}) {
    this.endpoint = endpoint;
    this.engine = engine;
    this.serverAvailable = false;
    this.controllers = new Set();
    this.context = null;
    this.source = null;
    this.generation = 0;
    this.warm = false;
    this.health = 'unknown';
    this.requestTimeoutMs = Number(requestTimeoutMs) || ({ kokoro: 30_000, piper: 62_000, chatterbox: 62_000 }[engine] || 47_000);
  }

  get available() { return this.serverAvailable && Boolean(globalThis.AudioContext || globalThis.webkitAudioContext); }

  setAvailable(available) { this.serverAvailable = available === true; }

  setStatus(status = {}) {
    this.serverAvailable = status.available === true;
    this.warm = status.warm === true || status.ready === true;
    this.health = String(status.health || (this.warm ? 'healthy' : 'unknown'));
  }

  async unlock() {
    if (!this.available) return false;
    await this.#ensureAudioContext();
    return this.context?.state === 'running';
  }

  async prepare(text, options = {}) {
    if (!this.available) throw engineError(`${this.engine}_unavailable`, `${this.engine} não está instalado ou configurado.`);
    // Preserve the user gesture before a cold local synthesis consumes it.
    const contextReady = this.#ensureAudioContext();
    contextReady.catch(() => {});
    const controller = new AbortController();
    const generation = this.generation;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    this.controllers.add(controller);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-genesis-client': 'web' },
        body: JSON.stringify({ text, engine: this.engine, preset: options.preset, rate: options.rate, voice: options.ttsVoice }),
        signal: controller.signal
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw engineError(payload?.error?.code || `${this.engine}_failed`, payload?.error?.message || `${this.engine} falhou (${response.status}).`);
      }
      const audioBytes = await response.arrayBuffer();
      if (!audioBytes.byteLength) throw engineError(`${this.engine}_empty_audio`, 'O engine local retornou áudio vazio.');
      let buffer;
      try {
        await contextReady;
        buffer = await this.context.decodeAudioData(audioBytes.slice(0));
      } catch (error) {
        throw audioOutputError(error, this.engine);
      }
      if (generation !== this.generation) throw new DOMException('Síntese cancelada.', 'AbortError');
      options.onPrepared?.();
      return { buffer, generation, rate: Math.min(1.6, Math.max(0.7, Number(options.rate) || 1)) };
    } catch (error) {
      if (timedOut && error?.name === 'AbortError') throw engineError(`${this.engine}_timeout`, `${this.engine} não preparou o áudio dentro do limite de tempo.`);
      throw error;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  async play(prepared, options = {}) {
    if (!prepared?.buffer || prepared.generation !== this.generation) throw new DOMException('Reprodução cancelada.', 'AbortError');
    if (this.context.state === 'suspended') await this.context.resume();
    if (this.context.state && this.context.state !== 'running') throw engineError('audio_output_blocked', 'A saída de áudio não entrou em estado de reprodução.');
    const source = this.context.createBufferSource();
    source.buffer = prepared.buffer;
    source.playbackRate.value = prepared.rate;
    source.connect(this.context.destination);
    this.source = source;
    await new Promise((resolve, reject) => {
      let settled = false;
      const expectedMs = Math.max(250, (Number(prepared.buffer.duration) || 0) * 1000 / prepared.rate);
      const timer = setTimeout(() => finish(audioOutputStalled(this.engine)), Math.min(120_000, expectedMs + 3_000));
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.source === source) this.source = null;
        try { source.disconnect(); } catch {}
        if (error) reject(error); else resolve();
      };
      source.onended = () => finish();
      try {
        source.start(0);
        options.onFirstAudio?.();
      } catch (error) {
        finish(audioOutputError(error, this.engine));
      }
    });
  }

  async speak(text, options = {}) {
    const prepared = await this.prepare(text, options);
    return this.play(prepared, options);
  }

  cancel() {
    this.generation += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    const source = this.source;
    this.source = null;
    if (source) {
      try { source.stop(0); } catch {}
      try { source.disconnect(); } catch {}
    }
  }

  async #ensureAudioContext() {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw engineError('audio_output_unavailable', 'A saída de áudio não está disponível neste navegador.');
    this.context ||= new AudioContextClass({ latencyHint: 'interactive' });
    if (this.context.state === 'suspended') {
      try { await this.context.resume(); }
      catch (error) { throw audioOutputError(error, this.engine); }
    }
    return this.context;
  }
}

export class SystemTextToSpeechEngine {
  constructor({ synthesis = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance } = {}) {
    this.synthesis = synthesis;
    this.Utterance = Utterance;
    this.generation = 0;
    this.utterance = null;
    this.cancelPending = null;
    this.warm = true;
  }

  get available() { return Boolean(this.synthesis?.speak && this.Utterance); }

  async unlock() {
    if (!this.available) return false;
    try { this.synthesis.resume?.(); } catch {}
    await this.#voices();
    return true;
  }

  async prepare(text, options = {}) {
    if (!this.available) throw engineError('system_voice_unavailable', 'A voz rápida do sistema não está disponível.');
    const voices = await this.#voices();
    const voice = selectLocalPortugueseVoice(voices);
    if (!voice) throw engineError('system_voice_unavailable', 'Nenhuma voz pt-BR local foi encontrada no sistema.');
    return { text: String(text || ''), voice, generation: this.generation, rate: Math.min(1.6, Math.max(0.7, Number(options.rate) || 1)) };
  }

  async play(prepared, options = {}) {
    if (!prepared?.text || prepared.generation !== this.generation) throw new DOMException('Reprodução cancelada.', 'AbortError');
    const generation = this.generation;
    const utterance = new this.Utterance(prepared.text);
    utterance.voice = prepared.voice;
    utterance.lang = prepared.voice.lang || 'pt-BR';
    utterance.rate = prepared.rate;
    this.utterance = utterance;
    await new Promise((resolve, reject) => {
      let settled = false;
      const estimatedMs = Math.min(60_000, Math.max(5_000, prepared.text.length * 95 / prepared.rate + 4_000));
      const timer = setTimeout(() => finish(engineError('system_playback_failed', 'A voz do sistema não concluiu a reprodução.')), estimatedMs);
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.utterance === utterance) this.utterance = null;
        if (this.cancelPending === cancelPending) this.cancelPending = null;
        if (error) reject(error); else resolve();
      };
      const cancelPending = () => finish(new DOMException('Reprodução cancelada.', 'AbortError'));
      this.cancelPending = cancelPending;
      utterance.onstart = () => {
        if (generation !== this.generation) return finish(new DOMException('Reprodução cancelada.', 'AbortError'));
        options.onFirstAudio?.();
      };
      utterance.onend = () => finish();
      utterance.onerror = event => {
        if (generation !== this.generation || event?.error === 'canceled' || event?.error === 'interrupted') return finish(new DOMException('Reprodução cancelada.', 'AbortError'));
        finish(engineError('system_playback_failed', `A voz do sistema falhou${event?.error ? `: ${event.error}` : '.'}`));
      };
      try { this.synthesis.speak(utterance); }
      catch (error) { finish(audioOutputError(error, 'system')); }
    });
  }

  async speak(text, options = {}) {
    return this.play(await this.prepare(text, options), options);
  }

  cancel() {
    this.generation += 1;
    this.utterance = null;
    this.cancelPending?.();
    this.cancelPending = null;
    try { this.synthesis?.cancel?.(); } catch {}
  }

  async #voices() {
    let voices = this.synthesis?.getVoices?.() || [];
    if (voices.length) return voices;
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.synthesis?.removeEventListener?.('voiceschanged', finish);
        resolve();
      };
      const timer = setTimeout(finish, 800);
      this.synthesis?.addEventListener?.('voiceschanged', finish, { once: true });
    });
    voices = this.synthesis?.getVoices?.() || [];
    return voices;
  }
}

export async function readVoiceRuntimeStatus() {
  try {
    const response = await fetch('/api/voice/status', { headers: { 'x-genesis-client': 'web' } });
    if (!response.ok) return { available: false, stt: {}, tts: {} };
    return await response.json();
  } catch { return { available: false, stt: {}, tts: {} }; }
}

function browserRecognitionMessage(code) {
  if (code === 'no-speech') return 'Nenhuma fala foi detectada.';
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Permissão do microfone negada pelo navegador.';
  if (code === 'audio-capture') return 'O navegador não conseguiu capturar o microfone.';
  return 'O reconhecimento de voz do navegador falhou.';
}

function engineError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function browserRecognitionCode(code) {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'microphone_permission_denied';
  if (code === 'audio-capture') return 'microphone_not_found';
  return `browser_stt_${code || 'error'}`;
}

function audioOutputError(error, engine) {
  if (error?.name === 'NotFoundError' || /device not found/i.test(String(error?.message || ''))) {
    return engineError('audio_output_not_found', 'Nenhuma saída de áudio ativa foi encontrada. Selecione ou conecte um alto-falante e tente novamente.');
  }
  if (error?.name === 'NotAllowedError') return engineError('audio_output_blocked', 'O navegador bloqueou a reprodução de áudio até uma interação do usuário.');
  return engineError(`${engine}_playback_failed`, 'O áudio local foi gerado, mas o navegador não conseguiu reproduzi-lo.');
}

function audioOutputStalled(engine) {
  return engineError(`${engine}_playback_failed`, 'A reprodução de áudio não avançou e foi interrompida. Verifique a saída de som do Windows.');
}

function selectLocalPortugueseVoice(voices) {
  const portuguese = [...voices].filter(voice => /^pt(?:-|_)/i.test(String(voice?.lang || '')) && voice?.localService === true);
  return portuguese.find(voice => /^pt[-_]BR$/i.test(String(voice.lang || ''))) || portuguese[0] || null;
}
