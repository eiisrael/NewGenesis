export class AudioPlaybackController {
  constructor({ kokoro, chatterbox, piper, onPrepare, onStart, onFirstAudio, onEnd, onIdle, onFallback, onError } = {}) {
    this.engines = { kokoro, chatterbox, piper };
    this.callbacks = { onPrepare, onStart, onFirstAudio, onEnd, onIdle, onFallback, onError };
    this.queue = [];
    this.running = false;
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
      this.lastSpokenText = item.text;
      const selected = item.selected || selectEngine(item.settings, this.engines);
      if (!selected) {
        this.callbacks.onError?.(voiceError('tts_unavailable', 'Nenhum engine de voz compatível está disponível.'));
        break;
      }
      try {
        const prepared = item.preparation ? await item.preparation : await this.#prepare(item, selected);
        if (generation !== this.generation) break;
        this.callbacks.onStart?.({ engine: selected.name, text: item.text });
        this.#prime();
        await playSelected(selected, item, prepared, () => this.callbacks.onFirstAudio?.({ engine: selected.name }));
        if (generation === this.generation) this.callbacks.onEnd?.({ engine: selected.name });
      } catch (error) {
        if (generation !== this.generation || error?.name === 'AbortError') break;
        const fallback = selectFallbackEngine(item.settings, this.engines, selected.name);
        if (!fallback) {
          this.callbacks.onError?.(error);
          break;
        }
        this.callbacks.onFallback?.({ from: selected.name, to: fallback.name, error });
        try {
          const prepared = await this.#prepare(item, fallback, { replace: true });
          if (generation !== this.generation) break;
          this.callbacks.onStart?.({ engine: fallback.name, text: item.text });
          this.#prime();
          await playSelected(fallback, item, prepared, () => this.callbacks.onFirstAudio?.({ engine: fallback.name }));
          if (generation === this.generation) this.callbacks.onEnd?.({ engine: fallback.name });
        } catch (fallbackError) {
          this.callbacks.onError?.(fallbackError);
          break;
        }
      }
    }
    if (generation === this.generation) {
      this.running = false;
      this.callbacks.onIdle?.({ cancelled: false });
    }
  }

  #prime() {
    if (this.queue.some(item => item.preparation)) return;
    const next = this.queue.find(item => !item.preparation);
    if (!next) return;
    const selected = selectEngine(next.settings, this.engines);
    if (!selected) return;
    next.selected = selected;
    next.preparation = this.#prepare(next, selected);
    next.preparation.catch(() => {});
  }

  #prepare(item, selected, { replace = false } = {}) {
    if (replace) {
      item.selected = selected;
      item.preparation = null;
    }
    this.callbacks.onPrepare?.({ engine: selected.name, text: item.text });
    if (typeof selected.engine.prepare !== 'function') return Promise.resolve(null);
    return selected.engine.prepare(item.text, item.settings);
  }
}

function selectEngine(settings, engines) {
  const requested = settings.ttsEngine || 'auto';
  if (requested !== 'auto') return engines[requested]?.available ? { name: requested, engine: engines[requested] } : null;
  if (engines.kokoro?.available) return { name: 'kokoro', engine: engines.kokoro };
  if (engines.piper?.available) return { name: 'piper', engine: engines.piper };
  if (engines.chatterbox?.available) return { name: 'chatterbox', engine: engines.chatterbox };
  return null;
}

function selectFallbackEngine(settings, engines, failed) {
  for (const name of ['kokoro', 'piper', 'chatterbox']) {
    if (name !== failed && engines[name]?.available) return { name, engine: engines[name] };
  }
  return null;
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
