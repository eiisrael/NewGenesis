import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VoiceRuntime } from '../src/voice/voice-runtime.js';

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
  assert.throws(() => runtime.recordMetric({ name: 'voice.raw_audio' }), error => error.code === 'invalid_voice_metric');
  await runtime.flush();
  await fs.rm(root, { recursive: true, force: true });
});
