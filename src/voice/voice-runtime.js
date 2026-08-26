import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 45;
const MAX_TTS_TEXT = 2000;
const MAX_TTS_AUDIO_BYTES = 24 * 1024 * 1024;
const STT_TIMEOUT_MS = 90_000;
const TTS_TIMEOUT_MS = 120_000;

const profileNames = Object.freeze({ rapid: 'rapid', balanced: 'balanced', accurate: 'accurate' });
const ttsPresets = Object.freeze({
  natural: { exaggeration: 0.5, temperature: 0.8, cfgWeight: 0.5 },
  calm: { exaggeration: 0.35, temperature: 0.7, cfgWeight: 0.55 },
  expressive: { exaggeration: 0.7, temperature: 0.85, cfgWeight: 0.45 }
});

export class VoiceRuntime {
  constructor({ root, dataDir, telemetry = null } = {}) {
    this.root = path.resolve(root || process.cwd());
    this.voiceDir = path.resolve(dataDir || path.join(this.root, '.genesis'), 'voice');
    this.tempDir = path.join(this.voiceDir, 'tmp');
    this.telemetry = telemetry;
    this.manifest = defaultManifest();
    this.snapshot = emptyStatus();
    this.active = { stt: false, tts: false };
    this.children = new Set();
    this.stopping = false;
  }

