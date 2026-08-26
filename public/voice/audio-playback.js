export class AudioPlaybackController {
  constructor({ browser, chatterbox, piper, onStart, onFirstAudio, onEnd, onIdle, onFallback, onError } = {}) {
    this.engines = { browser, chatterbox, piper };
    this.callbacks = { onStart, onFirstAudio, onEnd, onIdle, onFallback, onError };
    this.queue = [];
    this.running = false;
    this.generation = 0;
    this.lastSpokenText = '';
  }

  enqueue(text, settings) {
    const value = String(text || '').trim();
    if (!value) return;
    this.queue.push({ text: value, settings: { ...settings } });
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
      const selected = selectEngine(item.settings, this.engines);
      if (!selected) {
        this.callbacks.onError?.(voiceError('tts_unavailable', 'Nenhum engine de voz compatível está disponível.'));
        break;
      }
      this.callbacks.onStart?.({ engine: selected.name, text: item.text });
      try {
        await selected.engine.speak(item.text, {
          ...item.settings,
          onFirstAudio: () => this.callbacks.onFirstAudio?.({ engine: selected.name })
        });
        if (generation === this.generation) this.callbacks.onEnd?.({ engine: selected.name });
      } catch (error) {
        if (generation !== this.generation || error?.name === 'AbortError') break;
        const fallback = selected.name !== 'browser' && !item.settings.preferLocal && this.engines.browser?.available
          ? { name: 'browser', engine: this.engines.browser }
          : null;
        if (!fallback) {
          this.callbacks.onError?.(error);
          break;
        }
        this.callbacks.onFallback?.({ from: selected.name, to: 'browser', error });
        try {
          await fallback.engine.speak(item.text, {
            ...item.settings,
            onFirstAudio: () => this.callbacks.onFirstAudio?.({ engine: 'browser' })
          });
          if (generation === this.generation) this.callbacks.onEnd?.({ engine: 'browser' });
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
}

function selectEngine(settings, engines) {
  const requested = settings.ttsEngine || 'auto';
  if (requested !== 'auto') return engines[requested]?.available ? { name: requested, engine: engines[requested] } : null;
  if (engines.chatterbox?.available) return { name: 'chatterbox', engine: engines.chatterbox };
  if (engines.piper?.available) return { name: 'piper', engine: engines.piper };
  if (!settings.preferLocal && engines.browser?.available) return { name: 'browser', engine: engines.browser };
  return null;
}

function voiceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
