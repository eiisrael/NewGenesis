import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible-provider.js';
import { ResilientOpenRouterProvider } from '../src/providers/resilient-openrouter-provider.js';

const encoder = new TextEncoder();

function provider() {
  return new OpenAICompatibleProvider({
    id: 'openrouter', name: 'OpenRouter', kind: 'cloud', freeLabel: 'Free', configured: true,
    apiKey: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890', baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openrouter/free'], selectionMode: 'automatic',
    requestTimeoutMs: 10_000, discoveryTimeoutMs: 1000
  });
}

function generate(instance, options = {}) {
  return instance.generate({
    candidate: { model: 'openrouter/free', supportedParameters: [] },
    sessionId: 'stream-errors', maxOutputTokens: 100, temperature: 0.2,
    messages: [{ role: 'user', content: 'Responda.' }],
    onDelta: () => {},
    ...options
  });
}

function readerResponse(read) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: {
      getReader() {
        return { read, async cancel() {}, releaseLock() {} };
      }
    }
  };
}

test('erro top-level em SSE rejeita conteúdo parcial e preserva usage', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"Trecho parcial"},"finish_reason":null}]}',
    '',
    'data: {"error":{"message":"stream exploded"},"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}',
    ''
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  t.after(() => { globalThis.fetch = originalFetch; });
  const deltas = [];
  await assert.rejects(() => generate(provider(), { onDelta: value => deltas.push(value) }), error => {
    assert.equal(error.name, 'ProviderError');
    assert.equal(error.category, 'availability');
    assert.equal(error.code, 'stream_error');
    assert.equal(error.finishReason, 'error');
    assert.deepEqual(error.usage, {
      inputTokens: 9, outputTokens: 2, totalTokens: 11,
      reasoningTokens: 0, cachedTokens: 0, cost: 0
    });
    return true;
  });
  assert.deepEqual(deltas, ['Trecho parcial']);
});

test('finish_reason error em SSE nunca vira resposta bem-sucedida', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"Início"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"error"}],"usage":{"prompt_tokens":7,"completion_tokens":1,"total_tokens":8}}',
    ''
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(() => generate(provider()), error => {
    assert.equal(error.code, 'stream_error');
    assert.equal(error.finishReason, 'error');
    assert.equal(error.usage.totalTokens, 8);
    return true;
  });
});

test('EOF limpo sem finish_reason terminal é resposta incompleta, não sucesso', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"Resposta cortada"},"finish_reason":null}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(() => generate(provider()), error => {
    assert.equal(error.name, 'ProviderError');
    assert.equal(error.code, 'incomplete_stream');
    assert.equal(error.category, 'availability');
    assert.equal(error.finishReason, null);
    assert.equal(error.usage.totalTokens, 7);
    return true;
  });
});

test('AbortError durante reader.read é timeout quando não houve cancelamento externo', async t => {
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async () => readerResponse(async () => {
    reads += 1;
    if (reads === 1) return {
      done: false,
      value: encoder.encode('data: {"choices":[{"delta":{"content":"Parcial"}}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\n')
    };
    throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  });
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(() => generate(provider()), error => {
    assert.equal(error.category, 'timeout');
    assert.equal(error.code, 'provider_timeout');
    assert.equal(error.usage.totalTokens, 5);
    return true;
  });
});

