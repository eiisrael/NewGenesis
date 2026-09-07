import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PreciseOpenRouterProvider } from '../src/providers/precise-openrouter-provider.js';
import { ProjectStore } from '../src/project-store.js';
import { PermissionStore, ApprovalManager } from '../src/permissions.js';
import { ProjectToolExecutor } from '../src/project-tools.js';

function createProvider() {
  return new PreciseOpenRouterProvider({
    id: 'openrouter', name: 'Modelos gratuitos', kind: 'cloud', freeLabel: 'free',
    apiKey: 'test', configured: true, baseUrl: 'https://example.invalid/api/v1',
    models: ['openrouter/free'], requestTimeoutMs: 5000, discoveryTimeoutMs: 5000,
    selectionMode: 'automatic', selectedModel: 'openrouter/free'
  });
}

const writeTool = {
  type: 'function',
  function: {
    name: 'write_project_file',
    description: 'Grava um arquivo dentro do projeto ativo.',
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } }
    }
  }
};

test('pedido real em pasta vazia vira uma requisição, uma ferramenta e index.html no disco', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-direct-create-'));
  const dataDir = path.join(root, 'data');
  const projectDir = path.join(root, 'Teste');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const projectStore = await new ProjectStore(dataDir).init();
  await projectStore.openPath(projectDir);
  const permissionStore = await new PermissionStore(dataDir).init();
  await permissionStore.setMode('full');
  const executor = new ProjectToolExecutor({
    projectStore,
    permissionStore,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 })
  });

  const provider = createProvider();
  const originalFetch = globalThis.fetch;
  let remoteRequests = 0;
  const html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Teste</title></head><body><h1>Genesis</h1></body></html>';
  globalThis.fetch = async () => {
    remoteRequests += 1;
    return new Response(JSON.stringify({
      model: 'north-mini-code:free',
      choices: [{ message: { content: html }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const candidate = provider.candidate('openrouter/free', [], 'code', { tools: true });
  const result = await provider.generate({
    candidate,
    messages: [{ role: 'user', content: 'Crie um index.html na pasta do projeto' }],
    maxOutputTokens: 1000,
    temperature: 0,
    sessionId: 'direct-create-e2e',
    tools: [writeTool]
  });

  assert.equal(remoteRequests, 1);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'write_project_file');

  const toolResult = await executor.execute(result.toolCalls[0], {
    conversationId: 'direct-create-e2e',
    onEvent: () => {}
  });
  assert.equal(toolResult.ok, true);
  assert.equal(await fs.readFile(path.join(projectDir, 'index.html'), 'utf8'), html);
});