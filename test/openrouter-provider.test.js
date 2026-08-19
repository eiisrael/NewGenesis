import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider, modelScore } from '../src/providers/openai-compatible-provider.js';

class CatalogProvider extends OpenAICompatibleProvider {
  async requestJson(url) {
    if (url.endsWith('/key')) return { payload: { data: { label: 'sk-or-…1234', is_free_tier: true } }, response: {} };
    return {
      payload: { data: [
        { id: 'qwen/qwen3:free', name: 'Qwen Free', context_length: 32000, architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
        { id: 'openai/gpt-paid', name: 'Paid', context_length: 128000, pricing: { prompt: '1', completion: '2' } },
        { id: 'vendor/free-now', name: 'Zero now but unpinned', context_length: 8000, pricing: { prompt: '0', completion: '0' } }
      ] },
      response: {}
    };
  }
}

function provider() {
  return new CatalogProvider({
    id: 'openrouter', name: 'OpenRouter', kind: 'cloud', freeLabel: 'Free', configured: true,
    apiKey: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890', baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openrouter/free'], selectionMode: 'manual', selectedModel: 'qwen/qwen3:free',
    requestTimeoutMs: 1000, discoveryTimeoutMs: 1000
  });
}

function automaticProvider() {
  const instance = provider();
  instance.setSelection('automatic');
  instance.catalog = [
    { id: 'qwen/qwen3-next-80b:free', name: 'Qwen 3 Next', contextWindow: 131072, inputModalities: ['text'], freeVerified: true },
    { id: 'meta/llama-3.3-70b:free', name: 'Llama 70B', contextWindow: 131072, inputModalities: ['text'], freeVerified: true },
    { id: 'google/gemma-4-31b:free', name: 'Gemma Vision', contextWindow: 131072, inputModalities: ['text', 'image'], freeVerified: true },
    { id: 'nvidia/nemotron-omni-30b:free', name: 'Nemotron Vision', contextWindow: 131072, inputModalities: ['text', 'image'], freeVerified: true },
    { id: 'small/model-3b:free', name: 'Small', contextWindow: 8192, inputModalities: ['text'], freeVerified: true }
  ];
  instance.catalogAt = Date.now();
  return instance;
}

test('catálogo expõe somente IDs explicitamente free', async () => {
  const instance = provider();
  const models = await instance.models({ force: true });
  assert.deepEqual(models.map(model => model.id), ['qwen/qwen3:free']);
});

test('seleção manual mantém openrouter/free como contingência', async () => {
  const candidates = await provider().resolveCandidates('code');
  assert.deepEqual(candidates.map(candidate => candidate.model), ['qwen/qwen3:free', 'openrouter/free']);
  assert.ok(candidates.every(candidate => candidate.freeVerified));
});

test('anexo de imagem ignora modelo manual sem visão e usa o roteador free', async () => {
  const candidates = await provider().resolveCandidates('balanced', { image: true });
  assert.deepEqual(candidates.map(candidate => candidate.model), ['openrouter/free']);
});

test('seleção automática cria contingência entre vários modelos gratuitos', async () => {
  const candidates = await automaticProvider().resolveCandidates('balanced');
  assert.equal(candidates.length, 6);
  assert.equal(candidates[0].model, 'qwen/qwen3-next-80b:free');
  assert.equal(candidates.at(-1).model, 'openrouter/free');
  assert.ok(candidates.every(candidate => candidate.freeVerified));
});

test('seleção automática multimodal usa apenas modelos com visão antes do roteador', async () => {
  const candidates = await automaticProvider().resolveCandidates('balanced', { image: true });
  assert.deepEqual(candidates.map(candidate => candidate.model), [
    'google/gemma-4-31b:free',
    'nvidia/nemotron-omni-30b:free',
    'openrouter/free'
  ]);
});

test('PDF ativa somente o parser gratuito do OpenRouter', async () => {
  const instance = provider();
  let requestBody;
  instance.requestJson = async (url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      payload: {
        model: 'qwen/qwen3:free', provider: 'Free',
        choices: [{ message: { content: 'Documento analisado.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
      },
      response: {}
    };
  };
  await instance.generate({
    candidate: { model: 'qwen/qwen3:free' }, sessionId: 'session', maxOutputTokens: 100, temperature: 0.2,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Analise.' },
      { type: 'file', file: { filename: 'guia.pdf', file_data: 'data:application/pdf;base64,JVBERg==' } }
    ] }]
  });
  assert.deepEqual(requestBody.plugins, [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);
  assert.equal(requestBody.model.endsWith(':free'), true);
});

