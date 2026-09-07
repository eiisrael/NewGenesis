import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeModelText } from '../src/core/content-sanitizer.js';

test('resultado JSON grande permanece parseável depois da compactação', () => {
  const source = JSON.stringify({
    ok: true,
    path: 'src/app.js',
    content: 'linha importante\n'.repeat(5000),
    summary: 'Leitura concluída.'
  });
  const result = sanitizeModelText(source, { maxCharacters: 1200, maxLineCharacters: 900 });
  assert.ok(result.text.length <= 1200);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.path, 'src/app.js');
  assert.equal(result.truncated, true);
});

test('base64 opaco é removido sem corromper a estrutura JSON', () => {
  const source = JSON.stringify({
    ok: true,
    payload: 'A'.repeat(5000),
    nested: { status: 'preservado' }
  });
  const result = sanitizeModelText(source, { maxCharacters: 1600 });
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.nested.status, 'preservado');
  assert.match(parsed.payload, /omitidos localmente|compactados/);
});