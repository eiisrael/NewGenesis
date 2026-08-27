import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('UI de voz usa o mesmo composer e histórico canônico do chat', () => {
  const source = fs.readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');
  const engines = fs.readFileSync(new URL('../public/voice/engines.js', import.meta.url), 'utf8');
  assert.match(engines, /SpeechRecognition/);
  assert.match(engines, /webkitSpeechRecognition/);
  assert.doesNotMatch(source, /speechSynthesis|BrowserTextToSpeechEngine|composer\.requestSubmit\(\)/);
  assert.match(source, /genesis:voice-submit/);
  assert.match(source, /aria-busy/);
  assert.match(source, /#messageList/);
  assert.match(source, /genesis:voice/);
});

test('index carrega a camada de voz separadamente do motor do chat', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /src="\/voice\.js"/);
  assert.doesNotMatch(html, /[?&]v=\d+\.\d+\.\d+/);
});

test('captura local usa AudioWorklet same-origin com fallback explícito', () => {
  const input = fs.readFileSync(new URL('../public/voice/audio-input.js', import.meta.url), 'utf8');
  const worklet = fs.readFileSync(new URL('../public/voice/audio-capture.worklet.js', import.meta.url), 'utf8');
  assert.match(input, /audioWorklet\.addModule\('\/voice\/audio-capture\.worklet\.js'\)/);
  assert.match(input, /script-processor-fallback/);
  assert.match(worklet, /registerProcessor\('genesis-audio-capture'/);
});

test('voz respeita a CSP estrita e usa somente CSS estático same-origin', () => {
  const voice = fs.readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');
  const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(voice, /createElement\(['"]style['"]\)|injectStyles|style\.textContent/);
  assert.match(styles, /\.genesis-voice-button/);
  assert.match(styles, /\.genesis-voice-popover/);
  assert.match(server, /style-src 'self'/);
  assert.doesNotMatch(server, /style-src[^\n]*unsafe-inline/);
  assert.match(server, /microphone=\(self\)/);
  assert.match(server, /geolocation=\(\)/);
});

test('modo conversa expõe controles, privacidade local e engines opcionais', () => {
  const voice = fs.readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');
  assert.match(voice, /voiceConversationMode/);
  assert.match(voice, /voicePreferLocal/);
  assert.match(voice, /Chatterbox pt-BR/);
  assert.match(voice, /Piper pt-BR/);
  assert.match(voice, /Kokoro-82M pt-BR/);
  assert.doesNotMatch(voice, /voiceTtsEngine[^\n]*option value="browser"/);
  assert.match(voice, /Áudio local não é salvo/);
});

test('protocolo Node e Python força UTF-8 para preservar acentos pt-BR', () => {
  const runtime = fs.readFileSync(new URL('../src/voice/voice-runtime.js', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../scripts/voice/tts-server.py', import.meta.url), 'utf8');
  assert.match(runtime, /PYTHONUTF8: '1'/);
  assert.match(runtime, /PYTHONIOENCODING: 'utf-8'/);
  assert.match(worker, /stream\.reconfigure\(encoding="utf-8", errors="strict"\)/);
  assert.match(worker, /trim_wave_silence/);
});

test('composer posiciona falar uma vez junto ao envio e não mostra memória ou widget local', () => {
  const voice = fs.readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(voice, /submitActions\.append\(sendButton\)/);
  assert.doesNotMatch(html, /memory-pill|Memória contínua|contextAwarenessCard|CONTEXTO LOCAL|Agora e aqui/);
});

test('composer mostra estados reais da conversa por voz com cronômetro acessível', () => {
  const voice = fs.readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(html, /id="voiceTurnIndicator"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="voiceTurnTimer">00:00/);
  for (const action of ['Gênesis está ouvindo', 'Gênesis detectou sua fala', 'Gênesis está entendendo', 'Gênesis está pensando', 'Gênesis está falando', 'Gênesis foi interrompido']) {
    assert.match(voice, new RegExp(action));
  }
  assert.match(voice, /elapsedLabel/);
  assert.match(styles, /voice-turn-indicator\[data-state="ERROR"\]/);
});

test('falha real de microfone gera aviso canônico no chat', () => {
  const voice = fs.readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(voice, /genesis:voice-notice/);
  assert.match(app, /persistVoiceNotice/);
  assert.match(app, /\/notices/);
  assert.match(server, /voice-diagnostics/);
  assert.match(server, /Não estou conseguindo ouvir você/);
});