test('roteador free rejeita classificador de segurança como resposta final', async () => {
  const instance = provider();
  instance.requestJson = async () => ({
    payload: {
      model: 'nvidia/nemotron-3.5-content-safety:free',
      choices: [{ message: { content: 'User Safety: safe' } }]
    },
    response: {}
  });
  await assert.rejects(() => instance.generate({
    candidate: { model: 'openrouter/free' }, sessionId: 'session', maxOutputTokens: 100, temperature: 0.2,
    messages: [{ role: 'user', content: 'Olá' }]
  }), error => error.code === 'non_generative_model');
});

test('envia ferramentas estruturadas e nunca aceita marcação de ferramenta como texto', async () => {
  const instance = provider();
  let requestBody;
  instance.requestJson = async (url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      payload: {
        model: 'qwen/qwen3:free',
        choices: [{ message: { content: null, tool_calls: [{
          id: 'call-1', type: 'function', function: { name: 'read_project_file', arguments: '{"path":"README.md"}' }
        }] }, finish_reason: 'tool_calls' }]
      }, response: {}
    };
  };
  const result = await instance.generate({
    candidate: { model: 'qwen/qwen3:free' }, sessionId: 'session', maxOutputTokens: 100, temperature: 0.2,
    messages: [{ role: 'user', content: 'Leia.' }],
    tools: [{ type: 'function', function: { name: 'read_project_file', parameters: { type: 'object' } } }]
  });
  assert.equal(requestBody.parallel_tool_calls, false);
  assert.equal(result.toolCalls[0].function.name, 'read_project_file');

  instance.requestJson = async () => ({ payload: {
    model: 'qwen/qwen3:free', choices: [{ message: { content: '<tool_call>execute</tool_call>' } }]
  }, response: {} });
  await assert.rejects(() => instance.generate({
    candidate: { model: 'qwen/qwen3:free' }, sessionId: 'session', maxOutputTokens: 100, temperature: 0.2,
    messages: [{ role: 'user', content: 'Renomeie.' }]
  }), error => error.code === 'invalid_tool_markup');
});

test('descobre e usa somente modelos gratuitos de imagem', async () => {
  const instance = provider();
  const requested = [];
  instance.requestJson = async (url, options = {}) => {
    requested.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/images/models')) return { payload: { data: [
      { id: 'recraft/recraft-v3:free', name: 'Recraft Free', architecture: { output_modalities: ['image'] }, supported_parameters: {} },
      { id: 'openai/gpt-image-paid', name: 'Paid', architecture: { output_modalities: ['image'] } }
    ] }, response: {} };
    return { payload: {
      model: 'recraft/recraft-v3:free', data: [{ b64_json: 'iVBORw0KGgo=' }], usage: { total_tokens: 12 }
    }, response: {} };
  };
  const result = await instance.generateImage({ prompt: 'Crie uma árvore.' });
  assert.equal(result.model, 'recraft/recraft-v3:free');
  assert.equal(result.generatedImages.length, 1);
  assert.equal(requested.at(-1).body.model.endsWith(':free'), true);
});

test('o perfil da tarefa muda a escolha entre código, raciocínio e velocidade', () => {
  const code = { id: 'cohere/north-mini-code:free', contextWindow: 256000, supportedParameters: ['tools'] };
  const reasoning = { id: 'nvidia/nemotron-3-ultra:free', contextWindow: 1000000, supportedParameters: ['tools'] };
  const fast = { id: 'poolside/laguna-xs-2.1:free', contextWindow: 262144, supportedParameters: ['tools'] };
  assert.ok(modelScore(code, 'balanced', { intent: 'CODE', tools: true }) > modelScore(fast, 'balanced', { intent: 'CODE', tools: true }));
  assert.ok(modelScore(reasoning, 'balanced', { intent: 'ANALYSIS' }) > modelScore(code, 'balanced', { intent: 'ANALYSIS' }));
  assert.ok(modelScore(fast, 'fast', {}) > modelScore(reasoning, 'fast', {}));
});

test('transmite a resposta em partes e preserva a contagem final do provedor', async t => {
  const instance = provider();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    'data: {"model":"qwen/qwen3:free","choices":[{"delta":{"content":"Olá "},"finish_reason":null}]}',
    '',
    'data: {"model":"qwen/qwen3:free","choices":[{"delta":{"content":"mundo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  t.after(() => { globalThis.fetch = originalFetch; });
  const deltas = [];
  const result = await instance.generate({
    candidate: { model: 'qwen/qwen3:free', supportedParameters: [] },
    sessionId: 'stream', maxOutputTokens: 100, temperature: 0.2,
    messages: [{ role: 'user', content: 'Cumprimente.' }],
    onDelta: value => deltas.push(value)
  });
  assert.deepEqual(deltas, ['Olá ', 'mundo']);
  assert.equal(result.content, 'Olá mundo');
  assert.equal(result.usage.totalTokens, 13);
});