  async init() {
    await fs.mkdir(this.voiceDir, { recursive: true });
    await this.#resetTemp();
    const manifestPath = path.join(this.voiceDir, 'voice-manifest.json');
    try {
      const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      this.manifest = normalizeManifest(parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') this.#emit('voice.runtime.manifest_invalid', 'Manifesto de voz inválido; usando caminhos padrão.', 'warning');
    }
    await this.refreshStatus();
    return this;
  }

  status() {
    return structuredClone(this.snapshot);
  }

  async refreshStatus() {
    const whisperBinary = this.#resolve(this.manifest.whisper.binary);
    const vadModel = this.#resolve(this.manifest.whisper.vadModel);
    const profiles = {};
    for (const [name, entry] of Object.entries(this.manifest.whisper.profiles)) {
      const modelPath = this.#resolve(entry.model);
      profiles[name] = { ...entry, available: await isFile(modelPath) };
    }
    const whisperAvailable = await isFile(whisperBinary) && Object.values(profiles).some(profile => profile.available);

    const piperPython = this.#resolve(this.manifest.piper.python);
    const chatterboxPython = this.#resolve(this.manifest.chatterbox.python);
    const worker = path.join(this.root, 'scripts', 'voice', 'tts-worker.py');
    const piperModel = this.#resolve(this.manifest.piper.model);
    const piperConfig = this.#resolve(this.manifest.piper.config);
    const chatterboxSource = this.#resolve(this.manifest.chatterbox.source);
    const chatterboxMarker = this.#resolve(this.manifest.chatterbox.readyMarker);
    const piperPythonAvailable = await isFile(piperPython);
    const chatterboxPythonAvailable = await isFile(chatterboxPython);
    this.snapshot = {
      available: whisperAvailable || piperPythonAvailable || chatterboxPythonAvailable,
      localOnly: true,
      storesRawAudio: false,
      limits: { maxAudioBytes: MAX_AUDIO_BYTES, maxAudioSeconds: MAX_AUDIO_DURATION_SECONDS, maxTextCharacters: MAX_TTS_TEXT, concurrencyPerEngine: 1 },
      stt: {
        whisper: {
          available: whisperAvailable,
          version: this.manifest.whisper.version,
          vad: await isFile(vadModel),
          profiles
        }
      },
      tts: {
        chatterbox: { available: chatterboxPythonAvailable && await isFile(worker) && await isDirectory(chatterboxSource) && await isFile(chatterboxMarker), version: this.manifest.chatterbox.version, model: this.manifest.chatterbox.model },
        piper: { available: piperPythonAvailable && await isFile(piperModel) && await isFile(piperConfig), version: this.manifest.piper.version, model: this.manifest.piper.voice }
      }
    };
    return this.status();
  }

  async transcribe(audio, { quality = 'balanced' } = {}) {
    if (this.stopping) throw runtimeError(503, 'voice_shutting_down', 'A camada de voz está encerrando.');
    if (this.active.stt) throw runtimeError(429, 'voice_stt_busy', 'O Whisper local já está transcrevendo outra fala.');
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
    const wav = inspectWave(buffer);
    const profile = profileNames[quality] || 'balanced';
    const selected = this.#selectWhisperProfile(profile);
    if (!selected) throw runtimeError(503, 'whisper_not_installed', 'O perfil solicitado do Whisper local não está instalado. Execute scripts/setup-voice.ps1.');
    this.active.stt = true;
    const requestDir = await fs.mkdtemp(path.join(this.tempDir, 'stt-'));
    const inputPath = path.join(requestDir, 'input.wav');
    const outputPrefix = path.join(requestDir, 'transcript');
    const startedAt = performance.now();
    try {
      await fs.writeFile(inputPath, buffer, { flag: 'wx', mode: 0o600 });
      const args = ['-m', selected.model, '-f', inputPath, '-l', 'pt', '-oj', '-of', outputPrefix, '-np', '-nt'];
      const vad = this.#resolve(this.manifest.whisper.vadModel);
      if (await isFile(vad)) args.push('--vad', '--vad-model', vad);
      await this.#run(this.#resolve(this.manifest.whisper.binary), args, { timeoutMs: STT_TIMEOUT_MS, kind: 'stt' });
      const payload = JSON.parse(await fs.readFile(`${outputPrefix}.json`, 'utf8'));
      const text = whisperText(payload).replace(/\s+/g, ' ').trim().slice(0, 12000);
      return { text, language: payload?.result?.language || 'pt', profile: selected.name, durationSeconds: wav.durationSeconds, latencyMs: Math.round(performance.now() - startedAt) };
    } finally {
      this.active.stt = false;
      await fs.rm(requestDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  }

  async synthesize({ text, engine = 'chatterbox', preset = 'natural', rate = 1 } = {}) {
    if (this.stopping) throw runtimeError(503, 'voice_shutting_down', 'A camada de voz está encerrando.');
    if (this.active.tts) throw runtimeError(429, 'voice_tts_busy', 'O sintetizador local já está gerando outra fala.');
    const safeText = validateTtsText(text);
    if (!['chatterbox', 'piper'].includes(engine)) throw runtimeError(400, 'invalid_tts_engine', 'Engine TTS inválido.');
    const current = await this.refreshStatus();
    if (!current.tts[engine]?.available) throw runtimeError(503, `${engine}_not_installed`, `${engine} não está instalado. Execute scripts/setup-voice.ps1.`);
    const selectedPreset = Object.hasOwn(ttsPresets, preset) ? preset : 'natural';
    this.active.tts = true;
    const requestDir = await fs.mkdtemp(path.join(this.tempDir, 'tts-'));
    const textPath = path.join(requestDir, 'input.txt');
    const outputPath = path.join(requestDir, 'output.wav');
    const startedAt = performance.now();
    try {
      await fs.writeFile(textPath, safeText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (engine === 'chatterbox') await this.#runChatterbox({ textPath, outputPath, preset: selectedPreset });
      else await this.#runPiper({ textPath, outputPath });
      const audio = await fs.readFile(outputPath);
      if (audio.length < 44 || audio.length > MAX_TTS_AUDIO_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF') {
        throw runtimeError(502, 'invalid_tts_audio', 'O sintetizador local retornou um WAV inválido.');
      }
      return { audio, engine, preset: selectedPreset, latencyMs: Math.round(performance.now() - startedAt) };
    } finally {
      this.active.tts = false;
      await fs.rm(requestDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  }

  recordMetric({ name, at, detail } = {}) {
    const allowed = new Set(['voice.vad_start', 'voice.vad_end', 'voice.stt_start', 'voice.stt_final', 'voice.chat_start', 'voice.first_text', 'voice.tts_start', 'voice.first_audio', 'voice.tts_end', 'voice.barge_in', 'voice.feedback_ignored']);
    if (!allowed.has(name)) throw runtimeError(400, 'invalid_voice_metric', 'Métrica de voz inválida.');
    const safeDetail = {};
    if (typeof detail?.engine === 'string') safeDetail.engine = detail.engine.slice(0, 30);
    if (Number.isFinite(Number(detail?.latencyMs))) safeDetail.latencyMs = Math.max(0, Math.min(300000, Math.round(detail.latencyMs)));
    this.telemetry?.emit({ category: 'voice', type: name, title: voiceMetricTitle(name), detail: 'Marco local de latência; nenhum áudio foi registrado.', meta: { clientAt: Number(at) || null, ...safeDetail } });
    return { ok: true };
  }

  beginShutdown() {
    this.stopping = true;
    for (const child of this.children) child.kill('SIGTERM');
  }

  async flush() {
    this.beginShutdown();
    await Promise.allSettled([...this.children].map(child => new Promise(resolve => child.once('exit', resolve))));
    await fs.rm(this.tempDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }

  #selectWhisperProfile(requested) {
    const order = requested === 'accurate' ? ['accurate', 'balanced', 'rapid'] : requested === 'rapid' ? ['rapid', 'balanced', 'accurate'] : ['balanced', 'rapid', 'accurate'];
    for (const name of order) {
      if (this.snapshot.stt.whisper.profiles[name]?.available) return { name, model: this.#resolve(this.manifest.whisper.profiles[name].model) };
    }
    return null;
  }

  async #runChatterbox({ textPath, outputPath, preset }) {
    const python = this.#resolve(this.manifest.chatterbox.python);
    const worker = path.join(this.root, 'scripts', 'voice', 'tts-worker.py');
    const args = [worker, '--engine', 'chatterbox', '--text-file', textPath, '--output', outputPath, '--preset', preset, '--source', this.#resolve(this.manifest.chatterbox.source)];
    await this.#run(python, args, {
      timeoutMs: TTS_TIMEOUT_MS,
      kind: 'tts',
      env: { HF_HOME: this.#resolve(this.manifest.chatterbox.hfHome), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }
    });
  }

  async #runPiper({ textPath, outputPath }) {
    const python = this.#resolve(this.manifest.piper.python);
    const args = ['-m', 'piper', '-m', this.#resolve(this.manifest.piper.model), '-f', outputPath, '--input-file', textPath];
    await this.#run(python, args, { timeoutMs: TTS_TIMEOUT_MS, kind: 'tts' });
  }

  #run(command, args, { timeoutMs, kind, env = {} }) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
      this.children.add(child);
      let settled = false;
      let outputBytes = 0;
      let stderr = '';
      const collect = chunk => {
        outputBytes += chunk.length;
        if (outputBytes <= 2 * 1024 * 1024) stderr += chunk.toString('utf8');
        else child.kill('SIGTERM');
      };
      child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > 2 * 1024 * 1024) child.kill('SIGTERM'); });
      child.stderr.on('data', collect);
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.once('error', error => finish(runtimeError(503, `${kind}_spawn_failed`, `Não foi possível iniciar o engine local: ${error.message}`)));
      child.once('exit', (code, signal) => {
        if (code === 0) finish();
        else finish(runtimeError(signal ? 504 : 502, signal ? `${kind}_timeout` : `${kind}_failed`, signal ? 'O engine local excedeu o limite de tempo.' : `O engine local encerrou com código ${code}. ${sanitizeEngineError(stderr)}`));
      });
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        if (error) reject(error); else resolve();
      };
    });
  }

  #resolve(relative) {
    const candidate = path.resolve(this.voiceDir, String(relative || ''));
    if (candidate !== this.voiceDir && !candidate.startsWith(`${this.voiceDir}${path.sep}`)) throw runtimeError(500, 'unsafe_voice_path', 'O manifesto de voz contém um caminho fora do diretório permitido.');
    return candidate;
  }

  async #resetTemp() {
    await fs.rm(this.tempDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    await fs.mkdir(this.tempDir, { recursive: true, mode: 0o700 });
  }

  #emit(type, detail, level = 'success') {
    this.telemetry?.emit({ category: 'voice', type, title: 'Runtime de voz local', detail, level });
  }
}

