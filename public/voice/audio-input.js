export class AdaptiveVoiceActivityDetector {
  constructor(options = {}) {
    this.options = {
      threshold: Number(options.threshold) || 0.009,
      startFrames: Number(options.startFrames) || 2,
      bargeInFrames: Number(options.bargeInFrames) || 4,
      silenceMs: Number(options.silenceMs) || 650,
      minSpeechMs: Number(options.minSpeechMs) || 240,
      maxSpeechMs: Number(options.maxSpeechMs) || 30000,
      bargeInMultiplier: Number(options.bargeInMultiplier) || 1.8
    };
    this.reset();
  }

  reset() {
    this.speaking = false;
    this.noiseFloor = 0.0025;
    this.voicedFrames = 0;
    this.startedAt = 0;
    this.silenceStartedAt = 0;
  }

  pushLevel(level, timestamp, { playbackActive = false } = {}) {
    const rms = Math.max(0, Number(level) || 0);
    // O limiar anterior multiplicava o ruído por 3,2 e podia ficar acima de uma
    // voz perfeitamente audível em microfones de notebook/Windows. Aqui usamos
    // uma margem relativa mais conservadora, mantendo um piso absoluto contra
    // falsos positivos e um limiar maior apenas durante barge-in.
    const adaptive = Math.max(
      this.options.threshold,
      this.noiseFloor + 0.0035,
      this.noiseFloor * 1.65
    );
    const threshold = playbackActive
      ? Math.max(adaptive * this.options.bargeInMultiplier, this.options.threshold * 1.5)
      : adaptive;
    const voiced = rms >= threshold;
    if (!this.speaking && !voiced) {
      this.noiseFloor = Math.min(0.03, this.noiseFloor * 0.975 + rms * 0.025);
    }

    if (!this.speaking) {
      this.voicedFrames = voiced ? this.voicedFrames + 1 : 0;
      const required = playbackActive ? this.options.bargeInFrames : this.options.startFrames;
      if (this.voicedFrames >= required) {
        this.speaking = true;
        this.startedAt = timestamp;
        this.silenceStartedAt = 0;
        return { type: 'start', level: rms, threshold, playbackActive };
      }
      return null;
    }

    if (timestamp - this.startedAt >= this.options.maxSpeechMs) {
      this.speaking = false;
      return { type: 'end', reason: 'max-duration', durationMs: timestamp - this.startedAt };
    }
    if (voiced) {
      this.silenceStartedAt = 0;
      return null;
    }
    if (!this.silenceStartedAt) this.silenceStartedAt = timestamp;
    if (timestamp - this.startedAt >= this.options.minSpeechMs && timestamp - this.silenceStartedAt >= this.options.silenceMs) {
      this.speaking = false;
      return { type: 'end', reason: 'silence', durationMs: timestamp - this.startedAt };
    }
    return null;
  }
}

export class MicrophoneAudioInput {
  constructor({ onLevel, onSpeechStart, onSpeechEnd, onError } = {}) {
    this.callbacks = { onLevel, onSpeechStart, onSpeechEnd, onError };
    this.stream = null;
    this.context = null;
    this.processor = null;
    this.source = null;
    this.mute = null;
    this.armed = false;
    this.playbackActive = false;
    this.frames = [];
    this.preRoll = [];
    this.sampleRate = 0;
    this.detector = null;
    this.captureMode = 'uninitialized';
    this.generation = 0;
    this.openPromise = null;
  }

