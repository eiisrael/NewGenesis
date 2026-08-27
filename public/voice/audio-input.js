export class AdaptiveVoiceActivityDetector {
  constructor(options = {}) {
    this.options = {
      threshold: Number(options.threshold) || 0.018,
      startFrames: Number(options.startFrames) || 3,
      bargeInFrames: Number(options.bargeInFrames) || 5,
      silenceMs: Number(options.silenceMs) || 700,
      minSpeechMs: Number(options.minSpeechMs) || 260,
      maxSpeechMs: Number(options.maxSpeechMs) || 30000,
      bargeInMultiplier: Number(options.bargeInMultiplier) || 1.8
    };
    this.reset();
  }

  reset() {
    this.speaking = false;
    this.noiseFloor = 0.004;
    this.voicedFrames = 0;
    this.startedAt = 0;
    this.silenceStartedAt = 0;
  }

  pushLevel(level, timestamp, { playbackActive = false } = {}) {
    const rms = Math.max(0, Number(level) || 0);
    const adaptive = Math.max(this.options.threshold, this.noiseFloor * 3.2);
    const threshold = playbackActive ? adaptive * this.options.bargeInMultiplier : adaptive;
    const voiced = rms >= threshold;
    if (!this.speaking && !voiced) this.noiseFloor = Math.min(0.03, this.noiseFloor * 0.96 + rms * 0.04);

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
  }

  get available() {
    return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia && (globalThis.AudioContext || globalThis.webkitAudioContext));
  }

  async open() {
    if (this.stream) return;
    if (!this.available) throw voiceError('microphone_unavailable', 'Captura local do microfone não está disponível neste navegador.');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false
      });
    } catch (error) {
      throw microphoneError(error);
    }
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
    await this.open();
    this.detector = new AdaptiveVoiceActivityDetector(options);
    this.frames = [];
    this.preRoll = [];
    this.playbackActive = options.playbackActive === true;
    this.armed = true;
  }

  disarm() {
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
    if (this.processor) this.processor.onaudioprocess = null;
    if (this.processor?.port) this.processor.port.onmessage = null;
    try { this.source?.disconnect(); } catch { /* já desconectado */ }
    try { this.processor?.disconnect(); } catch { /* já desconectado */ }
    try { this.mute?.disconnect(); } catch { /* já desconectado */ }
    for (const track of this.stream?.getTracks?.() || []) track.stop();
    await this.context?.close?.().catch(() => {});
    this.stream = this.context = this.processor = this.source = this.mute = null;
    this.captureMode = 'closed';
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
      const maxPreRollFrames = Math.max(2, Math.ceil(this.sampleRate * 0.3 / frame.length));
      if (this.preRoll.length > maxPreRollFrames) this.preRoll.shift();
    } else this.frames.push(frame);

    const event = this.detector.pushLevel(rms, now, { playbackActive: this.playbackActive });
    if (event?.type === 'start') {
      this.frames = this.preRoll.splice(0);
      this.frames.push(frame);
      this.callbacks.onSpeechStart?.(event);
    } else if (event?.type === 'end') {
      const frames = this.frames.splice(0);
      this.armed = false;
      try {
        const wav = encodePcm16Wav(flatten(frames), this.sampleRate, 16000);
        this.callbacks.onSpeechEnd?.(new Blob([wav], { type: 'audio/wav' }), { ...event, sourceSampleRate: this.sampleRate, sampleRate: 16000 });
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
  return voiceError('microphone_open_failed', 'Não foi possível iniciar o microfone local.');
}