export function inspectWave(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw runtimeError(400, 'invalid_voice_audio', 'Envie um arquivo WAV PCM válido.');
  if (buffer.length > MAX_AUDIO_BYTES) throw runtimeError(413, 'voice_audio_too_large', 'O áudio excede o limite de 10 MB.');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw runtimeError(400, 'invalid_voice_audio', 'Envie um arquivo WAV PCM válido.');
  let offset = 12;
  let format = null;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw runtimeError(400, 'invalid_voice_audio', 'O WAV está truncado.');
    if (id === 'fmt ' && size >= 16) format = { audioFormat: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), bitsPerSample: buffer.readUInt16LE(start + 14) };
    if (id === 'data') dataBytes += size;
    offset = start + size + (size % 2);
  }
  if (!format || format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16 || format.sampleRate < 8000 || format.sampleRate > 48000 || !dataBytes) {
    throw runtimeError(400, 'unsupported_voice_audio', 'O áudio deve ser WAV PCM mono, 16-bit, entre 8 e 48 kHz.');
  }
  const durationSeconds = dataBytes / (format.sampleRate * format.channels * (format.bitsPerSample / 8));
  if (durationSeconds > MAX_AUDIO_DURATION_SECONDS) throw runtimeError(413, 'voice_audio_too_long', 'A fala excede o limite de 45 segundos.');
  return { ...format, dataBytes, durationSeconds };
}

