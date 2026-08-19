import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError } from '../src/core/errors.js';
import { BaseProvider } from '../src/providers/base-provider.js';

test('classifica erro 504 dentro de resposta HTTP 200 como timeout', () => {
  const error = classifyProviderError('openrouter', { status: 200, headers: new Headers() }, {
    error: { code: 504, message: 'The operation was aborted' }
  });
  assert.equal(error.category, 'timeout');
  assert.equal(error.code, 'provider_timeout');
  assert.match(error.message, /excedeu o tempo/i);
});

test('cabeçalhos ausentes não são interpretados como cota zero', () => {
  const provider = new BaseProvider({
    id: 'openrouter', name: 'OpenRouter', configured: true,
    requestTimeoutMs: 1000, discoveryTimeoutMs: 1000
  });
  provider.captureRateHeaders(new Headers());
  assert.equal(provider.health.remainingRequests, null);
  assert.equal(provider.health.remainingTokens, null);
});
