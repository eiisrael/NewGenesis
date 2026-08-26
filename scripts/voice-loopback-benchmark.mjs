import os from 'node:os';
import path from 'node:path';

const DEFAULT_SENTENCES = Object.freeze([
  'Bom dia. O que você gostaria de fazer hoje?',
  'Encontrei três possíveis causas para esse problema. Posso verificar uma por uma com você.',
  'Consegui terminar a análise. Há duas coisas importantes que precisamos corrigir.'
]);

export function wordErrorRate(reference, hypothesis) {
  const expected = words(reference);
  const actual = words(hypothesis);
  if (!expected.length) return actual.length ? 1 : 0;
  const row = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let expectedIndex = 1; expectedIndex <= expected.length; expectedIndex += 1) {
    let diagonal = row[0];
    row[0] = expectedIndex;
    for (let actualIndex = 1; actualIndex <= actual.length; actualIndex += 1) {
      const above = row[actualIndex];
      row[actualIndex] = Math.min(
        row[actualIndex] + 1,
        row[actualIndex - 1] + 1,
        diagonal + (expected[expectedIndex - 1] === actual[actualIndex - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return row[actual.length] / expected.length;
}

export function waveDurationSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) return null;
    if (id === 'fmt ' && size >= 16) byteRate = buffer.readUInt32LE(start + 8);
    if (id === 'data') dataBytes += size;
    offset = start + size + (size % 2);
  }
  return byteRate && dataBytes ? dataBytes / byteRate : null;
}

async function runSentence(baseUrl, text) {
  const headers = { 'x-genesis-client': 'web' };
  const ttsStarted = performance.now();
  const ttsResponse = await fetch(`${baseUrl}/api/voice/synthesize`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ text, engine: 'piper', preset: 'natural', rate: 1 })
  });
  if (!ttsResponse.ok) throw new Error(`Piper falhou (${ttsResponse.status}): ${await ttsResponse.text()}`);
  const audio = Buffer.from(await ttsResponse.arrayBuffer());
  const ttsRoundTripMs = Math.round(performance.now() - ttsStarted);
  const audioSeconds = waveDurationSeconds(audio);

  const sttStarted = performance.now();
  const sttResponse = await fetch(`${baseUrl}/api/voice/transcribe?quality=balanced`, {
    method: 'POST', headers: { ...headers, 'content-type': 'audio/wav' }, body: audio
  });
  if (!sttResponse.ok) throw new Error(`Whisper falhou (${sttResponse.status}): ${await sttResponse.text()}`);
  const stt = await sttResponse.json();
  const sttRoundTripMs = Math.round(performance.now() - sttStarted);
  return {
    reference: text,
    transcript: stt.text,
    wordErrorRate: Number(wordErrorRate(text, stt.text).toFixed(4)),
    audioSeconds: audioSeconds == null ? null : Number(audioSeconds.toFixed(3)),
    audioBytes: audio.length,
    ttsEngineMs: Number(ttsResponse.headers.get('x-genesis-voice-latency-ms')) || null,
    ttsRoundTripMs,
    sttEngineMs: Number(stt.latencyMs) || null,
    sttRoundTripMs,
    sttRealTimeFactor: audioSeconds ? Number((sttRoundTripMs / 1000 / audioSeconds).toFixed(3)) : null
  };
}

async function main() {
  const baseUrl = String(process.argv[2] || 'http://127.0.0.1:7331').replace(/\/$/, '');
  const statusResponse = await fetch(`${baseUrl}/api/voice/status`);
  if (!statusResponse.ok) throw new Error(`NewGenesis não respondeu em ${baseUrl}.`);
  const status = await statusResponse.json();
  if (!status.stt?.whisper?.available || !status.tts?.piper?.available) throw new Error('O benchmark requer Whisper e Piper locais instalados.');
  const results = [];
  for (const sentence of DEFAULT_SENTENCES) results.push(await runSentence(baseUrl, sentence));
  process.stdout.write(`${JSON.stringify({
    kind: 'synthetic-loopback',
    warning: 'Áudio gerado pelo Piper; isto não mede microfone, ruído, sotaque humano ou qualidade perceptual.',
    collectedAt: new Date().toISOString(),
    hardware: { platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model || 'desconhecida', logicalProcessors: os.cpus().length, totalRamBytes: os.totalmem() },
    engines: { stt: 'whisper.cpp 1.8.6 / small-q5_1 / Silero VAD 6.2', tts: 'Piper 1.4.2 / pt_BR-cadu-medium' },
    results
  }, null, 2)}\n`);
}

function words(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR').match(/[a-z0-9]+/g) || [];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