  get available() {
    return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia && (globalThis.AudioContext || globalThis.webkitAudioContext));
  }

  async open() {
    if (this.#liveTrack()) return;
    if (this.openPromise) return this.openPromise;
    if (this.stream || this.context) await this.close();
    if (this.#liveTrack()) return;
    if (this.openPromise) return this.openPromise;
    const pending = this.#openFresh();
    this.openPromise = pending;
    try { await pending; }
    finally { if (this.openPromise === pending) this.openPromise = null; }
  }

  async #openFresh() {
    if (!this.available) throw voiceError('microphone_unavailable', 'Captura local do microfone não está disponível neste navegador.');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          channelCount: { ideal: 1 }
        },
        video: false
      });
    } catch (error) {
      if (error?.name !== 'OverconstrainedError') throw microphoneError(error);
      try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
      catch (fallbackError) { throw microphoneError(fallbackError); }
    }
    const track = this.#liveTrack();
    if (!track) {
      for (const item of this.stream?.getTracks?.() || []) item.stop();
      this.stream = null;
      throw voiceError('microphone_not_found', 'O navegador não retornou uma entrada de áudio ativa.');
    }
    track.onended = () => {
      if (!this.armed) return;
      this.disarm();
      this.callbacks.onError?.(voiceError('microphone_disconnected', 'O microfone foi desconectado ou desativado durante a captura.'));
    };
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    try {
      this.context = new Context({ latencyHint: 'interactive' });
      await this.context.resume();
    } catch (error) {
      for (const track of this.stream?.getTracks?.() || []) track.stop();
      this.stream = null;
      throw microphoneError(error);
    }
    this.sampleRate = this.context.sampleRate;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.mute = this.context.createGain();
    this.mute.gain.value = 0;
    if (this.context.audioWorklet?.addModule && globalThis.AudioWorkletNode) {
      try {
        await this.context.audioWorklet.addModule('/voice/audio-capture.worklet.js');
        this.processor = new AudioWorkletNode(this.context, 'genesis-audio-capture', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1]
        });
        this.processor.port.onmessage = event => this.#process(event.data);
        this.captureMode = 'audio-worklet';
      } catch {
        this.processor = null;
      }
    }
    if (!this.processor) {
      this.processor = this.context.createScriptProcessor(2048, 1, 1);
      this.processor.onaudioprocess = event => this.#process(event.inputBuffer.getChannelData(0));
      this.captureMode = 'script-processor-fallback';
    }
    this.source.connect(this.processor);
    this.processor.connect(this.mute);
    this.mute.connect(this.context.destination);
  }

  async arm(options = {}) {
    const generation = ++this.generation;
    await this.open();
    if (generation !== this.generation) return false;
    this.detector = new AdaptiveVoiceActivityDetector(options);
    this.frames = [];
    this.preRoll = [];
    this.playbackActive = options.playbackActive === true;
    this.armed = true;
    return true;
  }

  disarm() {
    this.generation += 1;
    this.armed = false;
    this.frames = [];
    this.preRoll = [];
    this.detector?.reset();
  }

  setPlaybackActive(active) {
    this.playbackActive = active === true;
  }

  async close() {
    this.disarm();
    const pendingOpen = this.openPromise;
    if (pendingOpen) await pendingOpen.catch(() => {});
    if (this.processor) this.processor.onaudioprocess = null;
    if (this.processor?.port) this.processor.port.onmessage = null;
    try { this.source?.disconnect(); } catch { /* já desconectado */ }
    try { this.processor?.disconnect(); } catch { /* já desconectado */ }
    try { this.mute?.disconnect(); } catch { /* já desconectado */ }
    for (const track of this.stream?.getTracks?.() || []) {
      track.onended = null;
      track.stop();
    }
    await this.context?.close?.().catch(() => {});
    this.stream = this.context = this.processor = this.source = this.mute = null;
    this.captureMode = 'closed';
  }

  #liveTrack() {
    return (this.stream?.getAudioTracks?.() || []).find(track => track.readyState === 'live') || null;
  }

  #process(input) {
    if (!this.armed || !this.detector) return;
    const frame = new Float32Array(input);
    let sum = 0;
    for (const sample of frame) sum += sample * sample;
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    const now = performance.now();
    this.callbacks.onLevel?.(Math.min(1, rms * 8));
    if (!this.detector.speaking) {
      this.preRoll.push(frame);
      const maxPreRollFrames = Math.max(2, Math.ceil(this.sampleRate * 0.45 / frame.length));
      if (this.preRoll.length > maxPreRollFrames) this.preRoll.shift();
    } else this.frames.push(frame);

    const event = this.detector.pushLevel(rms, now, { playbackActive: this.playbackActive });
    if (event?.type === 'start') {
      this.frames = this.preRoll.splice(0);
      this.callbacks.onSpeechStart?.(event);
    } else if (event?.type === 'end') {
      const frames = this.frames.splice(0);
      this.armed = false;
      try {
        const samples = flatten(frames);
        const analysis = analyzeSamples(samples, this.sampleRate);
        const wav = encodePcm16Wav(samples, this.sampleRate, 16000);
        const trackSettings = this.#liveTrack()?.getSettings?.() || {};
        this.callbacks.onSpeechEnd?.(new Blob([wav], { type: 'audio/wav' }), {
          ...event,
          ...analysis,
          sourceSampleRate: this.sampleRate,
          sampleRate: 16000,
          captureMode: this.captureMode,
          deviceSampleRate: Number(trackSettings.sampleRate) || null,
          echoCancellation: trackSettings.echoCancellation === true,
          noiseSuppression: trackSettings.noiseSuppression === true,
          autoGainControl: trackSettings.autoGainControl === true
        });
      } catch (error) { this.callbacks.onError?.(error); }
    }
  }
}

