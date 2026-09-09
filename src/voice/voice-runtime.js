import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 45;
const MAX_TTS_TEXT = 2000;
const MAX_TTS_AUDIO_BYTES = 24 * 1024 * 1024;
const TTS_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const TTS_CACHE_MAX_ENTRIES = 32;
const TTS_CACHE_TTL_MS = 5 * 60_000;
const PYTHON_PROBE_TTL_MS = 60_000;
const STT_TIMEOUT_MS = Object.freeze({ rapid: 18_000, balanced: 30_000, accurate: 50_000 });
const WHISPER_STARTUP_TIMEOUT_MS = 20_000;
const WHISPER_FAILURE_COOLDOWN_MS = 15_000;
const TTS_TIMEOUT_MS = Object.freeze({ kokoro: 28_000, chatterbox: 60_000, piper: 60_000 });
const TTS_STARTUP_TIMEOUT_MS = Object.freeze({ kokoro: 120_000, chatterbox: 60_000, piper: 60_000 });
const KOKORO_FAILURE_COOLDOWN_MS = 30_000;
const WHISPER_INITIAL_PROMPT = 'Genesis. Gênesis. Caruaru. Pernambuco. SupremeMind. Assistente Genesis em português do Brasil.';

const profileNames = Object.freeze({ rapid: 'rapid', balanced: 'balanced', accurate: 'accurate' });
const ttsPresets = Object.freeze({
  natural: { exaggeration: 0.5, temperature: 0.8, cfgWeight: 0.5 },
  calm: { exaggeration: 0.35, temperature: 0.7, cfgWeight: 0.55 },
  expressive: { exaggeration: 0.7, temperature: 0.85, cfgWeight: 0.45 }
});

export class VoiceRuntime {
  constructor({ root, dataDir, telemetry = null, spawnImpl = spawn, fetchImpl = globalThis.fetch, backgroundWarmup = true, timeouts = {}, ttsCache = {} } = {}) {
    this.root = path.resolve(root || process.cwd());
    this.voiceDir = path.resolve(dataDir || path.join(this.root, '.genesis'), 'voice');
    this.tempDir = path.join(this.voiceDir, 'tmp');
    this.telemetry = telemetry;
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl;
    this.timeouts = {
      stt: Object.fromEntries(Object.entries(STT_TIMEOUT_MS).map(([profile, value]) => [profile, positiveTimeout(timeouts.stt?.[profile] ?? timeouts.stt, value)])),
      whisperStartup: positiveTimeout(timeouts.whisperStartup, WHISPER_STARTUP_TIMEOUT_MS),
      whisperCooldown: positiveTimeout(timeouts.whisperCooldown, WHISPER_FAILURE_COOLDOWN_MS),
      pythonProbe: positiveTimeout(timeouts.pythonProbe, 5_000),
      tts: Object.fromEntries(Object.entries(TTS_TIMEOUT_MS).map(([engine, value]) => [engine, positiveTimeout(timeouts.tts?.[engine], value)])),
      ttsStartup: Object.fromEntries(Object.entries(TTS_STARTUP_TIMEOUT_MS).map(([engine, value]) => [engine, positiveTimeout(timeouts.ttsStartup?.[engine], value)])),
      kokoroCooldown: positiveTimeout(timeouts.kokoroCooldown, KOKORO_FAILURE_COOLDOWN_MS)
    };
    this.manifest = defaultManifest();
    this.snapshot = emptyStatus();
    this.active = { stt: false, tts: false };
    this.children = new Set();
    this.ttsWorkers = new Map();
    this.pythonProbes = new Map();
    this.ttsQueue = [];
    this.ttsDraining = false;
    this.ttsActiveJob = null;
    this.ttsCooldownUntil = new Map();
    this.ttsAudioCache = new Map();
    this.ttsCacheBytes = 0;
    this.ttsCacheLimits = {
      maxBytes: clamp(ttsCache.maxBytes, 0, TTS_CACHE_MAX_BYTES, TTS_CACHE_MAX_BYTES),
      maxEntries: Math.floor(clamp(ttsCache.maxEntries, 0, TTS_CACHE_MAX_ENTRIES, TTS_CACHE_MAX_ENTRIES)),
      ttlMs: clamp(ttsCache.ttlMs, 0, TTS_CACHE_TTL_MS, TTS_CACHE_TTL_MS)
    };
    this.whisperServer = null;
    this.whisperCooldownUntil = 0;
    this.engineHealth = new Map(['whisper', 'kokoro', 'chatterbox', 'piper'].map(name => [name, { warming: false, lastError: null }]));
    this.backgroundTasks = new Set();
    this.backgroundWarmup = backgroundWarmup !== false;
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
    if (this.backgroundWarmup) this.#startBackgroundWarmup();
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
    const [piperPythonStatus, chatterboxPythonStatus, kokoroPythonStatus] = await Promise.all([
      this.#probePython('piper', piperPython),
      this.#probePython('chatterbox', chatterboxPython),
      this.#probePython('kokoro', kokoroPython)
    ]);
    const piperPythonAvailable = piperPythonStatus.available;
    const chatterboxPythonAvailable = chatterboxPythonStatus.available;
    const kokoroPythonAvailable = kokoroPythonStatus.available;
    const persistentSttAvailable = whisperAvailable && await isFile(whisperServerBinary);
    const workerAvailable = await isFile(worker);
    const kokoroAvailable = kokoroPythonAvailable && workerAvailable && await isFile(kokoroModel) && await isFile(kokoroConfig) && await hasKokoroVoices(kokoroVoices);
    const chatterboxAvailable = chatterboxPythonAvailable && workerAvailable && await isDirectory(chatterboxSource) && await isFile(chatterboxMarker);
    const piperAvailable = piperPythonAvailable && workerAvailable && await isFile(piperModel) && await isFile(piperConfig);
    const whisperWarm = Boolean(this.whisperServer?.ready);
    const kokoroWarm = this.ttsWorkers.get('kokoro')?.ready === true;
    const chatterboxWarm = this.ttsWorkers.get('chatterbox')?.ready === true;
    const piperWarm = this.ttsWorkers.get('piper')?.ready === true;
    const whisperRuntime = this.#runtimeStatus('whisper', whisperAvailable, whisperWarm, this.whisperCooldownUntil);
    const kokoroRuntime = this.#runtimeStatus('kokoro', kokoroAvailable, kokoroWarm, this.ttsCooldownUntil.get('kokoro') || 0);
    const chatterboxRuntime = this.#runtimeStatus('chatterbox', chatterboxAvailable, chatterboxWarm, this.ttsCooldownUntil.get('chatterbox') || 0);
    const piperRuntime = this.#runtimeStatus('piper', piperAvailable, piperWarm, this.ttsCooldownUntil.get('piper') || 0);
    this.snapshot = {
      available: whisperAvailable || piperAvailable || chatterboxAvailable || kokoroAvailable,
      localOnly: true,
      storesRawAudio: false,
      limits: { maxAudioBytes: MAX_AUDIO_BYTES, maxAudioSeconds: MAX_AUDIO_DURATION_SECONDS, maxTextCharacters: MAX_TTS_TEXT, concurrencyPerEngine: 1 },
      stt: {
        whisper: {
          available: whisperAvailable,
          version: this.manifest.whisper.version,
          vad: await isFile(vadModel),
          processMode: persistentSttAvailable ? 'persistent-server' : 'cli-per-request',
          ...whisperRuntime,
          profiles
        }
      },
      tts: {
        kokoro: { available: kokoroAvailable, version: this.manifest.kokoro.version, model: this.manifest.kokoro.modelId, voices: [...this.manifest.kokoro.voiceNames], ...kokoroRuntime, pythonAvailable: kokoroPythonAvailable, ...kokoroPythonStatus.error, processMode: 'persistent-worker' },
        chatterbox: { available: chatterboxAvailable, version: this.manifest.chatterbox.version, model: this.manifest.chatterbox.model, ...chatterboxRuntime, pythonAvailable: chatterboxPythonAvailable, ...chatterboxPythonStatus.error, processMode: 'persistent-worker' },
        piper: { available: piperAvailable, version: this.manifest.piper.version, model: this.manifest.piper.voice, ...piperRuntime, pythonAvailable: piperPythonAvailable, ...piperPythonStatus.error, processMode: 'persistent-worker' }
      }
    };
    this.snapshot.queue = { ttsWaiting: this.ttsQueue.length, ttsActive: this.active.tts, sttActive: this.active.stt };
    return this.status();
  }

