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

class DeferredPrepareTts {
  available = true;
  prepared = [];
  played = [];
  preparing = 0;
  maxPreparing = 0;
  resolvers = [];
  prepare(text) {
    this.prepared.push(text);
    this.preparing += 1;
    this.maxPreparing = Math.max(this.maxPreparing, this.preparing);
    return new Promise(resolve => {
      this.resolvers.push(() => {
        this.preparing -= 1;
        resolve({ text });
      });
    });
  }
  async play(value, options) {
    this.played.push(value.text);
    options.onFirstAudio?.();
  }
  finishPrepare() { this.resolvers.shift()?.(); }
  cancel() { while (this.resolvers.length) this.finishPrepare(); }
}

class GenerationDeferredTts {
  available = true;
  prepared = [];
  resolvers = new Map();
  prepare(text) {
    this.prepared.push(text);
    return new Promise(resolve => this.resolvers.set(text, () => resolve({ text })));
  }
  async play(value, options) { options.onFirstAudio?.(); this.played = [...(this.played || []), value.text]; }
  resolve(text) { this.resolvers.get(text)?.(); this.resolvers.delete(text); }
  cancel() {}
}

class ControlledFirstAudioTts {
  available = true;
  prepareStarted = false;
  playStarted = false;
  resolvePrepare = null;
  resolvePlay = null;
  firstAudio = null;
  prepare(text) {
    this.prepareStarted = true;
    return new Promise(resolve => { this.resolvePrepare = () => resolve({ text }); });
  }
  play(_value, options) {
    this.playStarted = true;
    this.firstAudio = options.onFirstAudio;
    return new Promise(resolve => { this.resolvePlay = resolve; });
  }
  emitFirstAudio() { this.firstAudio?.(); }
  finish() { this.resolvePlay?.(); }
  cancel() { this.resolvePrepare?.(); this.finish(); }
}

class SecondPrepareDeferredTts {
  available = true;
  prepared = [];
  played = [];
  playResolvers = [];
  secondPrepare = null;
  prepare(text) {
    this.prepared.push(text);
    if (this.prepared.length === 1) return Promise.resolve({ text });
    return new Promise(resolve => { this.secondPrepare = () => resolve({ text }); });
  }
  play(value, options) {
    this.played.push(value.text);
    options.onFirstAudio?.();
    return new Promise(resolve => this.playResolvers.push(resolve));
  }
  finishPlay() { this.playResolvers.shift()?.(); }
  finishSecondPrepare() { this.secondPrepare?.(); this.secondPrepare = null; }
  cancel() { this.finishSecondPrepare(); while (this.playResolvers.length) this.finishPlay(); }
}

class BusyPreparedTts {
  available = true;
  attempts = 0;
  played = [];
  async prepare(text) {
    this.attempts += 1;
    if (this.attempts <= 2) {
      const error = new Error('sintetizador ocupado');
      error.code = 'voice_tts_busy';
      throw error;
    }
    return { text };
  }
  async play(value, options) {
    this.played.push(value.text);
    options.onFirstAudio?.();
  }
  cancel() {}
}

class FailOncePreparedTts {
  available = true;
  attempts = 0;
  prepared = [];
  played = [];
  async prepare(text) {
    this.attempts += 1;
    this.prepared.push(text);
    if (this.attempts === 1) {
      const error = new Error('saída indisponível');
      error.code = 'audio_output_not_found';
      throw error;
    }
    return { text };
  }
  async play(value) { this.played.push(value.text); }
  cancel() {}
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