export function encodePcm16Wav(samples, sourceRate, targetRate = 16000) {
  const pcm = resampleLinear(samples, sourceRate, targetRate);
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

export function resampleLinear(samples, sourceRate, targetRate) {
  if (!(samples instanceof Float32Array)) samples = Float32Array.from(samples || []);
  if (!samples.length || sourceRate === targetRate) return samples;
  const length = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const output = new Float32Array(length);
  const ratio = sourceRate / targetRate;
  if (ratio > 1) {
    // Area-weighted box filtering prevents the high-frequency aliases produced
    // by plain point interpolation when browser audio (usually 48 kHz) is
    // reduced to the 16 kHz expected by Whisper.
    for (let index = 0; index < length; index += 1) {
      const start = index * ratio;
      const end = Math.min(samples.length, (index + 1) * ratio);
      const first = Math.floor(start);
      const last = Math.min(samples.length - 1, Math.ceil(end) - 1);
      let weighted = 0;
      let weightTotal = 0;
      for (let sourceIndex = first; sourceIndex <= last; sourceIndex += 1) {
        const weight = Math.max(0, Math.min(end, sourceIndex + 1) - Math.max(start, sourceIndex));
        weighted += samples[sourceIndex] * weight;
        weightTotal += weight;
      }
      output[index] = weightTotal ? weighted / weightTotal : samples[Math.min(samples.length - 1, first)];
    }
    return output;
  }
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const weight = position - left;
    output[index] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return output;
}

function flatten(frames) {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const frame of frames) { result.set(frame, offset); offset += frame.length; }
  return result;
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function voiceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function analyzeSamples(samples, sampleRate) {
  let sum = 0;
  let peak = 0;
  let clipped = 0;
  for (const sample of samples) {
    const absolute = Math.abs(sample);
    sum += sample * sample;
    peak = Math.max(peak, absolute);
    if (absolute >= 0.985) clipped += 1;
  }
  return {
    durationMs: Math.round(samples.length * 1000 / Math.max(1, sampleRate)),
    rms: Number(Math.sqrt(sum / Math.max(1, samples.length)).toFixed(4)),
    peak: Number(peak.toFixed(4)),
    clippingRatio: Number((clipped / Math.max(1, samples.length)).toFixed(5))
  };
}

function microphoneError(error) {
  if (error?.name === 'NotFoundError' || /device not found/i.test(String(error?.message || ''))) {
    return voiceError('microphone_not_found', 'Nenhum microfone ativo foi encontrado. Conecte ou habilite um dispositivo de entrada e tente novamente.');
  }
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return voiceError('microphone_permission_denied', 'A permissão do microfone foi negada pelo navegador.');
  }
  if (error?.name === 'NotReadableError') {
    return voiceError('microphone_busy', 'O microfone está ocupado ou indisponível para este navegador.');
  }
  if (error?.name === 'OverconstrainedError') {
    return voiceError('microphone_constraints_failed', 'O microfone não aceita a configuração de captura solicitada.');
  }
  if (error?.name === 'AbortError') {
    return voiceError('microphone_start_aborted', 'O navegador não conseguiu concluir a inicialização do microfone.');
  }
  return voiceError('microphone_open_failed', 'Não foi possível iniciar o microfone local.');
}