  async #probePython(engine, executable) {
    let file;
    try { file = await fs.stat(executable); } catch { return { available: false }; }
    if (!file.isFile()) return { available: false };
    const config = await fs.stat(path.join(path.dirname(path.dirname(executable)), 'pyvenv.cfg')).catch(() => null);
    const signature = `${file.mtimeMs}:${file.size}:${config?.mtimeMs}:${config?.size}`;
    const cached = this.pythonProbes.get(executable);
    if (cached?.signature === signature && cached.expiresAt > Date.now()) return cached.promise;
    const modules = engine === 'piper' ? ['piper', 'onnxruntime']
      : engine === 'kokoro' ? ['kokoro', 'torch', 'misaki', 'phonemizer', 'soundfile', 'espeakng_loader']
        : ['torch', 'torchaudio', 'huggingface_hub'];
    const probe = `import sys,importlib.util; assert (3,10) <= sys.version_info[:2] <= (3,${engine === 'piper' ? 14 : 12}), 'Versao Python incompativel'; missing=[name for name in ${JSON.stringify(modules)} if importlib.util.find_spec(name) is None]; assert not missing, 'Dependencias Python ausentes: '+', '.join(missing)`;
    const promise = this.#run(executable, ['-I', '-c', probe], {
      deadline: Date.now() + this.timeouts.pythonProbe,
      kind: 'voice_python',
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    }).then(() => ({ available: true }), error => ({
      available: false,
      error: { lastError: `Python de ${engine} indisponível. Reexecute scripts/setup-voice.ps1 -Component ${engine} com um Python válido. ${sanitizeEngineError(error.message)}` }
    }));
    this.pythonProbes.set(executable, { signature, expiresAt: Date.now() + PYTHON_PROBE_TTL_MS, promise });
    const result = await promise;
    // Retry a repaired environment promptly without probing on every status poll.
    if (!result.available && this.pythonProbes.get(executable)?.promise === promise) this.pythonProbes.get(executable).expiresAt = Date.now() + 5_000;
    return result;
  }

  async transcribe(audio, { quality = 'rapid', segmented = false, signal = null } = {}) {
    if (this.stopping) throw runtimeError(503, 'voice_shutting_down', 'A camada de voz está encerrando.');
    throwIfVoiceAborted(signal);
    if (this.active.stt) throw runtimeError(429, 'voice_stt_busy', 'O Whisper local já está transcrevendo outra fala.');
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
    const wav = inspectWave(buffer);
    const profile = profileNames[quality] || 'rapid';
    const selected = this.#selectWhisperProfile(profile);
    if (!selected) throw runtimeError(503, 'whisper_not_installed', 'O perfil solicitado do Whisper local não está instalado. Execute scripts/setup-voice.ps1.');
    const deadline = Date.now() + this.timeouts.stt[selected.name];
    const operation = createOperationSignal(signal, deadline, () => runtimeError(504, 'voice_stt_timeout', 'A transcrição local excedeu o tempo limite.'));
    this.active.stt = true;
    this.#syncQueueStatus();
    const startedAt = performance.now();
    try {
      throwIfVoiceAborted(operation.signal);
      let payload;
      let processMode;
      const persistentAvailable = await isFile(this.#resolve(this.manifest.whisper.serverBinary));
      if (persistentAvailable && Date.now() >= this.whisperCooldownUntil) {
        processMode = 'persistent-server';
        try {
          payload = await this.#transcribeWithServer(buffer, selected, { signal: operation.signal, deadline });
        } catch (error) {
          this.#stopWhisperServer(error);
          if (!isVoiceAbort(error)) this.#markWhisperFailure(error);
          throw error;
        }
      } else {
        processMode = persistentAvailable ? 'cli-cooldown' : 'cli-per-request';
        payload = await this.#transcribeWithCli(buffer, selected, { signal: operation.signal, deadline });
      }
      const text = whisperText(payload).replace(/\s+/g, ' ').trim().slice(0, 12000);
      const detail = whisperDetail(payload, segmented === true);
      return {
        text,
        language: payload?.result?.language || payload?.language || payload?.detected_language || 'pt',
        profile: selected.name,
        processMode,
        durationSeconds: wav.durationSeconds,
        latencyMs: Math.round(performance.now() - startedAt),
        ...detail
      };
    } finally {
      this.active.stt = false;
      this.#syncQueueStatus();
      operation.cleanup();
    }
  }

  async synthesize({ text, engine = 'kokoro', preset = 'natural', rate = 1, voice = 'pf_dora' } = {}, { signal = null } = {}) {
    if (this.stopping) throw runtimeError(503, 'voice_shutting_down', 'A camada de voz está encerrando.');
    throwIfVoiceAborted(signal);
    const safeText = validateTtsText(text);
    if (!['kokoro', 'chatterbox', 'piper'].includes(engine)) throw runtimeError(400, 'invalid_tts_engine', 'Engine TTS inválido.');
    const selectedPreset = Object.hasOwn(ttsPresets, preset) ? preset : 'natural';
    const selectedVoice = this.manifest.kokoro.voiceNames.includes(voice) ? voice : 'pf_dora';
    const selectedRate = clamp(rate, 0.7, 1.6, 1);
    const cacheKey = createHash('sha256').update(JSON.stringify([engine, this.manifest[engine], selectedVoice, selectedPreset, selectedRate, safeText])).digest('hex');
    const startedAt = performance.now();
    // Cold model imports/loading need more time; ready workers retain the shorter synthesis budget.
    const startupBudget = this.ttsWorkers.get(engine)?.ready ? 0 : this.timeouts.ttsStartup[engine];
    const deadline = Date.now() + Math.max(this.timeouts.tts[engine], startupBudget);
    return this.#enqueueTts(async (jobSignal, absoluteDeadline) => {
      throwIfVoiceAborted(jobSignal);
      throwIfDeadlineExpired(absoluteDeadline, () => ttsTimeoutError(engine));
      const current = await this.refreshStatus();
      if (!current.tts[engine]?.available) throw runtimeError(503, `${engine}_not_installed`, current.tts[engine]?.lastError || `${engine} não está instalado. Execute scripts/setup-voice.ps1.`);
      throwIfVoiceAborted(jobSignal);
      throwIfDeadlineExpired(absoluteDeadline, () => ttsTimeoutError(engine));
      const cachedAudio = this.#readTtsCache(cacheKey);
      if (cachedAudio) return { audio: cachedAudio, engine, preset: selectedPreset, processMode: 'memory-cache', latencyMs: Math.round(performance.now() - startedAt) };
      const cooldownUntil = this.ttsCooldownUntil.get(engine) || 0;
      if (cooldownUntil > Date.now()) {
        throw runtimeError(503, `${engine}_worker_cooldown`, `${engine} está em recuperação após uma falha de inicialização. Tente novamente em instantes.`);
      }
      const requestDir = await fs.mkdtemp(path.join(this.tempDir, 'tts-'));
      const outputPath = path.join(requestDir, 'output.wav');
      try {
        throwIfVoiceAborted(jobSignal);
        throwIfDeadlineExpired(absoluteDeadline, () => ttsTimeoutError(engine));
        const worker = await this.#ttsWorker(engine, { signal: jobSignal, deadline: absoluteDeadline });
        await worker.request({ text: safeText, output: outputPath, preset: selectedPreset, rate: selectedRate, voice: selectedVoice }, { signal: jobSignal, deadline: absoluteDeadline });
        throwIfVoiceAborted(jobSignal);
        throwIfDeadlineExpired(absoluteDeadline, () => ttsTimeoutError(engine, worker.stderr));
        const audio = await fs.readFile(outputPath);
        if (audio.length < 44 || audio.length > MAX_TTS_AUDIO_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF') {
          throw runtimeError(502, 'invalid_tts_audio', 'O sintetizador local retornou um WAV inválido.');
        }
        throwIfVoiceAborted(jobSignal);
        throwIfDeadlineExpired(absoluteDeadline, () => ttsTimeoutError(engine));
        this.#writeTtsCache(cacheKey, audio);
        return { audio, engine, preset: selectedPreset, processMode: 'persistent-worker', latencyMs: Math.round(performance.now() - startedAt) };
      } catch (error) {
        if (isVoiceAbort(error) || isVoiceTimeout(error)) this.#discardTtsWorker(engine, error);
        if (isVoiceTimeout(error)) this.#markTtsFailure(engine, error);
        throw error;
      } finally {
        await fs.rm(requestDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
      }
    }, { signal, deadline, engine });
  }

  recordMetric({ name, at, detail } = {}) {
    const allowed = new Set(['voice.vad_start', 'voice.vad_end', 'voice.stt_start', 'voice.stt_empty', 'voice.stt_final', 'voice.chat_start', 'voice.first_text', 'voice.tts_prepare_start', 'voice.tts_retry', 'voice.tts_start', 'voice.first_audio', 'voice.tts_end', 'voice.barge_in', 'voice.feedback_ignored']);
    if (!allowed.has(name)) throw runtimeError(400, 'invalid_voice_metric', 'Métrica de voz inválida.');
    const safeDetail = {};
    if (typeof detail?.engine === 'string') safeDetail.engine = detail.engine.slice(0, 30);
    if (Number.isFinite(Number(detail?.latencyMs))) safeDetail.latencyMs = Math.max(0, Math.min(300000, Math.round(detail.latencyMs)));
    if (Number.isFinite(Number(detail?.attempt))) safeDetail.attempt = Math.max(1, Math.min(20, Math.round(detail.attempt)));
    if (Number.isFinite(Number(detail?.delayMs))) safeDetail.delayMs = Math.max(0, Math.min(30000, Math.round(detail.delayMs)));
    this.telemetry?.emit({ category: 'voice', type: name, title: voiceMetricTitle(name), detail: 'Marco local de latência; nenhum áudio foi registrado.', meta: { clientAt: Number(at) || null, ...safeDetail } });
    return { ok: true };
  }

  beginShutdown() {
    if (this.stopping) return;
    this.stopping = true;
    const error = runtimeError(503, 'voice_shutting_down', 'A camada de voz está encerrando.');
    this.ttsActiveJob?.controller.abort(error);
    for (const job of this.ttsQueue.splice(0)) {
      job.controller.abort(error);
      job.reject(error);
      job.cleanup();
    }
    this.#stopWhisperServer(error);
    for (const worker of this.ttsWorkers.values()) worker.close(error);
    this.ttsWorkers.clear();
    this.ttsAudioCache.clear();
    this.ttsCacheBytes = 0;
    for (const child of this.children) child.kill('SIGTERM');
  }

  #readTtsCache(key) {
    const now = Date.now();
    for (const [entryKey, entry] of this.ttsAudioCache) {
      if (entry.expiresAt <= now) this.#removeTtsCacheEntry(entryKey);
    }
    const entry = this.ttsAudioCache.get(key);
    if (!entry) return null;
    this.ttsAudioCache.delete(key);
    this.ttsAudioCache.set(key, entry);
    return Buffer.from(entry.audio);
  }

  #writeTtsCache(key, audio) {
    const { maxBytes, maxEntries, ttlMs } = this.ttsCacheLimits;
    if (!maxEntries || !ttlMs || audio.length > maxBytes) return;
    this.#removeTtsCacheEntry(key);
    while (this.ttsAudioCache.size && (this.ttsCacheBytes + audio.length > maxBytes || this.ttsAudioCache.size >= maxEntries)) {
      this.#removeTtsCacheEntry(this.ttsAudioCache.keys().next().value);
    }
    // Only generated speech is retained, in bounded process memory. Copies
    // prevent a playback consumer from modifying another request's audio.
    this.ttsAudioCache.set(key, { audio: Buffer.from(audio), expiresAt: Date.now() + ttlMs });
    this.ttsCacheBytes += audio.length;
  }

  #removeTtsCacheEntry(key) {
    const entry = this.ttsAudioCache.get(key);
    if (entry) this.ttsCacheBytes -= entry.audio.length;
    this.ttsAudioCache.delete(key);
  }

  async flush() {
    this.beginShutdown();
    await Promise.allSettled([...this.children].map(child => new Promise(resolve => child.once('exit', resolve))));
    await fs.rm(this.tempDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }

  #runtimeStatus(name, available, warm, cooldownUntil = 0) {
    const state = this.engineHealth.get(name) || { warming: false, lastError: null };
    const cooling = cooldownUntil > Date.now();
    const warming = available && !warm && !cooling && state.warming === true;
    const health = !available
      ? 'unavailable'
      : warm
        ? 'healthy'
        : cooling
          ? 'cooldown'
          : warming
            ? 'warming'
            : state.lastError
              ? 'unhealthy'
              : 'cold';
    return {
      warm: available && warm === true && !cooling,
      warming,
      health,
      ...(cooling ? { cooldownUntil: new Date(cooldownUntil).toISOString() } : {}),
      ...(state.lastError && !warm ? { lastError: state.lastError } : {})
    };
  }

  #setEngineHealth(name, patch) {
    const current = this.engineHealth.get(name) || { warming: false, lastError: null };
    this.engineHealth.set(name, { ...current, ...patch });
    const target = name === 'whisper' ? this.snapshot.stt?.whisper : this.snapshot.tts?.[name];
    if (!target) return;
    const warm = name === 'whisper' ? this.whisperServer?.ready === true : this.ttsWorkers.get(name)?.ready === true;
    const cooldownUntil = name === 'whisper' ? this.whisperCooldownUntil : this.ttsCooldownUntil.get(name) || 0;
    Object.assign(target, this.#runtimeStatus(name, target.available === true, warm, cooldownUntil));
  }

  #startBackgroundWarmup() {
    const start = promise => {
      const observed = Promise.resolve(promise).catch(error => {
        if (!this.stopping && !isVoiceAbort(error)) this.#emit('voice.runtime.warmup_failed', sanitizeEngineError(error.message), 'warning');
      });
      this.backgroundTasks.add(observed);
      observed.finally(() => this.backgroundTasks.delete(observed));
    };
    if (this.snapshot.tts?.piper?.available) {
      const deadline = Date.now() + this.timeouts.ttsStartup.piper;
      this.#setEngineHealth('piper', { warming: true, lastError: null });
      start(this.#ttsWorker('piper', { deadline }));
    }
    if (this.snapshot.stt?.whisper?.processMode === 'persistent-server') {
      const selected = this.#selectWarmWhisperProfile();
      if (selected) {
        const deadline = Date.now() + this.timeouts.whisperStartup;
        this.#setEngineHealth('whisper', { warming: true, lastError: null });
        start(this.#ensureWhisperServer(selected, { deadline }));
      }
    }
  }

  #selectWarmWhisperProfile() {
    for (const name of ['rapid', 'balanced', 'accurate']) {
      const selected = this.#selectWhisperProfile(name);
      if (selected) return selected;
    }
    return null;
  }

  #enqueueTts(run, { signal, deadline, engine }) {
    if (this.stopping) return Promise.reject(runtimeError(503, 'voice_shutting_down', 'A camada de voz está encerrando.'));
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let queued = true;
      let settled = false;
      const onExternalAbort = () => controller.abort(voiceAbortError(signal?.reason));
      if (signal?.aborted) onExternalAbort();
      else signal?.addEventListener?.('abort', onExternalAbort, { once: true });
      const queueTimer = setTimeout(() => controller.abort(ttsTimeoutError(engine)), Math.max(1, deadline - Date.now()));
      const cleanup = () => {
        clearTimeout(queueTimer);
        signal?.removeEventListener?.('abort', onExternalAbort);
        controller.signal.removeEventListener('abort', onQueuedAbort);
      };
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      const onQueuedAbort = () => {
        if (!queued) return;
        const index = this.ttsQueue.indexOf(job);
        if (index >= 0) this.ttsQueue.splice(index, 1);
        settle(voiceAbortError(controller.signal.reason));
      };
      const job = { controller, deadline, engine, run, reject: error => settle(error), resolve: value => settle(null, value), cleanup, markStarted: () => { queued = false; clearTimeout(queueTimer); } };
      controller.signal.addEventListener('abort', onQueuedAbort, { once: true });
      if (controller.signal.aborted) return onQueuedAbort();
      this.ttsQueue.push(job);
      this.#syncQueueStatus();
      void this.#drainTtsQueue();
    });
  }

  async #drainTtsQueue() {
    if (this.ttsDraining) return;
    this.ttsDraining = true;
    try {
      while (this.ttsQueue.length) {
        const job = this.ttsQueue.shift();
        if (job.controller.signal.aborted) {
          job.reject(voiceAbortError(job.controller.signal.reason));
          continue;
        }
        job.markStarted();
        this.ttsActiveJob = job;
        this.active.tts = true;
        this.#syncQueueStatus();
        try {
          const result = await job.run(job.controller.signal, job.deadline);
          job.resolve(result);
        } catch (error) {
          job.reject(error);
        } finally {
          this.ttsActiveJob = null;
          this.active.tts = false;
          this.#syncQueueStatus();
        }
      }
    } finally {
      this.ttsDraining = false;
      if (this.ttsQueue.length) void this.#drainTtsQueue();
    }
  }

  #syncQueueStatus() {
    if (this.snapshot.queue) Object.assign(this.snapshot.queue, { ttsWaiting: this.ttsQueue.length, ttsActive: this.active.tts, sttActive: this.active.stt });
  }

  #selectWhisperProfile(requested) {
    const name = profileNames[requested] || 'rapid';
    if (!this.snapshot.stt.whisper.profiles[name]?.available) return null;
    return { name, model: this.#resolve(this.manifest.whisper.profiles[name].model) };
  }

  async #transcribeWithCli(buffer, selected, { signal, deadline }) {
    const requestDir = await fs.mkdtemp(path.join(this.tempDir, 'stt-'));
    const inputPath = path.join(requestDir, 'input.wav');
    const outputPrefix = path.join(requestDir, 'transcript');
    try {
      throwIfVoiceAborted(signal);
      throwIfDeadlineExpired(deadline, () => runtimeError(504, 'voice_stt_timeout', 'A transcrição local excedeu o tempo limite.'));
      await fs.writeFile(inputPath, buffer, { flag: 'wx', mode: 0o600 });
      // whisper.cpp 1.8.6 flash attention can crash the Windows CPU backend.
      const args = ['-m', selected.model, '-f', inputPath, '-l', 'pt', '-oj', '-of', outputPrefix, '-np', '-nt', '-nfa'];
      args.push('--prompt', WHISPER_INITIAL_PROMPT);
      const vad = this.#resolve(this.manifest.whisper.vadModel);
      if (await isFile(vad)) args.push('--vad', '--vad-model', vad);
      await this.#run(this.#resolve(this.manifest.whisper.binary), args, { deadline, signal, kind: 'stt' });
      throwIfVoiceAborted(signal);
      return JSON.parse(await fs.readFile(`${outputPrefix}.json`, 'utf8'));
    } finally {
      await fs.rm(requestDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  }

  async #transcribeWithServer(buffer, selected, { signal, deadline }) {
    const server = await this.#ensureWhisperServer(selected, { signal, deadline });
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'speech.wav');
    form.append('response_format', 'verbose_json');
    form.append('language', 'pt');
    form.append('temperature', '0.0');
    form.append('prompt', WHISPER_INITIAL_PROMPT);
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${server.port}/inference`, {
        method: 'POST', body: form, signal, redirect: 'error'
      });
      const raw = await response.text();
      if (!response.ok) throw runtimeError(502, 'whisper_server_failed', `whisper-server respondeu ${response.status}: ${sanitizeEngineError(raw)}`);
      if (raw.length > 2 * 1024 * 1024) throw runtimeError(502, 'whisper_server_response_too_large', 'whisper-server retornou dados demais.');
      try { return JSON.parse(raw); }
      catch { throw runtimeError(502, 'whisper_server_invalid_json', 'whisper-server retornou JSON inválido.'); }
    } catch (error) {
      if (signal?.aborted) {
        const reason = voiceAbortError(signal.reason);
        if (reason.code === 'voice_stt_timeout') {
          throw runtimeError(504, 'voice_stt_timeout', `A transcrição local excedeu o tempo limite. ${sanitizeEngineError(server.stderr)}`.trim());
        }
        throw reason;
      }
      if (error?.name === 'AbortError') throw runtimeError(504, 'voice_stt_timeout', `A transcrição local excedeu o tempo limite. ${sanitizeEngineError(server.stderr)}`.trim());
      throw error;
    }
  }

  async #ensureWhisperServer(selected, { signal = null, deadline = Date.now() + this.timeouts.whisperStartup } = {}) {
    throwIfVoiceAborted(signal);
    throwIfDeadlineExpired(deadline, () => runtimeError(504, 'whisper_server_start_timeout', 'whisper-server não ficou pronto dentro do limite.'));
    const existing = this.whisperServer;
    if (existing && existing.profile === selected.name && existing.model === selected.model) {
      if (existing.ready) return existing;
      if (existing.startPromise) {
        return waitForPromise(existing.startPromise, {
          signal,
          deadline,
          timeoutError: () => runtimeError(504, 'whisper_server_start_timeout', `whisper-server não ficou pronto dentro do limite. ${sanitizeEngineError(existing.stderr)}`.trim()),
          onCancel: error => this.#stopWhisperServer(error, existing)
        });
      }
    }
    this.#stopWhisperServer(runtimeError(503, 'whisper_server_restarting', 'whisper-server reiniciado para trocar o perfil.'));
    const port = await availableLoopbackPort();
    throwIfVoiceAborted(signal);
    const binary = this.#resolve(this.manifest.whisper.serverBinary);
    const args = ['-m', selected.model, '--host', '127.0.0.1', '--port', String(port), '-l', 'pt', '-nt', '-ng', '-nfa'];
    const vad = this.#resolve(this.manifest.whisper.vadModel);
    if (await isFile(vad)) args.push('--vad', '--vad-model', vad);
    const child = this.spawnImpl(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(binary), env: process.env });
    this.children.add(child);
    const server = { child, port, profile: selected.name, model: selected.model, ready: false, stderr: '', stopped: false, stopReason: null, startPromise: null };
    this.whisperServer = server;
    this.#setEngineHealth('whisper', { warming: true, lastError: null });
    const collect = chunk => { server.stderr = `${server.stderr}${chunk.toString('utf8')}`.slice(-4_000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('exit', () => {
      this.children.delete(child);
      server.ready = false;
      if (this.whisperServer === server) this.whisperServer = null;
    });
    child.once('error', error => {
      collect(error);
      server.stopReason ||= runtimeError(503, 'whisper_server_start_failed', `Não foi possível iniciar whisper-server. ${sanitizeEngineError(error.message)}`.trim());
    });
    const startupDeadline = Math.min(deadline, Date.now() + this.timeouts.whisperStartup);
    server.startPromise = this.#waitForWhisperServer(server, startupDeadline).then(ready => {
      this.whisperCooldownUntil = 0;
      this.#setEngineHealth('whisper', { warming: false, lastError: null });
      return ready;
    }).catch(error => {
      if (!isVoiceAbort(error) && error.code !== 'whisper_server_restarting') this.#markWhisperFailure(error);
      else this.#setEngineHealth('whisper', { warming: false });
      throw error;
    });
    return waitForPromise(server.startPromise, {
      signal,
      deadline,
      timeoutError: () => runtimeError(504, 'whisper_server_start_timeout', `whisper-server não ficou pronto dentro do limite. ${sanitizeEngineError(server.stderr)}`.trim()),
      onCancel: error => this.#stopWhisperServer(error, server)
    });
  }

  async #waitForWhisperServer(server, deadline) {
    while (Date.now() < deadline) {
      if (server.stopped) throw server.stopReason || runtimeError(503, 'whisper_server_stopped', 'whisper-server foi encerrado.');
      if (server.child.exitCode != null) throw runtimeError(503, 'whisper_server_start_failed', `whisper-server encerrou durante a inicialização. ${sanitizeEngineError(server.stderr)}`.trim());
      try {
        const probeTimeout = Math.max(1, Math.min(800, deadline - Date.now()));
        await this.fetchImpl(`http://127.0.0.1:${server.port}/`, { signal: AbortSignal.timeout(probeTimeout) });
        if (server.stopped) throw server.stopReason;
        server.ready = true;
        return server;
      } catch (error) {
        if (server.stopped) throw server.stopReason || error;
        await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    }
    const error = runtimeError(504, 'whisper_server_start_timeout', `whisper-server não ficou pronto dentro do limite. ${sanitizeEngineError(server.stderr)}`.trim());
    this.#stopWhisperServer(error, server);
    throw error;
  }

  #markWhisperFailure(error) {
    this.whisperCooldownUntil = Date.now() + this.timeouts.whisperCooldown;
    this.#setEngineHealth('whisper', { warming: false, lastError: sanitizeEngineError(error?.message || error) || 'Falha no whisper-server.' });
  }

  #stopWhisperServer(reason = null, expected = null) {
    const server = expected || this.whisperServer;
    if (expected && this.whisperServer !== expected) return;
    if (this.whisperServer === server) this.whisperServer = null;
    if (!server?.child) return;
    server.ready = false;
    server.stopped = true;
    server.stopReason = reason || runtimeError(503, 'whisper_server_stopped', 'whisper-server foi encerrado.');
    try { server.child.kill('SIGTERM'); } catch { /* já encerrado */ }
  }

  async #ttsWorker(engine, { signal = null, deadline = Date.now() + this.timeouts.ttsStartup[engine] } = {}) {
    throwIfVoiceAborted(signal);
    throwIfDeadlineExpired(deadline, () => ttsTimeoutError(engine));
    const cooldownUntil = this.ttsCooldownUntil.get(engine) || 0;
    if (cooldownUntil > Date.now()) {
      throw runtimeError(503, `${engine}_worker_cooldown`, `${engine} está em recuperação após uma falha de inicialização. Tente novamente em instantes.`);
    }
    const current = this.ttsWorkers.get(engine);
    if (current) {
      try {
        await current.start({ signal, deadline });
        this.#setEngineHealth(engine, { warming: false, lastError: null });
        return current;
      } catch (error) {
        this.#discardTtsWorker(engine, error, current);
        if (!isVoiceAbort(error)) this.#markTtsFailure(engine, error);
        throw error;
      }
    }
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
    let worker;
    worker = new PersistentJsonWorker({
      command,
      args,
      env,
      engine,
      startupTimeoutMs: this.timeouts.ttsStartup[engine],
      spawnImpl: this.spawnImpl,
      onSpawn: child => this.children.add(child),
      onExit: (child, error) => {
        this.children.delete(child);
        if (this.ttsWorkers.get(engine) !== worker) return;
        this.ttsWorkers.delete(engine);
        if (!this.stopping && !isVoiceAbort(error)) this.#markTtsFailure(engine, error);
        else this.#setEngineHealth(engine, { warming: false });
      }
    });
    this.ttsWorkers.set(engine, worker);
    this.#setEngineHealth(engine, { warming: true, lastError: null });
    try {
      await worker.start({ signal, deadline });
      this.ttsCooldownUntil.delete(engine);
      this.#setEngineHealth(engine, { warming: false, lastError: null });
      return worker;
    } catch (error) {
      this.#discardTtsWorker(engine, error, worker);
      if (!isVoiceAbort(error)) this.#markTtsFailure(engine, error);
      if (error?.code) throw error;
      throw runtimeError(503, `${engine}_worker_start_failed`, `Não foi possível iniciar ${engine}: ${sanitizeEngineError(error.message)}`);
    }
  }

  #discardTtsWorker(engine, reason, expected = null) {
    const worker = expected || this.ttsWorkers.get(engine);
    if (!worker || (expected && this.ttsWorkers.get(engine) !== expected)) return;
    this.ttsWorkers.delete(engine);
    worker.close(reason);
    this.#setEngineHealth(engine, { warming: false });
  }

  #markTtsFailure(engine, error) {
    if (engine === 'kokoro') this.ttsCooldownUntil.set(engine, Date.now() + this.timeouts.kokoroCooldown);
    this.#setEngineHealth(engine, { warming: false, lastError: sanitizeEngineError(error?.message || error) || `Falha no ${engine}.` });
  }

  #run(command, args, { deadline, signal, kind, env = {} }) {
    return new Promise((resolve, reject) => {
      try {
        throwIfVoiceAborted(signal);
        throwIfDeadlineExpired(deadline, () => runtimeError(504, `${kind}_timeout`, 'O engine local excedeu o limite de tempo.'));
      } catch (error) {
        reject(error);
        return;
      }
      let child;
      try {
        child = this.spawnImpl(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
      } catch (error) {
        reject(runtimeError(503, `${kind}_spawn_failed`, `Não foi possível iniciar o engine local: ${sanitizeEngineError(error.message)}`));
        return;
      }
      this.children.add(child);
      let settled = false;
      let timedOut = false;
      let outputBytes = 0;
      let stderr = '';
      let timer = null;
      const finish = (error, keepChild = false) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        if (!keepChild) this.children.delete(child);
        if (error) reject(error); else resolve();
      };
      const onAbort = () => {
        const error = voiceAbortError(signal?.reason);
        try { child.kill('SIGTERM'); } catch { /* já encerrado */ }
        finish(error, true);
      };
      const collect = chunk => {
        outputBytes += chunk.length;
        if (outputBytes <= 2 * 1024 * 1024) stderr += chunk.toString('utf8');
        else child.kill('SIGTERM');
      };
      child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > 2 * 1024 * 1024) child.kill('SIGTERM'); });
      child.stderr.on('data', collect);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* já encerrado */ }
        finish(runtimeError(504, `${kind}_timeout`, `O engine local excedeu o limite de tempo. ${sanitizeEngineError(stderr)}`.trim()), true);
      }, Math.max(1, deadline - Date.now()));
      child.once('error', error => finish(runtimeError(503, `${kind}_spawn_failed`, `Não foi possível iniciar o engine local: ${error.message}`)));
      child.once('exit', (code, signal) => {
        if (code === 0) finish();
        else if (!settled) finish(runtimeError(timedOut ? 504 : 502, timedOut ? `${kind}_timeout` : `${kind}_failed`, timedOut ? `O engine local excedeu o limite de tempo. ${sanitizeEngineError(stderr)}`.trim() : `O engine local encerrou com código ${code}. ${sanitizeEngineError(stderr)}`));
        this.children.delete(child);
      });
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
        rapid: { model: 'models/whisper/ggml-base-q5_1.bin', downloadBytes: 59707625 },
        balanced: { model: 'models/whisper/ggml-small-q5_1.bin', downloadBytes: 190085487 },
        accurate: { model: 'models/whisper/ggml-medium-q5_0.bin', downloadBytes: 539212467 }
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
  const unavailable = { available: false, warm: false, warming: false, health: 'unavailable' };
  return {
    available: false,
    localOnly: true,
    storesRawAudio: false,
    stt: { whisper: { ...unavailable, profiles: {} } },
    tts: { kokoro: { ...unavailable }, chatterbox: { ...unavailable }, piper: { ...unavailable } },
    queue: { ttsWaiting: 0, ttsActive: false, sttActive: false }
  };
}

