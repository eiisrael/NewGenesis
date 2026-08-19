import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('UI de voz usa o mesmo composer e histórico canônico do chat', () => {
  const source = fs.readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');
  assert.match(source, /SpeechRecognition/);
  assert.match(source, /webkitSpeechRecognition/);
  assert.match(source, /speechSynthesis/);
  assert.match(source, /composer\.requestSubmit\(\)/);
  assert.match(source, /aria-busy/);
  assert.match(source, /#messageList/);
  assert.match(source, /genesis:voice/);
});

test('index carrega a camada de voz separadamente do motor do chat', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /\/app\.js\?v=2\.3\.0/);
  assert.match(html, /\/voice\.js\?v=2\.3\.0/);
  assert.match(html, /Gênesis v2\.3\.0/);
});
