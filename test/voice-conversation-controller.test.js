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

class PreparedTts {
  available = true;
  prepared = [];
  played = [];
  resolvers = [];
  prepare(text) { this.prepared.push(text); return Promise.resolve({ text }); }
  play(value, options) {
    this.played.push(value.text);
    options.onFirstAudio?.();
    return new Promise(resolve => this.resolvers.push(resolve));
  }
  finish() { this.resolvers.shift()?.(); }
  cancel() { while (this.resolvers.length) this.finish(); }
}

function tick() { return new Promise(resolve => setImmediate(resolve)); }

function settings(overrides = {}) {
  return { conversationMode: true, autoSpeak: true, autoSend: true, preferLocal: false, sttEngine: 'auto', ttsEngine: 'auto', quality: 'balanced', preset: 'natural', rate: 1, vadThreshold: 0.018, vadSilenceMs: 700, ...overrides };
}

test('modo mãos-livres envia, fala por sentença e volta a ouvir', async () => {
  const input = new FakeInput();
  const tts = new FakeTts();
  const playback = new AudioPlaybackController({ piper: tts });
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
  const playback = new AudioPlaybackController({ piper: tts });
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

test('fila cai somente para outro engine local quando o selecionado falha', async () => {
  const local = new FakeTts({ fail: true });
  const piper = new FakeTts();
  const fallbacks = [];
  const playback = new AudioPlaybackController({ chatterbox: local, piper, onFallback: detail => fallbacks.push(detail) });
  playback.enqueue('Resposta curta.', settings({ ttsEngine: 'chatterbox' }));
  await tick();
  assert.equal(local.spoken.length, 1);
  assert.deepEqual(piper.spoken, ['Resposta curta.']);
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].to, 'piper');
});

test('falha da saída de áudio não tenta outro sintetizador no mesmo dispositivo', async () => {
  const outputError = new Error('saída ausente');
  outputError.code = 'audio_output_not_found';
  const kokoro = new FakeTts();
  kokoro.speak = () => Promise.reject(outputError);
  const piper = new FakeTts();
  const errors = [];
  const fallbacks = [];
  const playback = new AudioPlaybackController({
    kokoro,
    piper,
    onError: error => errors.push(error),
    onFallback: detail => fallbacks.push(detail)
  });

  playback.enqueue('Resposta curta.', settings());
  await tick();
  assert.deepEqual(piper.spoken, []);
  assert.deepEqual(fallbacks, []);
  assert.equal(errors[0], outputError);
});

test('preferência 100% local impede fallback silencioso de STT', async () => {
  const browser = new FakeInput();
  const playback = new AudioPlaybackController({ piper: new FakeTts() });
  const errors = [];
  const controller = new VoiceConversationController({ settings: settings({ preferLocal: true }), inputEngines: { local: { available: false }, browser }, playback, onStatus: (status, error) => { if (status === 'error') errors.push(error); } });
  await assert.rejects(() => controller.startConversation(), error => error.code === 'stt_unavailable');
  assert.equal(browser.starts.length, 0);
  assert.equal(controller.machine.current, 'ERROR');
  assert.equal(errors.length, 1);
});

test('fila prepara no máximo o próximo trecho enquanto o atual toca', async () => {
  const tts = new PreparedTts();
  const playback = new AudioPlaybackController({ kokoro: tts });
  playback.enqueue('Primeiro trecho.', settings());
  await tick();
  playback.enqueue('Segundo trecho.', settings());
  playback.enqueue('Terceiro trecho.', settings());
  await tick();

  assert.deepEqual(tts.played, ['Primeiro trecho.']);
  assert.deepEqual(tts.prepared, ['Primeiro trecho.', 'Segundo trecho.']);
  tts.finish();
  await tick();
  assert.deepEqual(tts.played, ['Primeiro trecho.', 'Segundo trecho.']);
  assert.deepEqual(tts.prepared, ['Primeiro trecho.', 'Segundo trecho.', 'Terceiro trecho.']);
  tts.finish();
  await tick();
  tts.finish();
  await tick();
});