function whisperText(payload) {
  if (typeof payload?.text === 'string') return payload.text;
  if (Array.isArray(payload?.transcription)) return payload.transcription.map(segment => segment?.text || '').join(' ');
  return '';
}

function whisperDetail(payload, includeSegments) {
  const source = Array.isArray(payload?.segments)
    ? payload.segments
    : Array.isArray(payload?.transcription)
      ? payload.transcription
      : [];
  const segments = source.slice(0, 256).map(segment => {
    const words = Array.isArray(segment?.words) ? segment.words : [];
    const wordProbabilities = words.map(word => finiteProbability(word?.probability ?? word?.p)).filter(value => value !== null);
    const tokenProbabilities = Array.isArray(segment?.tokens)
      ? segment.tokens.map(token => finiteProbability(token?.probability ?? token?.p)).filter(value => value !== null)
      : [];
    const directConfidence = finiteProbability(segment?.confidence);
    const logProbability = finiteNumber(segment?.avg_logprob ?? segment?.avgLogprob);
    const confidence = wordProbabilities.length
      ? average(wordProbabilities)
      : tokenProbabilities.length
        ? average(tokenProbabilities)
        : directConfidence ?? (logProbability === null ? null : clamp(Math.exp(logProbability), 0, 1, 0));
    const noSpeechProbability = finiteProbability(segment?.no_speech_prob ?? segment?.noSpeechProbability);
    const start = segmentTime(segment?.start, segment?.offsets?.from);
    const end = segmentTime(segment?.end, segment?.offsets?.to);
    return {
      text: String(segment?.text || '').replace(/\s+/g, ' ').trim().slice(0, 2_000),
      ...(start !== null ? { start } : {}),
      ...(end !== null ? { end } : {}),
      ...(confidence !== null ? { confidence } : {}),
      ...(noSpeechProbability !== null ? { noSpeechProbability } : {})
    };
  });
  const wordProbabilities = source.flatMap(segment => Array.isArray(segment?.words)
    ? segment.words.map(word => finiteProbability(word?.probability ?? word?.p)).filter(value => value !== null)
    : []);
  const segmentConfidences = segments.map(segment => finiteProbability(segment.confidence)).filter(value => value !== null);
  const directConfidence = finiteProbability(payload?.confidence);
  const confidence = wordProbabilities.length ? average(wordProbabilities) : directConfidence ?? (segmentConfidences.length ? average(segmentConfidences) : null);
  const noSpeechValues = [finiteProbability(payload?.no_speech_prob ?? payload?.noSpeechProbability), ...segments.map(segment => finiteProbability(segment.noSpeechProbability))].filter(value => value !== null);
  const noSpeechProbability = noSpeechValues.length ? Math.max(...noSpeechValues) : null;
  return {
    ...(confidence !== null ? { confidence } : {}),
    ...(noSpeechProbability !== null ? { noSpeechProbability } : {}),
    ...(includeSegments ? { segments } : {})
  };
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteProbability(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, Math.min(1, number));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function segmentTime(seconds, milliseconds) {
  const direct = finiteNumber(seconds);
  if (direct !== null && direct >= 0) return direct;
  const offset = finiteNumber(milliseconds);
  return offset !== null && offset >= 0 ? offset / 1_000 : null;
}

function validateTtsText(value) {
  const text = String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) throw runtimeError(400, 'empty_tts_text', 'Informe o texto que será falado.');
  if (text.length > MAX_TTS_TEXT) throw runtimeError(413, 'tts_text_too_large', `O texto excede ${MAX_TTS_TEXT} caracteres.`);
  return text;
}

