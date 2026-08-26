import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveVoiceActivityDetector, encodePcm16Wav, resampleLinear } from '../public/voice/audio-input.js';
import { normalizeSpokenText, similarityToPlayback, takeStableSentences } from '../public/voice/speech-normalizer.js';
import { inspectWave } from '../src/voice/voice-runtime.js';

test('normalização altera somente a cópia falada e omite estruturas ruidosas', () => {
  const original = '# Resultado\n**Olá** [documentação](https://example.test/uma/url/enorme) 😀\n```js\nconsole.log("segredo")\n```';
  const spoken = normalizeSpokenText(original);
  assert.equal(original.includes('console.log'), true);
  assert.match(spoken, /Olá documentação/);
  assert.match(spoken, /Há um bloco de código/);
  assert.doesNotMatch(spoken, /https|console\.log|😀/);
});

test('sentence chunking aguarda fronteira estável e preserva resto', () => {
  const first = takeStableSentences('Primeira frase. Segunda ainda');
  assert.deepEqual(first.chunks, ['Primeira frase.']);
  assert.equal(first.rest, 'Segunda ainda');
  const final = takeStableSentences(first.rest, { flush: true });
  assert.deepEqual(final.chunks, ['Segunda ainda']);
});

test('similaridade identifica provável retorno acústico', () => {
  assert.ok(similarityToPlayback('Genesis encontrou três causas possíveis', 'O Genesis encontrou três causas possíveis para o problema.') > 0.7);
  assert.ok(similarityToPlayback('quero fazer outra pergunta', 'O Genesis encontrou três causas possíveis.') < 0.3);
});

test('VAD adaptativo detecta começo, silêncio final e usa limiar maior no barge-in', () => {
  const vad = new AdaptiveVoiceActivityDetector({ threshold: 0.02, startFrames: 3, bargeInFrames: 5, silenceMs: 600, minSpeechMs: 200 });
  assert.equal(vad.pushLevel(0.03, 0), null);
  assert.equal(vad.pushLevel(0.03, 20), null);
  assert.equal(vad.pushLevel(0.03, 40)?.type, 'start');
  assert.equal(vad.pushLevel(0.001, 400), null);
  assert.equal(vad.pushLevel(0.001, 1050)?.type, 'end');
  vad.reset();
  for (let index = 0; index < 4; index += 1) assert.equal(vad.pushLevel(0.05, index * 20, { playbackActive: true }), null);
  assert.equal(vad.pushLevel(0.05, 80, { playbackActive: true })?.type, 'start');
});

test('captura produz WAV PCM mono 16 kHz aceito pelo runtime', () => {
  const source = new Float32Array(4800).map((_, index) => Math.sin(index / 12) * 0.2);
  const wav = Buffer.from(encodePcm16Wav(source, 48000, 16000));
  const inspected = inspectWave(wav);
  assert.equal(inspected.sampleRate, 16000);
  assert.equal(inspected.channels, 1);
  assert.equal(inspected.bitsPerSample, 16);
  assert.ok(inspected.durationSeconds > 0.09 && inspected.durationSeconds < 0.11);
  assert.equal(resampleLinear(source, 48000, 16000).length, 1600);
});

test('runtime rejeita áudio malformado, estéreo e acima de 45 segundos', () => {
  assert.throws(() => inspectWave(Buffer.from('não é wav')), error => error.code === 'invalid_voice_audio');
  const long = Buffer.from(encodePcm16Wav(new Float32Array(16000 * 46), 16000, 16000));
  assert.throws(() => inspectWave(long), error => error.code === 'voice_audio_too_long');
});