test('transcrição vazia é recuperável no modo conversa e volta a ouvir', async () => {
  const input = new FakeInput();
  const playback = new AudioPlaybackController({ piper: new FakeTts() });
  const statuses = [];
  const metrics = [];
  const controller = new VoiceConversationController({
    settings: settings(),
    inputEngines: { local: { available: false }, browser: input },
    playback,
    onStatus: status => statuses.push(status),
    onMetric: metric => metrics.push(metric)
  });

  await controller.startConversation();
  input.current().onSpeechStart({ engine: 'browser' });
  input.current().onTranscribing({ engine: 'browser' });
  input.current().onEnd({ engine: 'browser', transcript: '' });
  await tick();

  assert.equal(controller.machine.current, 'LISTENING');
  assert.equal(input.starts.length, 2);
  assert.ok(statuses.includes('no-speech'));
  assert.ok(metrics.some(metric => metric.name === 'voice.stt_empty'));
});

test('push-to-talk vazio permanece armado por uma janela e pode ser desligado pelo usuário', async () => {
  const input = new FakeInput();
  const playback = new AudioPlaybackController({ piper: new FakeTts() });
  const submitted = [];
  const controller = new VoiceConversationController({
    settings: settings({ conversationMode: false }),
    inputEngines: { local: { available: false }, browser: input },
    playback,
    submitTranscript: transcript => submitted.push(transcript)
  });

  await controller.togglePushToTalk();
  input.current().onSpeechStart({ engine: 'browser' });
  input.current().onTranscribing({ engine: 'browser' });
  input.current().onEnd({ engine: 'browser', transcript: '' });
  await new Promise(resolve => setTimeout(resolve, 300));

  assert.equal(controller.machine.current, 'LISTENING');
  assert.equal(input.starts.length, 2);
  assert.deepEqual(submitted, []);
  await controller.togglePushToTalk();
  assert.equal(controller.machine.current, 'IDLE');
});

test('teste manual de TTS não tenta reabrir o microfone do modo conversa', async () => {
  const input = new FakeInput();
  const playback = new AudioPlaybackController({ kokoro: new FakeTts() });
  const controller = new VoiceConversationController({
    settings: settings(), inputEngines: { local: { available: false }, browser: input }, playback
  });
  controller.speakText('Teste local de voz.');
  await tick();
  assert.equal(controller.machine.current, 'IDLE');
  assert.equal(input.starts.length, 0);
});

test('cliques repetidos no teste de voz não criam sínteses concorrentes', async () => {
  const input = new FakeInput();
  const tts = new FakeTts({ deferred: true });
  const statuses = [];
  const playback = new AudioPlaybackController({ kokoro: tts });
  const controller = new VoiceConversationController({
    settings: settings({ conversationMode: false }),
    inputEngines: { local: { available: false }, browser: input },
    playback,
    onStatus: status => statuses.push(status)
  });

  assert.equal(controller.speakText('Teste local.'), true);
  assert.equal(controller.speakText('Teste local.'), false);
  await tick();
  assert.deepEqual(tts.spoken, ['Teste local.']);
  assert.ok(statuses.includes('tts-busy'));
  controller.stopAll('test-complete');
});

test('teste de microfone confirma a transcrição sem enviar mensagem ao chat', async () => {
  const input = new FakeInput();
  const submitted = [];
  const statuses = [];
  const playback = new AudioPlaybackController({ piper: new FakeTts() });
  const controller = new VoiceConversationController({
    settings: settings({ conversationMode: false }),
    inputEngines: { local: { available: false }, browser: input },
    playback,
    submitTranscript: transcript => submitted.push(transcript),
    onStatus: (status, detail) => statuses.push({ status, detail })
  });

  await controller.testMicrophone();
  input.current().onSpeechStart({ engine: 'browser' });
  input.current().onTranscribing({ engine: 'browser' });
  input.current().onFinal('Genesis está me ouvindo?', { engine: 'browser' });
  input.current().onEnd({ engine: 'browser', transcript: 'Genesis está me ouvindo?' });

  assert.deepEqual(submitted, []);
  assert.equal(controller.machine.current, 'IDLE');
  assert.equal(statuses.at(-1).status, 'microphone-ok');
  assert.equal(statuses.at(-1).detail.transcript, 'Genesis está me ouvindo?');
});