function sanitizeEngineError(value) {
  return String(value || '')
    .replace(/(?:authorization\s*[:=]\s*bearer|bearer)\s+[^\s"']+/gi, 'authorization=[oculto]')
    .replace(/\b(?:sk|hf)_[A-Za-z0-9._-]{8,}\b/g, '[segredo oculto]')
    .replace(/(?:api[_ -]?key|(?:hf_|api_)?token|password|senha)\s*[=:]\s*[^\s"']+/gi, 'credencial=[oculta]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-500);
}

function voiceMetricTitle(name) {
  return ({ 'voice.vad_start': 'Fala detectada', 'voice.vad_end': 'Fim da fala', 'voice.stt_start': 'Transcrição iniciada', 'voice.stt_empty': 'Nenhuma fala transcrita', 'voice.stt_final': 'Transcrição concluída', 'voice.chat_start': 'Turno de voz enviado', 'voice.first_text': 'Primeiro texto recebido', 'voice.tts_prepare_start': 'Preparação de áudio iniciada', 'voice.tts_retry': 'Sintetizador ocupado; nova tentativa agendada', 'voice.tts_start': 'Síntese iniciada', 'voice.first_audio': 'Primeiro áudio reproduzido', 'voice.tts_end': 'Síntese concluída', 'voice.barge_in': 'Interrupção humana', 'voice.feedback_ignored': 'Retorno acústico ignorado' })[name] || 'Métrica de voz';
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

function positiveTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function delay(ms, signal = null) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  throwIfVoiceAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish(voiceAbortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    function finish(error = null) {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    }
  });
}

function createOperationSignal(externalSignal, deadline, timeoutError) {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(voiceAbortError(externalSignal?.reason));
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError()), Math.max(1, deadline - Date.now()));
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
    }
  };
}

