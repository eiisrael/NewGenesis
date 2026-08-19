import test from 'node:test';
import assert from 'node:assert/strict';

import { redactSecrets } from '../src/core/secret-sanitizer.js';
import { redactText } from '../src/telemetry.js';
import { sanitizeTaskText } from '../src/core/task-ledger.js';
import { ContextEngine } from '../src/core/context-engine.js';

const ASSIGNMENTS = [
  'API_KEY=bare-api-key-value',
  'const JWT_SECRET = "jwt-signing-value";',
  "DATABASE_PASSWORD: 'database-password-value'",
  'DATABASE_URL=postgres://admin:url-password@example.test/app',
  'OPENROUTER_API_KEY = `custom-openrouter-value`',
  'service.api-key: yaml-api-key-value',
  '"API_KEY": "json-api-key-value"'
];

test('redige identificadores sensíveis nus, prefixados e URLs com credenciais', () => {
  const sanitized = redactSecrets(ASSIGNMENTS.join('\n'));

  assert.doesNotMatch(sanitized, /bare-api-key-value|jwt-signing-value|database-password-value/);
  assert.doesNotMatch(sanitized, /url-password|custom-openrouter-value|yaml-api-key-value|json-api-key-value/);
  assert.doesNotMatch(sanitized, /\[REDACTED\]\]@/);
  assert.equal((sanitized.match(/\[REDACTED\]/g) || []).length, ASSIGNMENTS.length);
  assert.doesNotThrow(() => JSON.parse(`{${sanitized.split('\n').at(-1)}}`));
});

test('integrações de telemetria e ledger usam a mesma redação central', () => {
  for (const sanitize of [redactText, sanitizeTaskText]) {
    const sanitized = sanitize(ASSIGNMENTS.join('\n'));
    assert.doesNotMatch(sanitized, /bare-api-key-value|jwt-signing-value|database-password-value/);
    assert.doesNotMatch(sanitized, /url-password|custom-openrouter-value/);
    assert.match(sanitized, /API_KEY="\[REDACTED\]"/);
  }
});

test('preserva texto comum, menções a nomes de variáveis e URLs sem senha', () => {
  const ordinary = [
    'A variável API_KEY identifica qual configuração deve ser preenchida.',
    'JWT_SECRET e DATABASE_PASSWORD aparecem apenas como nomes nesta documentação.',
    'Use um password manager e não revele a secret sauce.',
    'MODEL_TOKEN=4096 é apenas uma contagem de tokens.',
    'Documentação: https://example.test/api_key/usage',
    'DATABASE_URL deve vir do ambiente, sem expor seu valor.'
  ].join('\n');

  assert.equal(redactSecrets(ordinary), ordinary);
});

test('contexto externo redige título, prompt, memória e anexo de texto antes do envio', async () => {
  const engine = new ContextEngine({ inputTokenBudget: 8_000 });
  const result = await engine.build({
    conversation: {
      title: 'Debug API_KEY=title-secret-value',
      messages: [{
        id: 'message-1',
        role: 'user',
        content: 'Confira JWT_SECRET=prompt-secret-value',
        attachments: [{
          name: 'config-OPENROUTER_API_KEY=file-name-secret.txt',
          kind: 'text',
          size: 64,
          text: 'DATABASE_PASSWORD=attachment-secret-value'
        }, {
          name: 'DATABASE_PASSWORD=pdf-name-secret.pdf',
          kind: 'pdf',
          size: 16,
          dataUrl: 'data:application/pdf;base64,JVBERi0xLjQ='
        }]
      }]
    },
    query: 'Confira a configuração',
    userMemoryContext: 'DATABASE_URL=postgres://memory:memory-secret@example.test/app'
  });

  const outbound = JSON.stringify(result.messages);
  assert.doesNotMatch(outbound, /title-secret-value|prompt-secret-value|file-name-secret|pdf-name-secret|attachment-secret-value|memory-secret/);
  assert.match(outbound, /REDACTED/);
});
