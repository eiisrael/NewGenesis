import test from 'node:test';
import assert from 'node:assert/strict';
import { waveDurationSeconds, wordErrorRate } from '../scripts/voice-loopback-benchmark.mjs';

test('benchmark calcula WER normalizado sem confundir acentos e pontuação', () => {
  assert.equal(wordErrorRate('Olá, Genesis!', 'ola genesis'), 0);
  assert.equal(wordErrorRate('um dois três', 'um quatro três'), 1 / 3);
});

test('benchmark lê duração de WAV PCM sem persistir o áudio', () => {
  const audio = Buffer.alloc(44 + 32000);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVE', 8);
  audio.write('fmt ', 12); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(32000, 40);
  assert.equal(waveDurationSeconds(audio), 1);
});
