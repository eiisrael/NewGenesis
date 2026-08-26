import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('UI de voz usa o mesmo composer e histórico canônico do chat', () => {
  const source = fs.readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');
  const engines = fs.readFileSync(new URL('../public/voice/engines.js', import.meta.url), 'utf8');
  assert.match(engines, /SpeechRecognition/);
  assert.match(engines, /webkitSpeechRecognition/);
  assert.match(engines, /speechSynthesis/);
  assert.match(source, /composer\.requestSubmit\(\)/);
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
});

test('modo conversa expõe controles, privacidade local e engines opcionais', () => {
  const voice = fs.readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');
  assert.match(voice, /voiceConversationMode/);
  assert.match(voice, /voicePreferLocal/);
  assert.match(voice, /Chatterbox pt-BR/);
  assert.match(voice, /Piper pt-BR/);
  assert.match(voice, /Áudio local não é salvo/);
});
