import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSpeechInputEngine, LocalSpeechInputEngine, SystemTextToSpeechEngine } from '../public/voice/engines.js';

class FakeRecognition {
  static instances = [];

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start() { this.onstart?.(); }
  abort() {}
}

class DeferredAudioInput {
  available = true;
  callbacks = {};
  releaseArm = null;
  disarmed = 0;

  arm() {
    return new Promise(resolve => { this.releaseArm = resolve; });
  }

  disarm() { this.disarmed += 1; }
  close() {}
}

class MultiDeferredAudioInput {
  available = true;
  callbacks = {};
  arms = [];
  disarmed = 0;

  arm() {
    return new Promise(resolve => this.arms.push(resolve));
  }

  disarm() { this.disarmed += 1; }
  close() {}
}

class RejectingDeferredAudioInput {
  available = true;
  callbacks = {};
  disarmed = 0;
  arm() { return new Promise((_resolve, reject) => { this.rejectArm = reject; }); }
  disarm() { this.disarmed += 1; }
  close() {}
}

function speechResult(text, isFinal = true) {
  const result = [{ transcript: text }];
  result.isFinal = isFinal;
  return result;
}

test('stop do reconhecimento do navegador neutraliza eventos tardios e não contamina a sessão seguinte', t => {
  FakeRecognition.instances = [];
  const engine = new BrowserSpeechInputEngine(FakeRecognition);
  t.after(() => engine.close());
  const staleEvents = [];
  const freshFinals = [];

  engine.start({
    onSpeechStart: () => staleEvents.push('speech-start'),
    onInterim: text => staleEvents.push(`interim:${text}`),
    onError: error => staleEvents.push(`error:${error.code}`)
  });
  const stale = FakeRecognition.instances[0];
  engine.stop();

  engine.start({ onFinal: text => freshFinals.push(text) });
  const fresh = FakeRecognition.instances[1];

  stale.onspeechstart?.();
  stale.onerror?.({ error: 'aborted' });
  stale.onresult?.({ resultIndex: 0, results: [speechResult('transcrição antiga')] });
  fresh.onresult?.({ resultIndex: 0, results: [speechResult('mensagem nova')] });
  fresh.onend?.();

  assert.deepEqual(staleEvents, []);
  assert.deepEqual(freshFinals, ['mensagem nova']);
});

test('erro terminal do reconhecimento do navegador não emite onEnd duplicado', t => {
  FakeRecognition.instances = [];
  const engine = new BrowserSpeechInputEngine(FakeRecognition);
  t.after(() => engine.close());
  const events = [];

  engine.start({
    onError: error => events.push(`error:${error.code}`),
    onEnd: () => events.push('end')
  });
  const recognition = FakeRecognition.instances[0];
  recognition.onerror?.({ error: 'no-speech' });
  recognition.onend?.();

  assert.deepEqual(events, ['error:browser_stt_no-speech']);
});

test('start local cancelado durante arm pendente não reativa a captura nem chama onStart', async t => {
  const audioInput = new DeferredAudioInput();
  const engine = new LocalSpeechInputEngine({ audioInput });
  t.after(() => engine.stop());
  const starts = [];
  engine.setAvailable(true);

  const pendingStart = engine.start({ onStart: () => starts.push('started') });
  engine.stop();
  audioInput.releaseArm();
  await Promise.allSettled([pendingStart]);

  assert.deepEqual(starts, []);
  assert.ok(audioInput.disarmed >= 2);
});

test('start local antigo não desarma uma captura mais nova', async t => {
  const audioInput = new MultiDeferredAudioInput();
  const engine = new LocalSpeechInputEngine({ audioInput });
  t.after(() => engine.stop());
  const starts = [];
  engine.setAvailable(true);

  const first = engine.start({ onStart: () => starts.push('old') });
  const second = engine.start({ onStart: () => starts.push('new') });
  audioInput.arms[1](true);
  await second;
  const disarmedBeforeOldSettles = audioInput.disarmed;
  audioInput.arms[0](true);
  await first;

  assert.deepEqual(starts, ['new']);
  assert.equal(audioInput.disarmed, disarmedBeforeOldSettles);
});

test('erro tardio de arm cancelado não ressuscita uma sessão local', async t => {
  const audioInput = new RejectingDeferredAudioInput();
  const engine = new LocalSpeechInputEngine({ audioInput });
  t.after(() => engine.stop());
  engine.setAvailable(true);

  const pending = engine.start({});
  engine.stop();
  audioInput.rejectArm(new Error('permissão antiga rejeitada'));

  assert.equal(await pending, false);
});

test('voz rápida usa somente uma voz portuguesa marcada como local', async () => {
  const spoken = [];
  const synthesis = {
    getVoices: () => [
      { name: 'Remota', lang: 'pt-BR', localService: false },
      { name: 'Sem confirmação local', lang: 'pt-BR' },
      { name: 'Maria local', lang: 'pt-BR', localService: true }
    ],
    speak(utterance) {
      spoken.push(utterance);
      utterance.onstart?.();
      utterance.onend?.();
    },
    cancel() {},
    resume() {}
  };
  class FakeUtterance { constructor(text) { this.text = text; } }
  const engine = new SystemTextToSpeechEngine({ synthesis, Utterance: FakeUtterance });
  let firstAudio = 0;

  await engine.speak('Olá, Gênesis.', { rate: 1.1, onFirstAudio: () => { firstAudio += 1; } });

  assert.equal(spoken[0].voice.name, 'Maria local');
  assert.equal(spoken[0].lang, 'pt-BR');
  assert.equal(firstAudio, 1);
});
