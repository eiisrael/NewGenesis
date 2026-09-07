import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { VoiceRuntime } from '../src/voice/voice-runtime.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

class FakeChild extends EventEmitter {
  constructor({ readyDelay = 0, emitReady = true, onRequest = null } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.stdin = {
      writable: true,
      write: (line, callback) => {
        callback?.();
        if (!onRequest) return true;
        const payload = JSON.parse(String(line));
        Promise.resolve(onRequest(payload, this)).catch(error => this.stderr.write(String(error?.message || error)));
        return true;
      },
      end: () => { this.stdin.writable = false; }
    };
    if (emitReady) setTimeout(() => {
      if (this.exitCode == null) this.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`);
    }, readyDelay);
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode != null) return false;
    this.exitCode = 0;
    this.stdin.writable = false;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

function ttsWave() {
  const wav = Buffer.alloc(48);
  wav.write('RIFF', 0, 'ascii');
  wav.write('WAVE', 8, 'ascii');
  return wav;
}

function speechWave() {
  const samples = 1_600;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

async function fakeVoiceData(components = []) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-voice-data-'));
  const voiceDir = path.join(dataDir, 'voice');
  await fs.mkdir(voiceDir, { recursive: true });
  const touch = async relative => {
    const target = path.join(voiceDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'fake');
  };
  if (components.includes('piper')) {
    await Promise.all([
      touch('venv-piper/Scripts/python.exe'),
      touch('models/piper/pt_BR-cadu-medium.onnx'),
      touch('models/piper/pt_BR-cadu-medium.onnx.json')
    ]);
  }
  if (components.includes('kokoro')) {
    await Promise.all([
      touch('venv-kokoro/Scripts/python.exe'), touch('models/kokoro/kokoro-v1_0.pth'), touch('models/kokoro/config.json'),
      touch('models/kokoro/voices/pf_dora.pt'), touch('models/kokoro/voices/pm_alex.pt'), touch('models/kokoro/voices/pm_santa.pt')
    ]);
  }
  if (components.includes('whisper')) {
    await Promise.all([
      touch('bin/whisper-cli.exe'), touch('bin/whisper-server.exe'), touch('models/whisper/ggml-base-q5_1.bin')
    ]);
  }
  return dataDir;
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condição de teste não foi atingida.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('runtime inicia sem engines opcionais e limpa áudio temporário órfão', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-voice-runtime-'));
  const temp = path.join(root, '.genesis', 'voice', 'tmp', 'stale');
  await fs.mkdir(temp, { recursive: true });
  await fs.writeFile(path.join(temp, 'input.wav'), 'dados temporários');
  const runtime = await new VoiceRuntime({ root, dataDir: path.join(root, '.genesis') }).init();
  const status = runtime.status();
  assert.equal(status.localOnly, true);
  assert.equal(status.storesRawAudio, false);
  assert.equal(status.stt.whisper.available, false);
  assert.equal(status.tts.chatterbox.available, false);
  await assert.rejects(fs.access(path.join(temp, 'input.wav')));
  await runtime.flush();
  await assert.rejects(fs.access(path.join(root, '.genesis', 'voice', 'tmp')));
  await fs.rm(root, { recursive: true, force: true });
});

test('manifesto não pode escapar de .genesis/voice por path traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-voice-manifest-'));
  const voice = path.join(root, '.genesis', 'voice');
  await fs.mkdir(voice, { recursive: true });
  await fs.writeFile(path.join(voice, 'voice-manifest.json'), JSON.stringify({ schemaVersion: 1, whisper: { binary: '../../fora.exe' } }));
  const runtime = new VoiceRuntime({ root, dataDir: path.join(root, '.genesis') });
  await assert.rejects(() => runtime.init(), error => error.code === 'unsafe_voice_path');
  await fs.rm(root, { recursive: true, force: true });
});

test('métricas aceitam somente marcos sem texto ou áudio', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-voice-metric-'));
  const emitted = [];
  const runtime = await new VoiceRuntime({ root, dataDir: path.join(root, '.genesis'), telemetry: { emit: event => emitted.push(event) } }).init();
  assert.deepEqual(runtime.recordMetric({ name: 'voice.vad_start', detail: { engine: 'local', transcript: 'não registrar' } }), { ok: true });
  assert.equal(emitted[0].meta.transcript, undefined);
  assert.deepEqual(runtime.recordMetric({ name: 'voice.stt_empty', detail: { engine: 'whisper' } }), { ok: true });
  assert.equal(emitted[1].title, 'Nenhuma fala transcrita');
  assert.deepEqual(runtime.recordMetric({ name: 'voice.tts_retry', detail: { engine: 'kokoro', attempt: 2, delayMs: 500, text: 'não registrar' } }), { ok: true });
  assert.equal(emitted[2].title, 'Sintetizador ocupado; nova tentativa agendada');
  assert.deepEqual(emitted[2].meta, { clientAt: null, engine: 'kokoro', attempt: 2, delayMs: 500 });
  assert.throws(() => runtime.recordMetric({ name: 'voice.raw_audio' }), error => error.code === 'invalid_voice_metric');
  await runtime.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('fila TTS serializa requisições concorrentes sem 429 e preserva a ordem', async t => {
  const dataDir = await fakeVoiceData(['piper']);
  const requests = [];
  const spawnImpl = () => new FakeChild({
    onRequest: async (payload, child) => {
      requests.push(payload.text);
      await new Promise(resolve => setTimeout(resolve, 8));
      await fs.writeFile(payload.output, ttsWave());
      child.stdout.write(`${JSON.stringify({ id: payload.id, ok: true })}\n`);
    }
  });
  const runtime = await new VoiceRuntime({ root: PROJECT_ROOT, dataDir, spawnImpl, backgroundWarmup: false }).init();
  t.after(async () => { await runtime.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });

  const results = await Promise.all([
    runtime.synthesize({ text: 'um', engine: 'piper' }),
    runtime.synthesize({ text: 'dois', engine: 'piper' }),
    runtime.synthesize({ text: 'três', engine: 'piper' })
  ]);

  assert.deepEqual(requests, ['um', 'dois', 'três']);
  assert.equal(results.every(result => result.audio.toString('ascii', 0, 4) === 'RIFF'), true);
  assert.equal(runtime.status().queue.ttsWaiting, 0);
});

test('cancelamento remove somente o item TTS aguardando e a fila continua', async t => {
  const dataDir = await fakeVoiceData(['piper']);
  const requests = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const spawnImpl = () => new FakeChild({
    onRequest: async (payload, child) => {
      requests.push(payload.text);
      if (payload.text === 'primeiro') await firstGate;
      await fs.writeFile(payload.output, ttsWave());
      child.stdout.write(`${JSON.stringify({ id: payload.id, ok: true })}\n`);
    }
  });
  const runtime = await new VoiceRuntime({ root: PROJECT_ROOT, dataDir, spawnImpl, backgroundWarmup: false }).init();
  t.after(async () => { await runtime.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });

  const first = runtime.synthesize({ text: 'primeiro', engine: 'piper' });
  await waitUntil(() => requests.length === 1);
  const controller = new AbortController();
  const cancelled = assert.rejects(
    runtime.synthesize({ text: 'cancelado', engine: 'piper' }, { signal: controller.signal }),
    error => error.code === 'request_cancelled'
  );
  const third = runtime.synthesize({ text: 'terceiro', engine: 'piper' });
  controller.abort();
  releaseFirst();

  await Promise.all([first, cancelled, third]);
  assert.deepEqual(requests, ['primeiro', 'terceiro']);
});

test('deadline TTS é absoluto entre inicialização e síntese', async t => {
  const dataDir = await fakeVoiceData(['piper']);
  const spawnImpl = () => new FakeChild({
    readyDelay: 40,
    onRequest: async (payload, child) => {
      await new Promise(resolve => setTimeout(resolve, 45));
      await fs.writeFile(payload.output, ttsWave());
      child.stdout.write(`${JSON.stringify({ id: payload.id, ok: true })}\n`);
    }
  });
  const runtime = await new VoiceRuntime({
    root: PROJECT_ROOT, dataDir, spawnImpl, backgroundWarmup: false,
    timeouts: { tts: { piper: 70 }, ttsStartup: { piper: 60 } }
  }).init();
  t.after(async () => { await runtime.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const started = performance.now();

  await assert.rejects(runtime.synthesize({ text: 'prazo único', engine: 'piper' }), error => error.code === 'voice_tts_timeout');
  assert.ok(performance.now() - started < 115, 'o runtime não deve conceder um segundo timeout completo à síntese');
});

test('Kokoro entra em cooldown após falhar frio e não reinicia em loop', async t => {
  const dataDir = await fakeVoiceData(['kokoro']);
  let spawns = 0;
  const spawnImpl = () => { spawns += 1; return new FakeChild({ emitReady: false }); };
  const runtime = await new VoiceRuntime({
    root: PROJECT_ROOT, dataDir, spawnImpl, backgroundWarmup: false,
    timeouts: { tts: { kokoro: 35 }, ttsStartup: { kokoro: 30 }, kokoroCooldown: 1_000 }
  }).init();
  t.after(async () => { await runtime.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });

  await assert.rejects(runtime.synthesize({ text: 'teste frio', engine: 'kokoro' }), error => error.code === 'voice_tts_timeout');
  const secondStarted = performance.now();
  await assert.rejects(runtime.synthesize({ text: 'não reiniciar', engine: 'kokoro' }), error => error.code === 'kokoro_worker_cooldown');

  assert.equal(spawns, 1);
  assert.ok(performance.now() - secondStarted < 50);
  assert.equal((await runtime.refreshStatus()).tts.kokoro.health, 'cooldown');
});

test('Whisper persistente retorna confiança, silêncio e segmentos sem valores nulos falsos', async t => {
  const dataDir = await fakeVoiceData(['whisper']);
  let inferenceForm = null;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith('/inference')) {
      inferenceForm = options.body;
      return new Response(JSON.stringify({
        text: 'Olá, Gênesis, tudo bem?',
        language: 'pt',
        segments: [
          { text: 'Olá, Gênesis,', start: 0, end: 0.8, no_speech_prob: 0.08, words: [{ word: 'Olá', probability: 0.8 }, { word: 'Gênesis', probability: 0.6 }] },
          { text: 'tudo bem?', start: 0.8, end: 1.4, no_speech_prob: 0.2, words: [{ word: 'tudo', probability: 0.9 }] }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('ok', { status: 200 });
  };
  const runtime = await new VoiceRuntime({
    root: PROJECT_ROOT, dataDir, fetchImpl, spawnImpl: () => new FakeChild({ emitReady: false }), backgroundWarmup: false
  }).init();
  t.after(async () => { await runtime.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });

  const result = await runtime.transcribe(speechWave(), { quality: 'rapid', segmented: true });

  assert.equal(result.text, 'Olá, Gênesis, tudo bem?');
  assert.ok(Math.abs(result.confidence - (2.3 / 3)) < 0.0001);
  assert.equal(result.noSpeechProbability, 0.2);
  assert.equal(result.segments.length, 2);
  assert.equal(inferenceForm.get('response_format'), 'verbose_json');
});

test('cancelar STT encerra a inferência ativa e libera imediatamente o próximo turno', async t => {
  const dataDir = await fakeVoiceData(['whisper']);
  let holdInference = true;
  let spawns = 0;
  let inferences = 0;
  const fetchImpl = async (url, options = {}) => {
    if (!String(url).endsWith('/inference')) return new Response('ok', { status: 200 });
    inferences += 1;
    if (!holdInference) return new Response(JSON.stringify({ text: 'segunda fala', segments: [] }), { status: 200 });
    return new Promise((_resolve, reject) => {
      const rejectAbort = () => reject(options.signal?.reason || new DOMException('Abortado', 'AbortError'));
      options.signal?.addEventListener('abort', rejectAbort, { once: true });
      if (options.signal?.aborted) rejectAbort();
    });
  };
  const runtime = await new VoiceRuntime({
    root: PROJECT_ROOT, dataDir, fetchImpl,
    spawnImpl: () => { spawns += 1; return new FakeChild({ emitReady: false }); },
    backgroundWarmup: false
  }).init();
  t.after(async () => { await runtime.flush(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const controller = new AbortController();
  const first = runtime.transcribe(speechWave(), { quality: 'rapid', signal: controller.signal });
  await waitUntil(() => inferences === 1);
  controller.abort();
  await assert.rejects(first, error => error.code === 'request_cancelled');

  holdInference = false;
  const second = await runtime.transcribe(speechWave(), { quality: 'rapid' });
  assert.equal(second.text, 'segunda fala');
  assert.ok(spawns >= 2);
});