function waitForPromise(promise, { signal = null, deadline, timeoutError, onCancel = () => {} }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const cancel = error => {
      try { onCancel(error); } catch { /* o erro original permanece canônico */ }
      finish(error);
    };
    const onAbort = () => cancel(voiceAbortError(signal.reason));
    const timer = setTimeout(() => cancel(timeoutError()), Math.max(1, deadline - Date.now()));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
}

function throwIfVoiceAborted(signal) {
  if (signal?.aborted) throw voiceAbortError(signal.reason);
}

function throwIfDeadlineExpired(deadline, errorFactory) {
  if (!Number.isFinite(deadline) || deadline > Date.now()) return;
  throw errorFactory();
}

function voiceAbortError(reason) {
  // DOMException AbortError exposes a numeric legacy `code` (20). Preserve
  // only our structured runtime errors; normalize browser/Node abort reasons
  // to the stable contract consumed by the HTTP and UI layers.
  if (reason instanceof Error && typeof reason.code === 'string' && reason.code) return reason;
  const error = runtimeError(499, 'request_cancelled', 'Operação de voz interrompida.');
  error.category = 'cancelled';
  return error;
}

function isVoiceAbort(error) {
  return error?.code === 'request_cancelled' || error?.name === 'AbortError';
}

function isVoiceTimeout(error) {
  return typeof error?.code === 'string' && error.code.includes('timeout');
}