test('AbortError durante reader.read mantém cancelamento externo distinto', async t => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async () => readerResponse(async () => {
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(() => generate(provider(), { signal: controller.signal }), error => {
    assert.equal(error.category, 'cancelled');
    assert.equal(error.code, 'request_cancelled');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('finish_reason error também invalida resposta JSON não-streaming', async () => {
  const instance = provider();
  instance.requestJson = async () => ({
    payload: {
      model: 'qwen/qwen3:free',
      choices: [{ message: { content: 'Resposta parcial' }, finish_reason: 'error' }],
      usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 }
    },
    response: {}
  });
  await assert.rejects(() => generate(instance, { onDelta: null }), error => {
    assert.equal(error.code, 'stream_error');
    assert.equal(error.finishReason, 'error');
    assert.equal(error.usage.totalTokens, 8);
    return true;
  });
});

test('erros de validação pós-resposta carregam a medição já reportada', async () => {
  const cases = [
    {
      code: 'empty_response',
      payload: { model: 'qwen/qwen3:free', choices: [{ message: { content: '' }, finish_reason: 'stop' }] }
    },
    {
      code: 'invalid_tool_markup',
      payload: { model: 'qwen/qwen3:free', choices: [{ message: { content: '<tool_call>read</tool_call>' }, finish_reason: 'stop' }] }
    },
    {
      code: 'non_generative_model',
      payload: { model: 'nvidia/content-safety:free', choices: [{ message: { content: 'safe' }, finish_reason: 'stop' }] }
    }
  ];
  for (const item of cases) {
    const instance = provider();
    instance.requestJson = async () => ({
      payload: { ...item.payload, usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
      response: {}
    });
    await assert.rejects(() => generate(instance, { onDelta: null }), error => {
      assert.equal(error.code, item.code);
      assert.equal(error.usage.totalTokens, 15);
      return true;
    });
  }
});

test('deadline impede rota sem janela útil e limita timeout ao restante', async () => {
  const expired = provider();
  let consumed = false;
  await assert.rejects(() => generate(expired, {
    deadlineAt: Date.now() + 200,
    requestBudget: { consume() { consumed = true; } }
  }), error => error.code === 'provider_deadline_exceeded' && error.category === 'timeout');
  assert.equal(consumed, false);

  const bounded = provider();
  let observedTimeout = 0;
  bounded.requestJson = async (url, options, timeoutMs) => {
    observedTimeout = timeoutMs;
    return {
      payload: {
        model: 'qwen/qwen3:free',
        choices: [{ message: { content: 'Concluído.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
      },
      response: {}
    };
  };
  const remaining = 2400;
  const result = await generate(bounded, { onDelta: null, deadlineAt: Date.now() + remaining });
  assert.equal(result.content, 'Concluído.');
  assert.ok(observedTimeout >= 1000 && observedTimeout <= remaining, `timeout observado: ${observedTimeout}`);
});

test('provider resiliente encaminha deadlineAt à única chamada visível', async t => {
  const instance = new ResilientOpenRouterProvider({
    id: 'openrouter', name: 'OpenRouter', kind: 'cloud', freeLabel: 'Free', configured: true,
    apiKey: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890', baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openrouter/free'], selectionMode: 'automatic',
    requestTimeoutMs: 10_000, discoveryTimeoutMs: 1000
  });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('não deveria chamar'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(() => generate(instance, { deadlineAt: Date.now() + 100 }), error => {
    assert.equal(error.code, 'provider_deadline_exceeded');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(requests, 0);
});

test('geração de imagem OpenRouter faz no máximo uma tentativa remota por invocação', async () => {
  const instance = provider();
  instance.imageModels = async () => [
    { id: 'image/first:free', name: 'First', supportedParameters: {} },
    { id: 'image/second:free', name: 'Second', supportedParameters: {} },
    { id: 'image/third:free', name: 'Third', supportedParameters: {} }
  ];
  let requests = 0;
  const announced = [];
  instance.requestJson = async () => {
    requests += 1;
    return {
      payload: { data: [], usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } },
      response: {}
    };
  };
  await assert.rejects(() => instance.generateImage({
    prompt: 'Crie uma imagem.',
    onAttempt: model => announced.push(model.id)
  }), error => {
    assert.equal(error.code, 'free_image_routes_exhausted');
    assert.equal(error.attempts.length, 1);
    assert.equal(error.usage.totalTokens, 3);
    return true;
  });
  assert.equal(requests, 1);
  assert.deepEqual(announced, ['image/first:free']);
});
