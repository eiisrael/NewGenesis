import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError, retryAfterMilliseconds } from '../src/core/errors.js';
import { BaseProvider } from '../src/providers/base-provider.js';

test('Retry-After respeita segundos e data HTTP sem encurtar a espera', () => {
  const timestamp = Date.parse('2026-09-08T12:00:00Z');
  assert.equal(retryAfterMilliseconds('3600', timestamp), 3_600_000);
  assert.equal(retryAfterMilliseconds('Tue, 08 Sep 2026 13:00:00 GMT', timestamp), 3_600_000);
  assert.equal(retryAfterMilliseconds('Tue, 08 Sep 2026 11:00:00 GMT', timestamp), 0);
  assert.equal(retryAfterMilliseconds('invalid', timestamp), 0);
});

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
