export class AudioPlaybackController {
  constructor({ kokoro, chatterbox, piper, system, onPrepare, onRetry, onStart, onFirstAudio, onEnd, onIdle, onFallback, onError, busyRetryDelays } = {}) {
    this.engines = { kokoro, chatterbox, piper, system };
    this.callbacks = { onPrepare, onRetry, onStart, onFirstAudio, onEnd, onIdle, onFallback, onError };
    this.busyRetryDelays = Array.isArray(busyRetryDelays) ? [...busyRetryDelays] : [150, 350, 700];
    this.queue = [];
    this.running = false;
    this.preparingByGeneration = new Map();
    this.generation = 0;
    this.lastSpokenText = '';
  }

  enqueue(text, settings) {
    const value = String(text || '').trim();
    if (!value) return;
    this.queue.push({ text: value, settings: { ...settings }, selected: null, preparation: null });
    this.#prime();
    this.#drain();
  }

  unlock() {
    return Promise.allSettled(Object.values(this.engines).map(engine => engine?.unlock?.()));
  }

  cancel(reason = 'cancelled') {
    this.generation += 1;
    this.queue = [];
    for (const engine of Object.values(this.engines)) engine?.cancel?.();
    const wasRunning = this.running;
    this.running = false;
    if (wasRunning) this.callbacks.onIdle?.({ cancelled: true, reason });
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    while (this.queue.length && generation === this.generation) {
      const item = this.queue.shift();
      const selected = item.selected || selectEngine(item.settings, this.engines);
      if (!selected) {
        this.#failPlayback(voiceError('tts_unavailable', 'Nenhum engine de voz compatível está disponível.'));
        return;
      }
      try {
        const prepared = item.preparation ? await item.preparation : await this.#prepare(item, selected, { generation });
        if (generation !== this.generation) break;
        this.lastSpokenText = item.text;
        this.callbacks.onStart?.({ engine: selected.name, text: item.text });
        this.#prime();
        await playSelected(selected, item, prepared, () => this.callbacks.onFirstAudio?.({ engine: selected.name }));
        if (generation === this.generation) this.callbacks.onEnd?.({ engine: selected.name });
      } catch (error) {
        if (generation !== this.generation || error?.name === 'AbortError') break;
        if (!shouldFallback(error)) {
          this.#failPlayback(error);
          return;
        }
        const fallback = selectFallbackEngine(item.settings, this.engines, selected.name);
        if (!fallback) {
          this.#failPlayback(error);
          return;
        }
        this.callbacks.onFallback?.({ from: selected.name, to: fallback.name, error });
        try {
          const prepared = await this.#prepare(item, fallback, { replace: true, generation });
          if (generation !== this.generation) break;
          this.lastSpokenText = item.text;
          this.callbacks.onStart?.({ engine: fallback.name, text: item.text });
          this.#prime();
          await playSelected(fallback, item, prepared, () => this.callbacks.onFirstAudio?.({ engine: fallback.name }));
          if (generation === this.generation) this.callbacks.onEnd?.({ engine: fallback.name });
        } catch (fallbackError) {
          if (generation !== this.generation || fallbackError?.name === 'AbortError') break;
          this.#failPlayback(fallbackError);
          return;
        }
      }
    }
    if (generation === this.generation) {
      this.running = false;
      this.callbacks.onIdle?.({ cancelled: false });
    }
  }

  #prime() {
    // The runtime has a single synthesis lane. The item currently being drained
    // is no longer present in `queue`, so queue.some(preparation) alone cannot
    // see its in-flight preparation. Track it explicitly to avoid self-induced
    // 429/busy retries when a streaming response adds another sentence.
    if ((this.preparingByGeneration.get(this.generation) || 0) > 0) return;
    if (this.queue.some(item => item.preparation)) return;
    const next = this.queue.find(item => !item.preparation);
    if (!next) return;
    const selected = selectEngine(next.settings, this.engines);
    if (!selected) return;
    next.selected = selected;
    next.preparation = this.#prepare(next, selected, { generation: this.generation });
    next.preparation.catch(() => {});
  }

  async #prepare(item, selected, { replace = false, generation = this.generation } = {}) {
    if (replace) {
      item.selected = selected;
      item.preparation = null;
    }
    this.preparingByGeneration.set(generation, (this.preparingByGeneration.get(generation) || 0) + 1);
    this.callbacks.onPrepare?.({ engine: selected.name, text: item.text });
    try {
      if (typeof selected.engine.prepare !== 'function') return null;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await selected.engine.prepare(item.text, item.settings);
        } catch (error) {
          const delayMs = this.busyRetryDelays[attempt];
          if (error?.code !== 'voice_tts_busy' || delayMs == null || generation !== this.generation) throw error;
          this.callbacks.onRetry?.({ engine: selected.name, text: item.text, attempt: attempt + 1, delayMs, error });
          await waitForRetry(delayMs);
          if (generation !== this.generation) throw new DOMException('Síntese cancelada.', 'AbortError');
        }
      }
    } finally {
      const remaining = Math.max(0, (this.preparingByGeneration.get(generation) || 1) - 1);
      if (remaining) this.preparingByGeneration.set(generation, remaining);
      else this.preparingByGeneration.delete(generation);
    }
  }

  #failPlayback(error) {
    this.generation += 1;
    this.queue = [];
    this.running = false;
    for (const engine of Object.values(this.engines)) engine?.cancel?.();
    this.callbacks.onError?.(error);
  }
}

function selectEngine(settings, engines) {
  const requested = settings.ttsEngine || 'auto';
  if (requested !== 'auto') return engines[requested]?.available ? { name: requested, engine: engines[requested] } : null;
  // Prefer an already warm local worker. While workers are warming, a confirmed
  // local system voice provides immediate speech instead of minutes of silence.
  if (engines.piper?.available && engines.piper?.warm) return { name: 'piper', engine: engines.piper };
  if (engines.kokoro?.available && engines.kokoro?.warm) return { name: 'kokoro', engine: engines.kokoro };
  if (engines.system?.available) return { name: 'system', engine: engines.system };
  if (engines.piper?.available) return { name: 'piper', engine: engines.piper };
  if (engines.kokoro?.available) return { name: 'kokoro', engine: engines.kokoro };
  if (engines.chatterbox?.available) return { name: 'chatterbox', engine: engines.chatterbox };
  return null;
}

function selectFallbackEngine(settings, engines, failed) {
  for (const name of ['system', 'piper', 'kokoro', 'chatterbox']) {
    if (name !== failed && engines[name]?.available) return { name, engine: engines[name] };
  }
  return null;
}

function shouldFallback(error) {
  const code = String(error?.code || '');
  if (!code) return true;
  if (code === 'voice_tts_busy' || code.startsWith('audio_output_')) return false;
  if (code.endsWith('_playback_failed')) return false;
  return true;
}

function playSelected(selected, item, prepared, onFirstAudio) {
  const options = { ...item.settings, onFirstAudio };
  return typeof selected.engine.play === 'function'
    ? selected.engine.play(prepared, options)
    : selected.engine.speak(item.text, options);
}

function voiceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function waitForRetry(delayMs) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));
}
