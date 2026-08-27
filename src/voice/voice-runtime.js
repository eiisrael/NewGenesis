import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 45;
const MAX_TTS_TEXT = 2000;
const MAX_TTS_AUDIO_BYTES = 24 * 1024 * 1024;
const STT_TIMEOUT_MS = 90_000;
const TTS_TIMEOUT_MS = 120_000;
const WHISPER_INITIAL_PROMPT = 'Genesis. Gênesis. Caruaru. Pernambuco. SupremeMind. Assistente Genesis em português do Brasil.';

const profileNames = Object.freeze({ rapid: 'rapid', balanced: 'balanced', accurate: 'accurate' });
const ttsPresets = Object.freeze({
  natural: { exaggeration: 0.5, temperature: 0.8, cfgWeight: 0.5 },
  calm: { exaggeration: 0.35, temperature: 0.7, cfgWeight: 0.55 },
  expressive: { exaggeration: 0.7, temperature: 0.85, cfgWeight: 0.45 }
});

export class VoiceRuntime {
  constructor({ root, dataDir, telemetry = null, spawnImpl = spawn, fetchImpl = globalThis.fetch } = {}) {
    this.root = path.resolve(root || process.cwd());
    this.voiceDir = path.resolve(dataDir || path.join(this.root, '.genesis'), 'voice');
    this.tempDir = path.join(this.voiceDir, 'tmp');
    this.telemetry = telemetry;
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl;
    this.manifest = defaultManifest();
    this.snapshot = emptyStatus();
    this.active = { stt: false, tts: false };
    this.children = new Set();
    this.ttsWorkers = new Map();
    this.whisperServer = null;
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
    const whisperServerBinary = this.#resolve(this.manifest.whisper.serverBinary);
    const vadModel = this.#resolve(this.manifest.whisper.vadModel);
    const profiles = {};
    for (const [name, entry] of Object.entries(this.manifest.whisper.profiles)) {
      const modelPath = this.#resolve(entry.model);
      profiles[name] = { ...entry, available: await isFile(modelPath) };
    }
    const whisperAvailable = await isFile(whisperBinary) && Object.values(profiles).some(profile => profile.available);

    const piperPython = this.#resolve(this.manifest.piper.python);
    const chatterboxPython = this.#resolve(this.manifest.chatterbox.python);
    const worker = path.join(this.root, 'scripts', 'voice', 'tts-server.py');
    const piperModel = this.#resolve(this.manifest.piper.model);
    const piperConfig = this.#resolve(this.manifest.piper.config);
    const chatterboxSource = this.#resolve(this.manifest.chatterbox.source);
    const chatterboxMarker = this.#resolve(this.manifest.chatterbox.readyMarker);
    const kokoroPython = this.#resolve(this.manifest.kokoro.python);
    const kokoroModel = this.#resolve(this.manifest.kokoro.model);
    const kokoroConfig = this.#resolve(this.manifest.kokoro.config);
    const kokoroVoices = this.#resolve(this.manifest.kokoro.voices);
    const piperPythonAvailable = await isFile(piperPython);
    const chatterboxPythonAvailable = await isFile(chatterboxPython);
    const kokoroPythonAvailable = await isFile(kokoroPython);
    const persistentSttAvailable = whisperAvailable && await isFile(whisperServerBinary);
    this.snapshot = {
      available: whisperAvailable || piperPythonAvailable || chatterboxPythonAvailable || kokoroPythonAvailable,
      localOnly: true,
      storesRawAudio: false,
      limits: { maxAudioBytes: MAX_AUDIO_BYTES, maxAudioSeconds: MAX_AUDIO_DURATION_SECONDS, maxTextCharacters: MAX_TTS_TEXT, concurrencyPerEngine: 1 },
      stt: {
        whisper: {
          available: whisperAvailable,
          version: this.manifest.whisper.version,
          vad: await isFile(vadModel),
          processMode: persistentSttAvailable ? 'persistent-server' : 'cli-per-request',
          warm: Boolean(this.whisperServer?.ready),
          profiles
        }
      },
      tts: {
        kokoro: { available: kokoroPythonAvailable && await isFile(worker) && await isFile(kokoroModel) && await isFile(kokoroConfig) && await hasKokoroVoices(kokoroVoices), version: this.manifest.kokoro.version, model: this.manifest.kokoro.modelId, voices: [...this.manifest.kokoro.voiceNames], warm: this.ttsWorkers.get('kokoro')?.ready === true, processMode: 'persistent-worker' },
        chatterbox: { available: chatterboxPythonAvailable && await isFile(worker) && await isDirectory(chatterboxSource) && await isFile(chatterboxMarker), version: this.manifest.chatterbox.version, model: this.manifest.chatterbox.model, warm: this.ttsWorkers.get('chatterbox')?.ready === true, processMode: 'persistent-worker' },
        piper: { available: piperPythonAvailable && await isFile(worker) && await isFile(piperModel) && await isFile(piperConfig), version: this.manifest.piper.version, model: this.manifest.piper.voice, warm: this.ttsWorkers.get('piper')?.ready === true, processMode: 'persistent-worker' }
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
    const startedAt = performance.now();
    try {
      let payload;
      let processMode = 'persistent-server';
      if (await isFile(this.#resolve(this.manifest.whisper.serverBinary))) {
        try {
          payload = await this.#transcribeWithServer(buffer, selected);
        } catch (error) {
          this.#emit('voice.stt.server_fallback', `Servidor persistente indisponível; usando CLI para este turno. ${sanitizeEngineError(error.message)}`, 'warning');
          this.#stopWhisperServer();
          payload = await this.#transcribeWithCli(buffer, selected);
          processMode = 'cli-fallback';
        }
      } else {
        payload = await this.#transcribeWithCli(buffer, selected);
        processMode = 'cli-per-request';
      }
      const text = whisperText(payload).replace(/\s+/g, ' ').trim().slice(0, 12000);
      return { text, language: payload?.result?.language || payload?.language || 'pt', profile: selected.name, processMode, durationSeconds: wav.durationSeconds, latencyMs: Math.round(performance.now() - startedAt) };
    } finally {
      this.active.stt = false;
    }
  }

  async synthesize({ text, engine = 'kokoro', preset = 'natural', rate = 1, voice = 'pf_dora' } = {}) {
    if (this.stopping) throw runtimeError(503, 'voice_shutting_down', 'A camada de voz está encerrando.');
    if (this.active.tts) throw runtimeError(429, 'voice_tts_busy', 'O sintetizador local já está gerando outra fala.');
    const safeText = validateTtsText(text);
    if (!['kokoro', 'chatterbox', 'piper'].includes(engine)) throw runtimeError(400, 'invalid_tts_engine', 'Engine TTS inválido.');
    const current = await this.refreshStatus();
    if (!current.tts[engine]?.available) throw runtimeError(503, `${engine}_not_installed`, `${engine} não está instalado. Execute scripts/setup-voice.ps1.`);
    const selectedPreset = Object.hasOwn(ttsPresets, preset) ? preset : 'natural';
    this.active.tts = true;
    const requestDir = await fs.mkdtemp(path.join(this.tempDir, 'tts-'));
    const outputPath = path.join(requestDir, 'output.wav');
    const startedAt = performance.now();
    try {
      const selectedVoice = this.manifest.kokoro.voiceNames.includes(voice) ? voice : 'pf_dora';
      const worker = await this.#ttsWorker(engine);
      await worker.request({ text: safeText, output: outputPath, preset: selectedPreset, rate: clamp(rate, 0.7, 1.6, 1), voice: selectedVoice }, TTS_TIMEOUT_MS);
      const audio = await fs.readFile(outputPath);
      if (audio.length < 44 || audio.length > MAX_TTS_AUDIO_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF') {
        throw runtimeError(502, 'invalid_tts_audio', 'O sintetizador local retornou um WAV inválido.');
      }
      return { audio, engine, preset: selectedPreset, processMode: 'persistent-worker', latencyMs: Math.round(performance.now() - startedAt) };
    } finally {
      this.active.tts = false;
      await fs.rm(requestDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  }

  recordMetric({ name, at, detail } = {}) {
    const allowed = new Set(['voice.vad_start', 'voice.vad_end', 'voice.stt_start', 'voice.stt_empty', 'voice.stt_final', 'voice.chat_start', 'voice.first_text', 'voice.tts_prepare_start', 'voice.tts_start', 'voice.first_audio', 'voice.tts_end', 'voice.barge_in', 'voice.feedback_ignored']);
    if (!allowed.has(name)) throw runtimeError(400, 'invalid_voice_metric', 'Métrica de voz inválida.');
    const safeDetail = {};
    if (typeof detail?.engine === 'string') safeDetail.engine = detail.engine.slice(0, 30);
    if (Number.isFinite(Number(detail?.latencyMs))) safeDetail.latencyMs = Math.max(0, Math.min(300000, Math.round(detail.latencyMs)));
    this.telemetry?.emit({ category: 'voice', type: name, title: voiceMetricTitle(name), detail: 'Marco local de latência; nenhum áudio foi registrado.', meta: { clientAt: Number(at) || null, ...safeDetail } });
    return { ok: true };
  }

  beginShutdown() {
    this.stopping = true;
    this.#stopWhisperServer();
    for (const worker of this.ttsWorkers.values()) worker.close();
    this.ttsWorkers.clear();
    for (const child of this.children) child.kill('SIGTERM');
  }

  async flush() {
    this.beginShutdown();
    await Promise.allSettled([...this.children].map(child => new Promise(resolve => child.once('exit', resolve))));
    await fs.rm(this.tempDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }

  #selectWhisperProfile(requested) {
    const name = profileNames[requested] || 'balanced';
    if (!this.snapshot.stt.whisper.profiles[name]?.available) return null;
    return { name, model: this.#resolve(this.manifest.whisper.profiles[name].model) };
  }

  async #transcribeWithCli(buffer, selected) {
    const requestDir = await fs.mkdtemp(path.join(this.tempDir, 'stt-'));
    const inputPath = path.join(requestDir, 'input.wav');
    const outputPrefix = path.join(requestDir, 'transcript');
    try {
      await fs.writeFile(inputPath, buffer, { flag: 'wx', mode: 0o600 });
      const args = ['-m', selected.model, '-f', inputPath, '-l', 'pt', '-oj', '-of', outputPrefix, '-np', '-nt'];
      args.push('--prompt', WHISPER_INITIAL_PROMPT);
      const vad = this.#resolve(this.manifest.whisper.vadModel);
      if (await isFile(vad)) args.push('--vad', '--vad-model', vad);
      await this.#run(this.#resolve(this.manifest.whisper.binary), args, { timeoutMs: STT_TIMEOUT_MS, kind: 'stt' });
      return JSON.parse(await fs.readFile(`${outputPrefix}.json`, 'utf8'));
    } finally {
      await fs.rm(requestDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  }

  async #transcribeWithServer(buffer, selected) {
    const server = await this.#ensureWhisperServer(selected);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'speech.wav');
    form.append('response_format', 'json');
    form.append('language', 'pt');
    form.append('temperature', '0.0');
    form.append('prompt', WHISPER_INITIAL_PROMPT);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${server.port}/inference`, {
        method: 'POST', body: form, signal: controller.signal, redirect: 'error'
      });
      const raw = await response.text();
      if (!response.ok) throw runtimeError(502, 'whisper_server_failed', `whisper-server respondeu ${response.status}: ${sanitizeEngineError(raw)}`);
      if (raw.length > 2 * 1024 * 1024) throw runtimeError(502, 'whisper_server_response_too_large', 'whisper-server retornou dados demais.');
      try { return JSON.parse(raw); }
      catch { throw runtimeError(502, 'whisper_server_invalid_json', 'whisper-server retornou JSON inválido.'); }
    } catch (error) {
      if (error?.name === 'AbortError') throw runtimeError(504, 'whisper_server_timeout', 'whisper-server excedeu o tempo limite.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #ensureWhisperServer(selected) {
    if (this.whisperServer?.ready && this.whisperServer.profile === selected.name && this.whisperServer.model === selected.model) return this.whisperServer;
    this.#stopWhisperServer();
    const port = await availableLoopbackPort();
    const binary = this.#resolve(this.manifest.whisper.serverBinary);
    const args = ['-m', selected.model, '--host', '127.0.0.1', '--port', String(port), '-l', 'pt', '-nt', '-ng'];
    const vad = this.#resolve(this.manifest.whisper.vadModel);
    if (await isFile(vad)) args.push('--vad', '--vad-model', vad);
    const child = this.spawnImpl(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(binary), env: process.env });
    this.children.add(child);
    const server = { child, port, profile: selected.name, model: selected.model, ready: false, stderr: '' };
    this.whisperServer = server;
    const collect = chunk => { server.stderr = `${server.stderr}${chunk.toString('utf8')}`.slice(-4_000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('exit', () => {
      this.children.delete(child);
      server.ready = false;
      if (this.whisperServer === server) this.whisperServer = null;
    });
    child.once('error', collect);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw runtimeError(503, 'whisper_server_start_failed', `whisper-server encerrou durante a inicialização. ${sanitizeEngineError(server.stderr)}`);
      try {
        await this.fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
        server.ready = true;
        return server;
      } catch { await delay(100); }
    }
    this.#stopWhisperServer();
    throw runtimeError(504, 'whisper_server_start_timeout', 'whisper-server não ficou pronto dentro do limite.');
  }

  #stopWhisperServer() {
    const server = this.whisperServer;
    this.whisperServer = null;
    if (!server?.child) return;
    server.ready = false;
    try { server.child.kill('SIGTERM'); } catch { /* já encerrado */ }
  }

  async #ttsWorker(engine) {
    const current = this.ttsWorkers.get(engine);
    if (current?.ready) return current;
    const script = path.join(this.root, 'scripts', 'voice', 'tts-server.py');
    let command;
    let args;
    let env = {};
    if (engine === 'kokoro') {
      command = this.#resolve(this.manifest.kokoro.python);
      args = [script, '--engine', 'kokoro', '--model', this.#resolve(this.manifest.kokoro.model), '--config', this.#resolve(this.manifest.kokoro.config), '--voices', this.#resolve(this.manifest.kokoro.voices)];
      env = { HF_HOME: this.#resolve('hf-cache'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
    } else if (engine === 'chatterbox') {
      command = this.#resolve(this.manifest.chatterbox.python);
      args = [script, '--engine', 'chatterbox', '--source', this.#resolve(this.manifest.chatterbox.source)];
      env = { HF_HOME: this.#resolve(this.manifest.chatterbox.hfHome), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
    } else {
      command = this.#resolve(this.manifest.piper.python);
      args = [script, '--engine', 'piper', '--model', this.#resolve(this.manifest.piper.model), '--config', this.#resolve(this.manifest.piper.config)];
    }
    const worker = new PersistentJsonWorker({
      command,
      args,
      env,
      spawnImpl: this.spawnImpl,
      onSpawn: child => this.children.add(child),
      onExit: child => this.children.delete(child)
    });
    this.ttsWorkers.set(engine, worker);
    try {
      await worker.start(TTS_TIMEOUT_MS);
      return worker;
    } catch (error) {
      this.ttsWorkers.delete(engine);
      worker.close();
      throw runtimeError(503, `${engine}_worker_start_failed`, `Não foi possível iniciar ${engine}: ${sanitizeEngineError(error.message)}`);
    }
  }

  #run(command, args, { timeoutMs, kind, env = {} }) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
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
      serverBinary: process.platform === 'win32' ? 'bin/whisper-server.exe' : 'bin/whisper-server',
      vadModel: 'models/whisper/ggml-silero-v6.2.0.bin',
      profiles: {
        rapid: { model: 'models/whisper/ggml-base-q5_1.bin', downloadBytes: 59700000 },
        balanced: { model: 'models/whisper/ggml-small-q5_1.bin', downloadBytes: 190000000 },
        accurate: { model: 'models/whisper/ggml-medium-q5_0.bin', downloadBytes: 539000000 }
      }
    },
    chatterbox: { version: 'v3-pt-br', python: process.platform === 'win32' ? 'venv-chatterbox/Scripts/python.exe' : 'venv-chatterbox/bin/python', model: 'ResembleAI/Chatterbox-Multilingual-pt-br', source: 'chatterbox-space/chatterbox/src', readyMarker: 'chatterbox.ready', hfHome: 'hf-cache' },
    kokoro: { version: '1.0', python: process.platform === 'win32' ? 'venv-kokoro/Scripts/python.exe' : 'venv-kokoro/bin/python', modelId: 'hexgrad/Kokoro-82M', model: 'models/kokoro/kokoro-v1_0.pth', config: 'models/kokoro/config.json', voices: 'models/kokoro/voices', voiceNames: ['pf_dora', 'pm_alex', 'pm_santa'] },
    piper: { version: '1.4.2', python: process.platform === 'win32' ? 'venv-piper/Scripts/python.exe' : 'venv-piper/bin/python', voice: 'pt_BR-cadu-medium', model: 'models/piper/pt_BR-cadu-medium.onnx', config: 'models/piper/pt_BR-cadu-medium.onnx.json' }
  };
}

function normalizeManifest(value) {
  const defaults = defaultManifest();
  if (!value || value.schemaVersion !== 1) return defaults;
  const result = structuredClone(defaults);
  for (const section of ['whisper', 'chatterbox', 'kokoro', 'piper']) if (value[section] && typeof value[section] === 'object') Object.assign(result[section], value[section]);
  if (value.whisper?.profiles) result.whisper.profiles = { ...defaults.whisper.profiles, ...value.whisper.profiles };
  return result;
}

function emptyStatus() {
  return { available: false, localOnly: true, storesRawAudio: false, stt: { whisper: { available: false, profiles: {} } }, tts: { kokoro: { available: false }, chatterbox: { available: false }, piper: { available: false } } };
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
  return ({ 'voice.vad_start': 'Fala detectada', 'voice.vad_end': 'Fim da fala', 'voice.stt_start': 'Transcrição iniciada', 'voice.stt_empty': 'Nenhuma fala transcrita', 'voice.stt_final': 'Transcrição concluída', 'voice.chat_start': 'Turno de voz enviado', 'voice.first_text': 'Primeiro texto recebido', 'voice.tts_prepare_start': 'Preparação de áudio iniciada', 'voice.tts_start': 'Síntese iniciada', 'voice.first_audio': 'Primeiro áudio reproduzido', 'voice.tts_end': 'Síntese concluída', 'voice.barge_in': 'Interrupção humana', 'voice.feedback_ignored': 'Retorno acústico ignorado' })[name] || 'Métrica de voz';
}

async function isFile(target) {
  try { return (await fs.stat(target)).isFile(); } catch { return false; }
}

async function isDirectory(target) {
  try { return (await fs.stat(target)).isDirectory(); } catch { return false; }
}

async function hasKokoroVoices(directory) {
  return (await Promise.all(['pf_dora.pt', 'pm_alex.pt', 'pm_santa.pt'].map(name => isFile(path.join(directory, name))))).every(Boolean);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

class PersistentJsonWorker {
  constructor({ command, args, env = {}, spawnImpl = spawn, onSpawn = () => {}, onExit = () => {} }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.onSpawn = onSpawn;
    this.onExit = onExit;
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.pending = new Map();
    this.counter = 0;
    this.stdout = '';
    this.stderr = '';
  }

  start(timeoutMs) {
    if (this.ready) return Promise.resolve(this);
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.command, this.args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...this.env }
      });
      this.child = child;
      this.onSpawn(child);
      const timer = setTimeout(() => {
        reject(new Error('O worker TTS excedeu o tempo de inicialização.'));
        this.close();
      }, timeoutMs);
      const finishStart = (error = null) => {
        clearTimeout(timer);
        if (error) reject(error);
        else { this.ready = true; resolve(this); }
      };
      child.stdout.on('data', chunk => {
        this.stdout += chunk.toString('utf8');
        if (this.stdout.length > 2 * 1024 * 1024) return this.close();
        let lineEnd;
        while ((lineEnd = this.stdout.indexOf('\n')) >= 0) {
          const line = this.stdout.slice(0, lineEnd).trim();
          this.stdout = this.stdout.slice(lineEnd + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.type === 'ready') {
            finishStart();
            continue;
          }
          const entry = this.pending.get(String(message.id || ''));
          if (!entry) continue;
          this.pending.delete(String(message.id));
          clearTimeout(entry.timer);
          if (message.ok === true) entry.resolve(message);
          else entry.reject(new Error(sanitizeEngineError(message.error || 'O worker TTS falhou.')));
        }
      });
      child.stderr.on('data', chunk => { this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-8_000); });
      child.once('error', error => finishStart(error));
      child.once('exit', (code, signal) => {
        this.onExit(child);
        this.ready = false;
        this.child = null;
        this.startPromise = null;
        const error = new Error(`Worker TTS encerrado (${signal || code}). ${sanitizeEngineError(this.stderr)}`);
        finishStart(error);
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(error);
        }
        this.pending.clear();
      });
    });
    return this.startPromise;
  }

  async request(payload, timeoutMs) {
    await this.start(timeoutMs);
    if (!this.child?.stdin?.writable) throw new Error('Worker TTS não está disponível.');
    const id = `${process.pid}-${Date.now()}-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('O worker TTS excedeu o tempo limite.'));
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    if (!child) return;
    try { child.stdin.end(); } catch { /* já encerrado */ }
    try { child.kill('SIGTERM'); } catch { /* já encerrado */ }
  }
}

function runtimeError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
