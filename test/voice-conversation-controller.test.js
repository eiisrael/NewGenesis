import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioPlaybackController } from '../public/voice/audio-playback.js';
import { VoiceConversationController } from '../public/voice/conversation-controller.js';

class FakeInput {
  available = true;
  starts = [];
  stopped = 0;
  async start(options) { this.starts.push(options); options.onStart?.(); }
  stop() { this.stopped += 1; }
  close() {}
  current() { return this.starts.at(-1); }
}

class FakeTts {
  constructor({ fail = false, deferred = false } = {}) { this.available = true; this.fail = fail; this.deferred = deferred; this.spoken = []; this.cancelled = 0; }
  speak(text, options) {
    this.spoken.push(text);
    options.onFirstAudio?.();
    if (this.fail) return Promise.reject(new Error('engine falhou'));
    if (!this.deferred) return Promise.resolve();
    return new Promise(resolve => { this.resolve = resolve; });
  }
  cancel() { this.cancelled += 1; this.resolve?.(); }
}

function tick() { return new Promise(resolve => setImmediate(resolve)); }

function settings(overrides = {}) {
  return { conversationMode: true, autoSpeak: true, autoSend: true, preferLocal: false, sttEngine: 'auto', ttsEngine: 'auto', quality: 'balanced', preset: 'natural', rate: 1, vadThreshold: 0.018, vadSilenceMs: 700, ...overrides };
}

test('modo mãos-livres envia, fala por sentença e volta a ouvir', async () => {
  const input = new FakeInput();
  const tts = new FakeTts();
  const playback = new AudioPlaybackController({ browser: tts });
  const submitted = [];
  const controller = new VoiceConversationController({ settings: settings(), inputEngines: { local: { available: false }, browser: input }, playback, submitTranscript: value => submitted.push(value) });
  await controller.startConversation();
  input.current().onSpeechStart({ engine: 'browser' });
  input.current().onTranscribing({ engine: 'browser' });
  input.current().onFinal('explique o SupremeMind', { engine: 'browser' });
  input.current().onEnd({ engine: 'browser', transcript: 'explique o SupremeMind' });
  assert.deepEqual(submitted, ['explique o SupremeMind']);
  assert.equal(controller.machine.current, 'THINKING');
  controller.onChatStart();
  controller.onChatDelta('O SupremeMind organiza contexto. ');
  await tick();
  assert.deepEqual(tts.spoken, ['O SupremeMind organiza contexto.']);
  controller.onChatEnd();
  await tick();
  assert.equal(controller.machine.current, 'LISTENING');
  assert.ok(input.starts.length >= 2);
});

test('barge-in cancela TTS pendente antes de aceitar nova pergunta', async () => {
  const input = new FakeInput();
  const tts = new FakeTts({ deferred: true });
  const playback = new AudioPlaybackController({ browser: tts });
  const submitted = [];
  const controller = new VoiceConversationController({ settings: settings(), inputEngines: { local: { available: false }, browser: input }, playback, submitTranscript: value => submitted.push(value) });
  controller.onChatStart();
  controller.onChatDelta('Esta resposta está sendo falada. ');
  await tick();
  assert.equal(controller.machine.current, 'SPEAKING');
  const monitor = input.current();
  assert.equal(monitor.playbackActive, true);
  monitor.onSpeechStart({ engine: 'browser' });
  assert.equal(controller.machine.current, 'SPEECH_DETECTED');
  assert.ok(tts.cancelled >= 1);
  monitor.onTranscribing({ engine: 'browser' });
  monitor.onFinal('nova pergunta agora', { engine: 'browser' });
  assert.deepEqual(submitted, ['nova pergunta agora']);
  assert.equal(controller.machine.current, 'THINKING');
});

test('fila cai para speechSynthesis quando engine local falha e política permite', async () => {
  const local = new FakeTts({ fail: true });
  const browser = new FakeTts();
  const fallbacks = [];
  const playback = new AudioPlaybackController({ chatterbox: local, browser, onFallback: detail => fallbacks.push(detail) });
  playback.enqueue('Resposta curta.', settings({ ttsEngine: 'chatterbox' }));
  await tick();
  assert.equal(local.spoken.length, 1);
  assert.deepEqual(browser.spoken, ['Resposta curta.']);
  assert.equal(fallbacks.length, 1);
});

test('preferência 100% local impede fallback silencioso de STT', async () => {
  const browser = new FakeInput();
  const playback = new AudioPlaybackController({ browser: new FakeTts() });
  const errors = [];
  const controller = new VoiceConversationController({ settings: settings({ preferLocal: true }), inputEngines: { local: { available: false }, browser }, playback, onStatus: (status, error) => { if (status === 'error') errors.push(error); } });
  await assert.rejects(() => controller.startConversation(), error => error.code === 'stt_unavailable');
  assert.equal(browser.starts.length, 0);
  assert.equal(controller.machine.current, 'ERROR');
  assert.equal(errors.length, 1);
});
