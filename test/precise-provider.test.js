import test from 'node:test';
import assert from 'node:assert/strict';
import { PreciseOpenRouterProvider } from '../src/providers/precise-openrouter-provider.js';

function createProvider() {
  return new PreciseOpenRouterProvider({
    id: 'openrouter', name: 'Modelos gratuitos', kind: 'cloud', freeLabel: 'free',
    apiKey: 'test', configured: true, baseUrl: 'https://example.invalid/api/v1',
    models: ['openrouter/free'], requestTimeoutMs: 5000, discoveryTimeoutMs: 5000,
    selectionMode: 'automatic', selectedModel: 'openrouter/free'
  });
}

const tool = name => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object' } }
});

const writeTool = [tool('write_project_file')];

test('não reutiliza mutações de uma tarefa anterior na mesma conversa', async t => {
  const provider = createProvider();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      model: 'plain:free',
      choices: [{ message: { content: 'Promessa sem ferramenta.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const state = provider.sessionState('same-session');
  state.taskFingerprint = 'old';
  state.mutations = 1;
  state.journal.push({ tool: 'write_project_file', ok: true });

  await assert.rejects(provider.generate({
    candidate: { model: 'plain:free', supportsTools: false },
    messages: [
      { role: 'assistant', content: 'Resposta anterior.' },
      { role: 'user', content: 'Corrija outro arquivo.' }
    ],
    maxOutputTokens: 100,
    temperature: 0,
    sessionId: 'same-session',
    tools: writeTool
  }), error => error.code === 'project_action_missing');
  assert.equal(calls, 1);
});

test('pedido exato de criar index.html vira escrita real já na primeira ação do roteador free', async t => {
  const provider = createProvider();
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options = {}) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: 'dynamic-free-model',
      choices: [{
        message: {
          content: JSON.stringify({
            tool: 'write_project_file',
            arguments: { path: 'index.html', content: '<!doctype html><html><body>Teste</body></html>' }
          })
        },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 120, completion_tokens: 28, total_tokens: 148 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const candidate = provider.candidate('openrouter/free', [], 'code', { tools: true });
  assert.equal(candidate.supportsTools, false);
  assert.equal(candidate.toolMode, 'text');

  const result = await provider.generate({
    candidate,
    messages: [{ role: 'user', content: 'Crie um index.html na pasta do projeto' }],
    maxOutputTokens: 500,
    temperature: 0,
    sessionId: 'create-index-session',
    tools: [tool('search_project'), tool('read_project_file'), tool('replace_project_text'), tool('write_project_file')]
  });

  assert.equal(requestBody.tools, undefined);
  assert.match(JSON.stringify(requestBody.messages), /write_project_file/);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'write_project_file');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    path: 'index.html', content: '<!doctype html><html><body>Teste</body></html>'
  });
});

test('não repete modelo exato quando a cota dele acabou', async t => {
  const provider = createProvider();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(provider.generate({
    candidate: { model: 'exact:free', supportsTools: true },
    messages: [{ role: 'user', content: 'Explique.' }],
    maxOutputTokens: 100,
    temperature: 0,
    sessionId: 'quota-session',
    tools: []
  }));
  assert.equal(calls, 1);
});