function ttsTimeoutError(engine, stderr = '') {
  const detail = sanitizeEngineError(stderr);
  return runtimeError(504, 'voice_tts_timeout', `A síntese ${engine} excedeu o tempo limite.${detail ? ` ${detail}` : ''}`);
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
  constructor({ command, args, engine, startupTimeoutMs, env = {}, spawnImpl = spawn, onSpawn = () => {}, onExit = () => {} }) {
    this.command = command;
    this.args = args;
    this.engine = engine;
    this.startupTimeoutMs = startupTimeoutMs;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.onSpawn = onSpawn;
    this.onExit = onExit;
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.finishStart = null;
    this.pending = new Map();
    this.counter = 0;
    this.stdout = '';
    this.stderr = '';
    this.closeReason = null;
  }

  start({ signal = null, deadline = Date.now() + this.startupTimeoutMs } = {}) {
    throwIfVoiceAborted(signal);
    throwIfDeadlineExpired(deadline, () => ttsTimeoutError(this.engine, this.stderr));
    if (this.ready) return Promise.resolve(this);
    const startPromise = this.startPromise || this.#spawn(Math.min(deadline, Date.now() + this.startupTimeoutMs));
    return waitForPromise(startPromise, {
      signal,
      deadline,
      timeoutError: () => ttsTimeoutError(this.engine, this.stderr),
      onCancel: error => this.close(error)
    });
  }

  #spawn(deadline) {
    this.stdout = '';
    this.stderr = '';
    this.closeReason = null;
    let resolveStart;
    let rejectStart;
    let startSettled = false;
    let timer = null;
    const startPromise = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    this.startPromise = startPromise;
    const finishStart = (error = null) => {
      if (startSettled) return;
      startSettled = true;
      if (timer) clearTimeout(timer);
      this.finishStart = null;
      if (error) rejectStart(error);
      else {
        this.ready = true;
        resolveStart(this);
      }
    };
    this.finishStart = finishStart;
    let child;
    try {
      child = this.spawnImpl(this.command, this.args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...this.env }
      });
    } catch (error) {
      const spawnError = runtimeError(503, `${this.engine}_worker_start_failed`, `Não foi possível iniciar ${this.engine}: ${sanitizeEngineError(error.message)}`);
      queueMicrotask(() => finishStart(spawnError));
      return startPromise;
    }
    this.child = child;
    this.onSpawn(child);
    timer = setTimeout(() => {
      const error = ttsTimeoutError(this.engine, this.stderr);
      finishStart(error);
      this.close(error);
    }, Math.max(1, deadline - Date.now()));
    child.stdout.on('data', chunk => {
      this.stdout += chunk.toString('utf8');
      if (this.stdout.length > 2 * 1024 * 1024) {
        return this.close(runtimeError(502, `${this.engine}_worker_protocol_failed`, 'O worker TTS excedeu o limite do protocolo local.'));
      }
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
        if (message.ok === true) entry.finish(null, message);
        else entry.finish(runtimeError(502, `${this.engine}_synthesis_failed`, sanitizeEngineError(message.error || 'O worker TTS falhou.')));
      }
    });
    child.stderr.on('data', chunk => { this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-8_000); });
    child.once('error', error => {
      const failure = runtimeError(503, `${this.engine}_worker_start_failed`, `Não foi possível iniciar ${this.engine}: ${sanitizeEngineError(error.message)}`);
      finishStart(failure);
      this.close(failure);
    });
    child.once('exit', (code, signal) => {
      const error = this.closeReason || runtimeError(502, `${this.engine}_worker_exited`, `Worker TTS encerrado (${signal || code}). ${sanitizeEngineError(this.stderr)}`.trim());
      finishStart(error);
      this.ready = false;
      if (this.child === child) this.child = null;
      this.startPromise = null;
      for (const entry of [...this.pending.values()]) entry.finish(error);
      this.onExit(child, error);
    });
    return startPromise;
  }

  async request(payload, { signal = null, deadline } = {}) {
    await this.start({ signal, deadline });
    throwIfVoiceAborted(signal);
    throwIfDeadlineExpired(deadline, () => ttsTimeoutError(this.engine, this.stderr));
    const child = this.child;
    if (!child?.stdin?.writable) throw runtimeError(503, `${this.engine}_worker_unavailable`, 'Worker TTS não está disponível.');
    const id = `${process.pid}-${Date.now()}-${++this.counter}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        const error = voiceAbortError(signal.reason);
        finish(error);
        this.close(error);
      };
      const timer = setTimeout(() => {
        const error = ttsTimeoutError(this.engine, this.stderr);
        finish(error);
        this.close(error);
      }, Math.max(1, deadline - Date.now()));
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        this.pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      this.pending.set(id, { finish });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, error => {
        if (!error) return;
        const failure = runtimeError(502, `${this.engine}_worker_write_failed`, `Não foi possível enviar texto ao worker TTS: ${sanitizeEngineError(error.message)}`);
        finish(failure);
        this.close(failure);
      });
    });
  }

  close(reason = null) {
    const error = reason || runtimeError(503, `${this.engine}_worker_stopped`, 'Worker TTS encerrado.');
    this.closeReason = error;
    this.finishStart?.(error);
    for (const entry of [...this.pending.values()]) entry.finish(error);
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