  playback.enqueue('Resposta curta.', settings({ ttsEngine: 'kokoro' }));
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

test('fila não inicia outro prepare enquanto o primeiro trecho ainda está sendo preparado', async t => {
  const tts = new DeferredPrepareTts();
  const playback = new AudioPlaybackController({ kokoro: tts });
  t.after(() => playback.cancel('test-cleanup'));

  playback.enqueue('Primeiro trecho frio.', settings());
  playback.enqueue('Segundo trecho da mesma resposta.', settings());
  await tick();

  assert.deepEqual(tts.prepared, ['Primeiro trecho frio.']);
  assert.equal(tts.maxPreparing, 1);

  tts.finishPrepare();
  await tick();
  assert.deepEqual(tts.prepared, ['Primeiro trecho frio.', 'Segundo trecho da mesma resposta.']);
  assert.equal(tts.maxPreparing, 1);

  tts.finishPrepare();
  await tick();
  assert.deepEqual(tts.played, ['Primeiro trecho frio.', 'Segundo trecho da mesma resposta.']);
});

test('prepare antigo cancelado não libera a trava da nova geração', async t => {
  const tts = new GenerationDeferredTts();
  const playback = new AudioPlaybackController({ kokoro: tts });
  t.after(() => playback.cancel('test-cleanup'));

  playback.enqueue('Trecho antigo.', settings());
  playback.cancel('novo-turno');
  playback.enqueue('Primeiro trecho novo.', settings());
  tts.resolve('Trecho antigo.');
  await tick();
  playback.enqueue('Segundo trecho novo.', settings());
  await tick();

  assert.deepEqual(tts.prepared, ['Trecho antigo.', 'Primeiro trecho novo.']);
  tts.resolve('Primeiro trecho novo.');
  await tick();
  assert.deepEqual(tts.prepared, ['Trecho antigo.', 'Primeiro trecho novo.', 'Segundo trecho novo.']);
  tts.resolve('Segundo trecho novo.');
  await tick();
});

test('estado SPEAKING começa somente quando o primeiro áudio realmente inicia', async t => {
  const input = new FakeInput();
  const tts = new ControlledFirstAudioTts();
  const playback = new AudioPlaybackController({ kokoro: tts });
  const controller = new VoiceConversationController({
    settings: settings(), inputEngines: { local: { available: false }, browser: input }, playback
  });
  t.after(() => controller.stopAll('test-cleanup'));

  controller.onChatStart();
  controller.onChatDelta('Resposta ainda em preparação. ');
  assert.equal(tts.prepareStarted, true);
  assert.notEqual(controller.machine.current, 'SPEAKING');

  tts.resolvePrepare();
  await tick();
  assert.equal(tts.playStarted, true);
  assert.notEqual(controller.machine.current, 'SPEAKING');

  tts.emitFirstAudio();
  assert.equal(controller.machine.current, 'SPEAKING');

  controller.onChatEnd();
  tts.finish();
  await tick();
  controller.stopAll('test-complete');
});

test('preparar próximo trecho durante reprodução mantém o estado SPEAKING', async t => {
  const input = new FakeInput();
  const tts = new PreparedTts();
  const playback = new AudioPlaybackController({ kokoro: tts });
  const controller = new VoiceConversationController({
    settings: settings(), inputEngines: { local: { available: false }, browser: input }, playback
  });
  t.after(() => controller.stopAll('test-cleanup'));

  controller.onChatStart();
  controller.onChatDelta('Primeiro trecho já audível. ');
  await tick();
  assert.equal(controller.machine.current, 'SPEAKING');

  controller.onChatDelta('Segundo trecho recebido pelo streaming. ');
  await tick();
  assert.equal(controller.machine.current, 'SPEAKING');
  assert.deepEqual(tts.prepared, ['Primeiro trecho já audível.', 'Segundo trecho recebido pelo streaming.']);

  controller.onChatEnd();
  tts.finish();
  await tick();
  tts.finish();
  await tick();
});

test('intervalo real entre trechos deixa de ser anunciado como fala', async t => {
  const input = new FakeInput();
  const tts = new SecondPrepareDeferredTts();
  const playback = new AudioPlaybackController({ kokoro: tts });
  const controller = new VoiceConversationController({
    settings: settings(), inputEngines: { local: { available: false }, browser: input }, playback
  });
  t.after(() => controller.stopAll('test-cleanup'));

  controller.onChatStart();
  controller.onChatDelta('Primeiro trecho audível. ');
  await tick();
  controller.onChatDelta('Segundo trecho ainda sintetizando. ');
  controller.onChatEnd();
  await tick();
  assert.equal(controller.machine.current, 'SPEAKING');

  tts.finishPlay();
  await tick();
  assert.equal(controller.machine.current, 'PREPARING');

  tts.finishSecondPrepare();
  await tick();
  assert.equal(controller.machine.current, 'SPEAKING');
  tts.finishPlay();
  await tick();
});

test('novo chat limpa o modo manual e volta a permitir barge-in', async t => {
  const input = new FakeInput();
  const tts = new FakeTts({ deferred: true });
  const playback = new AudioPlaybackController({ piper: tts });
  const controller = new VoiceConversationController({
    settings: settings(), inputEngines: { local: { available: false }, browser: input }, playback
  });
  t.after(() => controller.stopAll('test-cleanup'));

  controller.speakText('Teste manual anterior.');
  await tick();
  assert.equal(controller.manualSpeech, true);
  controller.onChatStart();
  controller.onChatDelta('Resposta nova em voz. ');
  await tick();

  assert.equal(controller.manualSpeech, false);
  assert.equal(input.current()?.playbackActive, true);
});

test('métricas nulas de backend antigo não bloqueiam uma transcrição válida', async () => {
  const input = new FakeInput();
  const playback = new AudioPlaybackController({ piper: new FakeTts() });
  const submitted = [];
  const controller = new VoiceConversationController({
    settings: settings({ autoSpeak: false }), inputEngines: { local: { available: false }, browser: input }, playback,
    submitTranscript: text => submitted.push(text)
  });

  await controller.startConversation();
  input.current().onSpeechStart({ engine: 'browser' });
  input.current().onTranscribing({ engine: 'browser' });
  input.current().onFinal('mensagem perfeitamente válida', { engine: 'browser', confidence: null, noSpeechProbability: null, rms: null });

  assert.deepEqual(submitted, ['mensagem perfeitamente válida']);
});

test('sintetizador ocupado é aguardado sem perder ou reordenar o trecho', async () => {
  const tts = new BusyPreparedTts();
  const retries = [];
  const errors = [];
  const playback = new AudioPlaybackController({
    kokoro: tts,
    busyRetryDelays: [0, 0],
    onRetry: detail => retries.push(detail),
    onError: error => errors.push(error)
  });

  playback.enqueue('Trecho preservado.', settings());
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(tts.attempts, 3);
  assert.deepEqual(tts.played, ['Trecho preservado.']);
  assert.equal(retries.length, 2);
  assert.deepEqual(errors, []);
});

test('falha terminal descarta a sobra antiga antes de aceitar um novo turno', async () => {
  const tts = new FailOncePreparedTts();
  const errors = [];
  const playback = new AudioPlaybackController({ kokoro: tts, onError: error => errors.push(error) });

  playback.enqueue('Primeiro trecho antigo.', settings());
  playback.enqueue('Sobra que não pode vazar.', settings());
  await tick();
  playback.enqueue('Resposta do turno novo.', settings());
  await tick();

  assert.equal(errors.length, 1);
  assert.deepEqual(tts.played, ['Resposta do turno novo.']);
  assert.equal(playback.queue.length, 0);
});

test('início de chat cancela áudio preparado da resposta anterior', async () => {
  const input = new FakeInput();
  const tts = new PreparedTts();
  const playback = new AudioPlaybackController({ kokoro: tts });
  const controller = new VoiceConversationController({
    settings: settings(), inputEngines: { local: { available: false }, browser: input }, playback
  });

  playback.enqueue('Trecho antigo em reprodução.', settings());
  playback.enqueue('Sobra antiga na fila.', settings());
  await tick();
  controller.onChatStart();
  controller.onChatDelta('Trecho exclusivo da resposta nova. ');
  controller.onChatEnd();
  await tick();
  tts.finish();
  await tick();

  assert.doesNotMatch(tts.played.join(' '), /Sobra antiga/);
  assert.match(tts.played.join(' '), /Trecho exclusivo/);
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
