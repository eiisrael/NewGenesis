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
const batchWriteTool = [tool('write_project_files')];

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

test('se modelo gratuito devolver HTML bruto, Genesis recupera a escrita em vez de descartar a saída', async t => {
  const provider = createProvider();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const html = '<!doctype html><html lang="pt-BR"><head><title>Genesis</title></head><body><h1>Teste</h1></body></html>';
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      model: 'dynamic-free-model',
      choices: [{ message: { content: html }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 90, completion_tokens: 35, total_tokens: 125 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const candidate = provider.candidate('openrouter/free', [], 'code', { tools: true });
  const result = await provider.generate({
    candidate,
    messages: [{ role: 'user', content: 'Crie um index.html' }],
    maxOutputTokens: 500,
    temperature: 0,
    sessionId: 'raw-html-session',
    tools: writeTool
  });

  assert.equal(calls, 1);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'write_project_file');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { path: 'index.html', content: html });
  assert.equal(result.toolRecovery, 'raw-file-content');
});

test('serviço multi-arquivo evita tool calling nativo mesmo em modelo que anuncia tools', async t => {
  const provider = createProvider();
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  const content = [
    '```html',
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head><link rel="stylesheet" href="styles.css"></head>',
    '<body><button id="new-verse">Outro versículo</button><script src="script.js"></script></body>',
    '</html>',
    '```',
    '```css',
    'body {',
    '  margin: 0;',
    '  font-family: system-ui, sans-serif;',
    '}',
    '```',
    '```javascript',
    'const button = document.getElementById("new-verse");',
    'button.addEventListener("click", () => {',
    '  document.body.dataset.clicked = "yes";',
    '});',
    '```'
  ].join('\n');

  globalThis.fetch = async (_url, options = {}) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: 'poolside/laguna-xs-2.1:free',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 700, total_tokens: 1200 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await provider.generate({
    candidate: {
      model: 'poolside/laguna-xs-2.1:free',
      supportsTools: true,
      toolMode: 'native',
      supportedParameters: ['tools', 'parallel_tool_calls'],
      contextWindow: 32_000,
      outputLimit: 4_000
    },
    messages: [{
      role: 'user',
      content: 'Crie uma página bonita com versículos bíblicos. Faça em HTML, CSS e JS e crie os arquivos na pasta do projeto.'
    }],
    maxOutputTokens: 4_000,
    temperature: 0,
    sessionId: 'service-native-tool-session',
    tools: batchWriteTool
  });

  assert.equal(requestBody.tools, undefined);
  assert.equal(requestBody.tool_choice, undefined);
  assert.match(JSON.stringify(requestBody.messages), /bloco Markdown completo/i);
  assert.match(JSON.stringify(requestBody.messages), /NÃO coloque HTML\/CSS\/JS dentro de strings JSON/i);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'write_project_files');
  assert.equal(result.toolRecovery, 'multi-fence-service-files');
  const args = JSON.parse(result.toolCalls[0].function.arguments);
  assert.deepEqual(args.files.map(file => file.path), ['index.html', 'styles.css', 'script.js']);
  assert.match(args.files[0].content, /\n<html/);
  assert.match(args.files[1].content, /\n  margin/);
  assert.match(args.files[2].content, /\nbutton\.addEventListener/);
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
