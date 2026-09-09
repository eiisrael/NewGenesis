import test from 'node:test';
import assert from 'node:assert/strict';
import { ResilientOpenRouterProvider } from '../src/providers/resilient-openrouter-provider.js';
import { ProviderError } from '../src/core/errors.js';

function createProvider() {
  return new ResilientOpenRouterProvider({
    id: 'openrouter',
    name: 'Modelos gratuitos',
    kind: 'cloud',
    freeLabel: 'free',
    apiKey: 'test',
    configured: true,
    baseUrl: 'https://example.invalid/api/v1',
    models: ['openrouter/free'],
    requestTimeoutMs: 5000,
    discoveryTimeoutMs: 5000,
    selectionMode: 'automatic',
    selectedModel: 'openrouter/free'
  });
}

const writeTool = [{
  type: 'function',
  function: {
    name: 'write_project_file',
    description: 'Escreve um arquivo',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }
  }
}];

test('rota em quota respeita Retry-After maior que dez minutos', async () => {
  const provider = createProvider();
  provider.activeModel = 'first:free';
  const before = Date.now();
  provider.markFailure(new ProviderError('quota', { category: 'quota', retryAfterMs: 3_600_000 }));
  assert.ok(provider.routeState('first:free').cooldownUntil >= before + 3_600_000);
  assert.equal(provider.routeCanAttempt('first:free'), false);
  assert.equal(provider.routeCanAttempt('second:free'), true);
});

test('falha de um modelo não derruba todas as rotas do provedor', async () => {
  const provider = createProvider();
  provider.catalog = [
    { id: 'first:free', name: 'First', contextWindow: 8192, supportedParameters: ['tools'], inputModalities: ['text'] },
    { id: 'second:free', name: 'Second', contextWindow: 8192, supportedParameters: ['tools'], inputModalities: ['text'] }
  ];
  provider.catalogAt = Date.now();
  provider.activeModel = 'first:free';
  provider.markFailure(new ProviderError('quota', { category: 'quota', code: 'quota_exhausted' }));
  const candidates = await provider.resolveCandidates('code', { tools: true });
  assert.ok(!candidates.some(candidate => candidate.model === 'first:free'));
  assert.ok(candidates.some(candidate => candidate.model === 'second:free'));
  assert.ok(candidates.some(candidate => candidate.model === 'openrouter/free'));
  assert.equal(provider.canAttempt(), true);
  assert.equal(provider.isCoolingDown(), false);
});

test('modelo sem tool calling usa protocolo JSON compatível', async t => {
  const provider = createProvider();
  const originalFetch = globalThis.fetch;
  let sentBody;
  globalThis.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: 'plain:free',
      provider: 'mock',
      choices: [{
        message: { content: '{"tool":"write_project_file","arguments":{"path":"src/app.js","content":"ok"}}' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await provider.generate({
    candidate: { model: 'plain:free', supportsTools: false },
    messages: [{ role: 'system', content: 'Sistema' }, { role: 'user', content: 'Altere o arquivo.' }],
    maxOutputTokens: 200,
    temperature: 0.1,
    sessionId: 's1',
    tools: writeTool
  });

  assert.equal('tools' in sentBody, false);
  assert.match(sentBody.messages[0].content, /MODO DE FERRAMENTAS COMPATÍVEL/);
  assert.equal(result.content, '');
  assert.equal(result.toolCalls[0].function.name, 'write_project_file');
});

test('recusa resposta que promete alteração sem executar ferramenta', async t => {
  const provider = createProvider();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'plain:free',
    choices: [{ message: { content: 'Arquivo alterado com sucesso.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(provider.generate({
    candidate: { model: 'plain:free', supportsTools: false },
    messages: [{ role: 'system', content: 'Sistema' }, { role: 'user', content: 'Corrija o arquivo src/app.js.' }],
    maxOutputTokens: 200,
    temperature: 0.1,
    sessionId: 's2',
    tools: writeTool
  }), error => error.code === 'project_action_missing' && error.usage?.totalTokens === 15);
});

test('preserva resultados de ferramentas e deixa duplicatas visíveis ao orquestrador', async t => {
  const provider = createProvider();
  const originalFetch = globalThis.fetch;
  const bodies = [];
  let requestCount = 0;
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    requestCount += 1;
    const content = requestCount === 1
      ? '{"tool":"write_project_file","arguments":{"path":"src/app.js","content":"ok"}}'
      : 'Alteração já concluída e resposta finalizada.';
    return new Response(JSON.stringify({
      model: 'plain:free',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const completedMessages = [
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Corrija o arquivo src/app.js.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'write-1',
        type: 'function',
        function: { name: 'write_project_file', arguments: '{"path":"src/app.js","content":"ok"}' }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'write-1',
      name: 'write_project_file',
      content: '{"ok":true,"summary":"src/app.js atualizado."}'
    }
  ];

  const result = await provider.generate({
    candidate: { model: 'plain:free', supportsTools: false },
    messages: completedMessages,
    maxOutputTokens: 200,
    temperature: 0.1,
    sessionId: 's3',
    tools: writeTool
  });

  assert.equal(requestCount, 1);
  assert.match(JSON.stringify(bodies[0].messages), /CONTINUIDADE DE FERRAMENTAS/);
  assert.equal(result.content, '');
  assert.equal(result.toolCalls[0].function.name, 'write_project_file');
});

test('roteador dinâmico não repete chamada transitória de forma oculta', async t => {
  const provider = createProvider();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(() => provider.generate({
    candidate: { model: 'openrouter/free', supportsTools: true },
    messages: [{ role: 'system', content: 'Sistema' }, { role: 'user', content: 'Explique.' }],
    maxOutputTokens: 200,
    temperature: 0.1,
    sessionId: 's4',
    tools: []
  }), error => error.code === 'provider_unavailable' && error.category === 'availability');

  assert.equal(calls, 1, 'fallback e nova tentativa pertencem ao orquestrador e ao orçamento global');
});
