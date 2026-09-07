import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHandler } from '../src/server.js';

const ROOT = path.resolve(import.meta.dirname, '..');

async function serve(voiceRuntime) {
  const handler = createHandler({
    config: { root: ROOT, version: 'test' },
    orchestrator: { provider: () => null },
    telemetry: { emit() {} },
    approvalManager: { cancelConversation() {} },
    voiceRuntime
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

test('HTTP de voz propaga perfil rápido, segmentação e signal sem abortar resposta concluída', async t => {
  const calls = [];
  const voiceRuntime = {
    transcribe: async (_audio, options) => {
      calls.push(options);
      return { text: 'fala fiel', profile: options.quality, segments: [] };
    }
  };
  const { server, port } = await serve(voiceRuntime);
  t.after(() => closeServer(server));

  const response = await fetch(`http://127.0.0.1:${port}/api/voice/transcribe?segmented=1`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav', 'x-genesis-client': 'web' },
    body: Buffer.from('wav de teste')
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.text, 'fala fiel');
  assert.equal(calls[0].quality, 'rapid');
  assert.equal(calls[0].segmented, true);
  assert.equal(calls[0].signal.aborted, false);
});

test('desconexão HTTP aborta imediatamente a transcrição no runtime', async t => {
  let receivedSignal = null;
  let signalAborted;
  const aborted = new Promise(resolve => { signalAborted = resolve; });
  const voiceRuntime = {
    transcribe: (_audio, options) => {
      receivedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          signalAborted();
          reject(options.signal.reason);
        }, { once: true });
      });
    }
  };
  const { server, port } = await serve(voiceRuntime);
  t.after(() => closeServer(server));

  const request = http.request({
    hostname: '127.0.0.1', port, path: '/api/voice/transcribe?quality=rapid', method: 'POST',
    headers: { 'content-type': 'audio/wav', 'content-length': 3, 'x-genesis-client': 'web' }
  });
  request.on('error', () => {});
  request.end('wav');
  while (!receivedSignal) await new Promise(resolve => setTimeout(resolve, 5));
  request.destroy();
  await Promise.race([aborted, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('signal não abortado')), 1_000))]);

  assert.equal(receivedSignal.aborted, true);
  assert.equal(receivedSignal.reason.code, 'request_cancelled');
});

test('HTTP de síntese passa signal e devolve WAV com metadados canônicos', async t => {
  let receivedSignal = null;
  const voiceRuntime = {
    synthesize: async (body, options) => {
      receivedSignal = options.signal;
      assert.equal(body.text, 'Olá');
      return { audio: Buffer.from('RIFFfake-wave'), engine: 'piper', processMode: 'persistent-worker', latencyMs: 12 };
    }
  };
  const { server, port } = await serve(voiceRuntime);
  t.after(() => closeServer(server));

  const response = await fetch(`http://127.0.0.1:${port}/api/voice/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-genesis-client': 'web' },
    body: JSON.stringify({ text: 'Olá', engine: 'piper' })
  });
  const audio = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-genesis-voice-engine'), 'piper');
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(receivedSignal.aborted, false);
});