function defaultManifest() {
  return {
    schemaVersion: 1,
    whisper: {
      version: '1.8.6',
      binary: process.platform === 'win32' ? 'bin/whisper-cli.exe' : 'bin/whisper-cli',
      vadModel: 'models/whisper/ggml-silero-v6.2.0.bin',
      profiles: {
        rapid: { model: 'models/whisper/ggml-base-q5_1.bin', downloadBytes: 59700000 },
        balanced: { model: 'models/whisper/ggml-small-q5_1.bin', downloadBytes: 190000000 },
        accurate: { model: 'models/whisper/ggml-medium-q5_0.bin', downloadBytes: 539000000 }
      }
    },
    chatterbox: { version: 'v3-pt-br', python: process.platform === 'win32' ? 'venv-chatterbox/Scripts/python.exe' : 'venv-chatterbox/bin/python', model: 'ResembleAI/Chatterbox-Multilingual-pt-br', source: 'chatterbox-space/chatterbox/src', readyMarker: 'chatterbox.ready', hfHome: 'hf-cache' },
    piper: { version: '1.4.2', python: process.platform === 'win32' ? 'venv-piper/Scripts/python.exe' : 'venv-piper/bin/python', voice: 'pt_BR-cadu-medium', model: 'models/piper/pt_BR-cadu-medium.onnx', config: 'models/piper/pt_BR-cadu-medium.onnx.json' }
  };
}

function normalizeManifest(value) {
  const defaults = defaultManifest();
  if (!value || value.schemaVersion !== 1) return defaults;
  const result = structuredClone(defaults);
  for (const section of ['whisper', 'chatterbox', 'piper']) if (value[section] && typeof value[section] === 'object') Object.assign(result[section], value[section]);
  if (value.whisper?.profiles) result.whisper.profiles = { ...defaults.whisper.profiles, ...value.whisper.profiles };
  return result;
}

function emptyStatus() {
  return { available: false, localOnly: true, storesRawAudio: false, stt: { whisper: { available: false, profiles: {} } }, tts: { chatterbox: { available: false }, piper: { available: false } } };
}

function whisperText(payload) {
  if (typeof payload?.text === 'string') return payload.text;
  if (Array.isArray(payload?.transcription)) return payload.transcription.map(segment => segment?.text || '').join(' ');
  return '';
}

function validateTtsText(value) {
  const text = String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) throw runtimeError(400, 'empty_tts_text', 'Informe o texto que será falado.');
  if (text.length > MAX_TTS_TEXT) throw runtimeError(413, 'tts_text_too_large', `O texto excede ${MAX_TTS_TEXT} caracteres.`);
  return text;
}

function sanitizeEngineError(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/(?:hf_|api_)?token\s*[=:]\s*\S+/gi, 'token=[oculto]').slice(-500);
}

function voiceMetricTitle(name) {
  return ({ 'voice.vad_start': 'Fala detectada', 'voice.vad_end': 'Fim da fala', 'voice.stt_start': 'Transcrição iniciada', 'voice.stt_final': 'Transcrição concluída', 'voice.chat_start': 'Turno de voz enviado', 'voice.first_text': 'Primeiro texto recebido', 'voice.tts_start': 'Síntese iniciada', 'voice.first_audio': 'Primeiro áudio reproduzido', 'voice.tts_end': 'Síntese concluída', 'voice.barge_in': 'Interrupção humana', 'voice.feedback_ignored': 'Retorno acústico ignorado' })[name] || 'Métrica de voz';
}

async function isFile(target) {
  try { return (await fs.stat(target)).isFile(); } catch { return false; }
}

async function isDirectory(target) {
  try { return (await fs.stat(target)).isDirectory(); } catch { return false; }
}

function runtimeError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
