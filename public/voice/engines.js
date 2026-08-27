import { MicrophoneAudioInput } from './audio-input.js';

export class BrowserSpeechInputEngine {
  constructor(Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null) {
    this.Recognition = Recognition;
    this.recognition = null;
    this.finalTranscript = '';
  }

  get available() { return Boolean(this.Recognition); }

  start(options = {}) {
    if (!this.available) throw engineError('browser_stt_unavailable', 'Reconhecimento de voz do navegador indisponível.');
    this.stop();
    this.finalTranscript = '';
    const recognition = new this.Recognition();
    this.recognition = recognition;
    recognition.lang = options.lang || 'pt-BR';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => options.onStart?.({ engine: 'browser' });
    recognition.onspeechstart = () => options.onSpeechStart?.({ engine: 'browser' });
    recognition.onresult = event => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = String(event.results[index]?.[0]?.transcript || '').trim();
        if (event.results[index].isFinal) this.finalTranscript = `${this.finalTranscript} ${transcript}`.trim();
        else interim = `${interim} ${transcript}`.trim();
      }
      options.onInterim?.(`${this.finalTranscript} ${interim}`.trim());
    };
    recognition.onerror = event => options.onError?.(engineError(browserRecognitionCode(event.error), browserRecognitionMessage(event.error)));
    recognition.onend = () => {
      const transcript = this.finalTranscript.trim();
      this.recognition = null;
      if (transcript) {
        options.onTranscribing?.({ engine: 'browser' });
        options.onFinal?.(transcript, { engine: 'browser' });
      }
      options.onEnd?.({ engine: 'browser', transcript });
    };
    recognition.start();
  }

  stop() {
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return;
    recognition.onend = null;
    try { recognition.abort?.(); } catch { /* já finalizado */ }
  }

  close() { this.stop(); }
}

export class LocalSpeechInputEngine {
  constructor({ endpoint = '/api/voice/transcribe', audioInput } = {}) {
    this.endpoint = endpoint;
    this.audioInput = audioInput || new MicrophoneAudioInput();
    this.activeController = null;
    this.callbacks = {};
    this.serverAvailable = false;
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
    this.callbacks = options;
    await this.audioInput.arm({
      threshold: options.vadThreshold,
      silenceMs: options.vadSilenceMs,
      playbackActive: options.playbackActive === true
    });
    options.onStart?.({ engine: 'local' });
  }

  stop() {
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
    this.activeController = controller;
    this.callbacks.onTranscribing?.({ ...detail, engine: 'local' });
    try {
      const quality = ['rapid', 'balanced', 'accurate'].includes(this.callbacks.quality) ? this.callbacks.quality : 'balanced';
      const response = await fetch(`${this.endpoint}?quality=${encodeURIComponent(quality)}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', 'x-genesis-client': 'web' },
        body: blob,
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw engineError(payload?.error?.code || 'local_stt_failed', payload?.error?.message || `Whisper local falhou (${response.status}).`);
      const transcript = String(payload.text || '').trim();
      if (transcript) this.callbacks.onFinal?.(transcript, { ...detail, engine: 'local', latencyMs: payload.latencyMs });
      this.callbacks.onEnd?.({ engine: 'local', transcript });
    } catch (error) {
      if (error?.name !== 'AbortError') this.callbacks.onError?.(error);
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }
}

export class LocalTextToSpeechEngine {
  constructor({ endpoint = '/api/voice/synthesize', engine }) {
    this.endpoint = endpoint;
    this.engine = engine;
    this.serverAvailable = false;
    this.controllers = new Set();
    this.context = null;
    this.source = null;
    this.generation = 0;
  }

  get available() { return this.serverAvailable && Boolean(globalThis.AudioContext || globalThis.webkitAudioContext); }

  setAvailable(available) { this.serverAvailable = available === true; }

  async unlock() {
    if (!this.available) return false;
    await this.#ensureAudioContext();
    return this.context?.state === 'running';
  }

  async prepare(text, options = {}) {
    if (!this.available) throw engineError(`${this.engine}_unavailable`, `${this.engine} não está instalado ou configurado.`);
    // Preserve the user gesture before a cold local synthesis consumes it.
    const contextReady = this.#ensureAudioContext();
    const controller = new AbortController();
    const generation = this.generation;
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
    } finally {
      this.controllers.delete(controller);
    }
  }

  async play(prepared, options = {}) {
    if (!prepared?.buffer || prepared.generation !== this.generation) throw new DOMException('Reprodução cancelada.', 'AbortError');
    if (this.context.state === 'suspended') await this.context.resume();
    const source = this.context.createBufferSource();
    source.buffer = prepared.buffer;
    source.playbackRate.value = prepared.rate;
    source.connect(this.context.destination);
    this.source = source;
    await new Promise((resolve, reject) => {
      source.onended = () => {
        if (this.source === source) this.source = null;
        source.disconnect();
        resolve();
      };
      try {
        source.start(0);
        options.onFirstAudio?.();
      } catch (error) {
        reject(audioOutputError(error, this.engine));
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
