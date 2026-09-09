import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PreciseOpenRouterProvider } from '../src/providers/precise-openrouter-provider.js';
import { ProjectStore } from '../src/project-store.js';
import { PermissionStore, ApprovalManager } from '../src/permissions.js';
import { ProjectToolExecutor, projectToolDefinitionsFor } from '../src/project-tools.js';
import { createTaskContract } from '../src/core/task-contract.js';

function createProvider() {
  return new PreciseOpenRouterProvider({
    id: 'openrouter', name: 'Modelos gratuitos', kind: 'cloud', freeLabel: 'free',
    apiKey: 'test', configured: true, baseUrl: 'https://example.invalid/api/v1',
    models: ['openrouter/free'], requestTimeoutMs: 5000, discoveryTimeoutMs: 5000,
    selectionMode: 'automatic', selectedModel: 'openrouter/free'
  });
}

const prompt = 'Crie uma página com um bonito layout, mostrando versículos bíblicos. Haja como senior, crie os arquivos na pasta do projeto, faça em HTML,CSS e JS. Retorne apenas quando tudo estiver finalizado.';

test('E2E: modelo gratuito que responde com código em texto ainda grava HTML/CSS/JS no disco', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-service-e2e-'));
  const dataDir = path.join(root, 'data');
  const projectDir = path.join(root, 'TESTE');
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

  const contract = createTaskContract(prompt, {
    project: { id: 'p', name: 'TESTE', fileCount: 0, writable: true }
  });
  const tools = projectToolDefinitionsFor(contract, { writable: true });
  assert.deepEqual(tools.map(tool => tool.function.name), ['write_project_files']);

  const provider = createProvider();
  const originalFetch = globalThis.fetch;
  let remoteRequests = 0;
  globalThis.fetch = async () => {
    remoteRequests += 1;
    const content = [
      'Vou criar os arquivos:',
      '```html',
      '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main id="verse">Versículo</main><script src="script.js"></script></body></html>',
      '```',
      '```css',
      'body { min-height: 100vh; font-family: sans-serif; }',
      '```',
      '```javascript',
      'const verse = document.querySelector("#verse");\nverse.dataset.ready = "true";',
      '```'
    ].join('\n');
    return new Response(JSON.stringify({
      model: 'liquid/lfm-2.5-2.6b:free',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 160, completion_tokens: 160, total_tokens: 320 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const candidate = provider.candidate('openrouter/free', [], 'code', { tools: true });
  const result = await provider.generate({
    candidate,
    messages: [{ role: 'user', content: prompt }],
    maxOutputTokens: 2000,
    temperature: 0,
    sessionId: 'service-agent-e2e',
    tools
  });

  assert.equal(remoteRequests, 1);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'write_project_files');

  const toolResult = await executor.execute(result.toolCalls[0], {
    conversationId: 'service-agent-e2e', onEvent: () => {}
  });
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.verified, true);
  assert.equal(await fs.readFile(path.join(projectDir, 'index.html'), 'utf8'), '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main id="verse">Versículo</main><script src="script.js"></script></body></html>');
  assert.equal(await fs.readFile(path.join(projectDir, 'styles.css'), 'utf8'), 'body { min-height: 100vh; font-family: sans-serif; }');
  assert.match(await fs.readFile(path.join(projectDir, 'script.js'), 'utf8'), /dataset\.ready/);
});
