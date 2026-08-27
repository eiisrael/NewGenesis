import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createHandler } from '../src/server.js';
import { GenesisStore } from '../src/storage.js';
import { GenesisTelemetry } from '../src/telemetry.js';
import { AttachmentStore } from '../src/attachments.js';
import { ProjectStore } from '../src/project-store.js';
import { PermissionStore, ApprovalManager } from '../src/permissions.js';
import { ProjectToolExecutor } from '../src/project-tools.js';
import { TaskLedgerStore } from '../src/core/task-ledger.js';
import { createTaskContract } from '../src/core/task-contract.js';
import { ContextEngine } from '../src/core/context-engine.js';
import { GenesisOrchestrator } from '../src/core/orchestrator.js';
import { SupremeMindIntegration } from '../src/suprememind-integration.js';
import { createRuntimeShutdown } from '../src/runtime-lifecycle.js';

const ASTRAEON_PROMPT = 'Analise o Astraeon e retorne um bash com as informações do projeto.';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('contrato local de overview não captura um diagnóstico que apenas menciona o projeto', () => {
  const project = { id: 'project-1', name: 'ASTRAEON', fileCount: 10, writable: true };
  const overview = createTaskContract(ASTRAEON_PROMPT, { project });
  const diagnose = createTaskContract('Analise no projeto por que o login falha.', { project });
  const analyzedFix = createTaskContract('Analise o fix aplicado no login.', { project });
  const reviewedDelete = createTaskContract('Revise a função delete do usuário.', { project });

  assert.equal(overview.kind, 'project_overview');
  assert.equal(overview.requestBudget.limit, 0);
  assert.equal(diagnose.kind, 'diagnose');
  assert.equal(diagnose.toolPolicy.strategy, 'bounded_read_only');
  assert.ok(diagnose.requestBudget.limit > 0);
  assert.equal(analyzedFix.kind, 'analysis');
  assert.equal(analyzedFix.readOnly, true);
  assert.equal(reviewedDelete.kind, 'analysis');
  assert.equal(reviewedDelete.readOnly, true);
  assert.equal(reviewedDelete.toolPolicy.allowed.includes('delete_project_path'), false);

  for (const prompt of [
    'Faça a correção do login.',
    'Faça os ajustes necessários no login.',
    'Faça o fix do login.',
    'Resolva o problema do login.',
    'Aplique a correção do login.',
    'Melhore o painel.',
    'Otimize o jogo.',
    'Arrume o sistema visual.'
  ]) {
    const mutation = createTaskContract(prompt, { project });
    assert.equal(mutation.readOnly, false, `o pedido explícito deve permitir alteração: ${prompt}`);
    assert.equal(mutation.toolPolicy.strategy, 'bounded_agent');
  }
  const hypotheticalFix = createTaskContract('Analise como fazer a correção do login.', { project });
  assert.equal(hypotheticalFix.readOnly, true);
});

test('argumentos JSON equivalentes não executam a mesma ferramenta duas vezes', async () => {
  const calls = [];
  const provider = {
    id: 'openrouter',
    name: 'OpenRouter',
    configured: true,
    generated: 0,
    publicStatus() {
      return {
        configured: true,
        state: 'online',
        latencyMs: 1,
        failureCount: 0,
        remainingRequests: 100,
        remainingTokens: 100_000
      };
    },
    async resolveCandidates() {
      return [{
        providerId: this.id,
        model: 'canonical-tools:free',
        displayName: 'Canonical Tools Free',
        contextWindow: 32_768,
        outputLimit: 512,
        supportedParameters: ['tools'],
        supportsTools: true,
        score: 100,
        freeVerified: true
      }];
    },
    async generate(input) {
      this.generated += 1;
      calls.push(structuredClone(input.messages));
      if (this.generated === 1) {
        return {
          content: '',
          model: 'canonical-tools:free',
          resolvedModel: 'canonical-tools:free',
          resolvedProvider: 'Mock',
          latencyMs: 1,
          finishReason: 'tool_calls',
          usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
          toolCalls: [
            {
              id: 'call-one',
              type: 'function',
              function: { name: 'read_project_file', arguments: '{"path":"src/app.js","end_line":20}' }
            },
            {
              id: 'call-two',
              type: 'function',
              function: { name: 'read_project_file', arguments: '{"end_line":20,"path":"src/app.js"}' }
            }
          ]
        };
      }
      return {
        content: 'A leitura foi analisada uma única vez.',
        model: 'canonical-tools:free',
        resolvedModel: 'canonical-tools:free',
        resolvedProvider: 'Mock',
        latencyMs: 1,
        finishReason: 'stop',
        usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
        toolCalls: []
      };
    },
    markFailure() {},
    markSuccess() {},
    async probe() { return this.publicStatus(); }
  };
  const conversation = {
    id: 'canonical-tool-signature',
    title: 'Deduplicação',
    lastProviderId: null,
    messages: [{ id: 'user-one', role: 'user', content: 'Analise o arquivo app.js.', attachments: [] }]
  };
  const project = { id: 'project-1', name: 'ASTRAEON', fileCount: 10, writable: true };
  const taskContract = createTaskContract(conversation.messages[0].content, { project });
  let executions = 0;
  const orchestrator = new GenesisOrchestrator({
    providers: [provider],
    contextEngine: new ContextEngine({ inputTokenBudget: 3_000, outputTokenBudget: 500 }),
    outputTokenBudget: 500,
    maxToolRequests: 6,
    maxToolRounds: 4,
    recoveryDelaysMs: []
  });

  const result = await orchestrator.respond({
    conversation,
    mode: 'balanced',
    projectContext: { text: 'Projeto ASTRAEON.', selectedFiles: [], totalFiles: 10 },
    taskContract,
    tools: [{
      type: 'function',
      function: {
        name: 'read_project_file',
        parameters: { type: 'object', properties: { path: { type: 'string' }, end_line: { type: 'integer' } } }
      }
    }],
    toolExecutor: async () => {
      executions += 1;
      return { ok: true, path: 'src/app.js', content: 'export const app = true;' };
    }
  });

  assert.equal(executions, 1);
  assert.equal(provider.generated, 2);
  assert.match(JSON.stringify(calls[1]), /duplicate/);
  assert.equal(result.context.evidence.filter(item => item.duplicate).length, 1);
});

test('métrica totalRequests reflete requisições do provedor, não apenas timers locais', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-telemetry-accounting-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const telemetry = await new GenesisTelemetry(root).init();
  telemetry.recordTokens(1_200, 80, 0, 2, 'reported');

  const metrics = telemetry.getMetrics();
  assert.equal(metrics.providerRequestCount, 2);
  assert.equal(metrics.totalRequests, 2);
  assert.equal(metrics.totalTimedOperations, 0);

  await telemetry.flush();
  const restored = await new GenesisTelemetry(root).init();
  assert.equal(restored.getMetrics().tokensSent, 1_200);
  assert.equal(restored.getMetrics().tokensReceived, 80);
  assert.equal(restored.getMetrics().totalRequests, 2);

  await restored.clear();
  assert.equal(restored.getMetrics().tokensSent, 0);
  assert.equal(restored.getMetrics().totalRequests, 0);
  const afterClear = await new GenesisTelemetry(root).init();
  assert.deepEqual(afterClear.list(), []);
  assert.equal(afterClear.getMetrics().tokensSent, 0);
  assert.equal(afterClear.getMetrics().totalRequests, 0);
});

test('SupremeMind exclui segredos e binários e limita configuração controlada pelo projeto', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-suprememind-security-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-supersecret1234567890\n');
  await fs.writeFile(path.join(root, 'private.pem'), '-----BEGIN PRIVATE KEY-----\nsegredo\n');
  await fs.writeFile(path.join(root, 'asset.png'), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
  await fs.writeFile(path.join(root, 'app.js'), 'export function start() { return true; }\n');
  await fs.writeFile(path.join(root, 'suprememind.config.json'), JSON.stringify({
    projectName: 'Projeto seguro',
    maxFileSize: Number.MAX_SAFE_INTEGER,
    vectorDimensions: 10_000_000,
    maxContextFiles: 999_999,
    gitCommitLimit: 999_999,
    ignore: null
  }));

  const supremeMind = new SupremeMindIntegration(root);
  await supremeMind.init();
  const indexed = await supremeMind.index({ force: true });
  const serialized = JSON.stringify(indexed);

  assert.ok(indexed.files.some(file => file.path === 'app.js'));
  assert.equal(indexed.files.some(file => ['.env', 'private.pem', 'asset.png'].includes(file.path)), false);
  assert.doesNotMatch(serialized, /supersecret|BEGIN PRIVATE KEY/);
  assert.equal(indexed.config.vectorDimensions, 512);
  assert.equal(indexed.config.maxFileSize, 5_000_000);
  assert.equal(indexed.config.maxContextFiles, 40);
  assert.equal(indexed.config.gitCommitLimit, 1_000);

  const sanitizedMemory = await supremeMind.saveMemory({
    type: 'tipo-inexistente',
    status: 'estado-inexistente',
    title: 'Decisão do login',
    content: 'login usa sk-or-v1-supersecret1234567890',
    files: { path: 'app.js' },
    tags: { name: 'login' }
  });
  assert.equal(sanitizedMemory.type, 'task');
  assert.equal(sanitizedMemory.status, 'recorded');
  assert.deepEqual(sanitizedMemory.files, []);
  assert.deepEqual(sanitizedMemory.tags, []);
  assert.doesNotMatch(JSON.stringify(sanitizedMemory), /supersecret/);

  await fs.appendFile(path.join(root, '.suprememind', 'memories.jsonl'), '{"linha-parcial":\n');
  await supremeMind.saveMemory({
    title: 'Login validado',
    content: 'O fluxo de login foi analisado.',
    files: ['app.js', '../escape.js', '.env'],
    tags: ['login']
  });
  const memories = await supremeMind.listMemories('login', 10);
  assert.equal(memories.length, 2, 'uma linha JSONL corrompida não deve ocultar as memórias válidas');
  assert.deepEqual(memories.find(memory => memory.title === 'Login validado').files, ['app.js']);
  assert.doesNotMatch(JSON.stringify(memories), /supersecret|\.env|escape\.js/);

  const search = await supremeMind.search('login', 1_000_000_000);
  assert.ok(search.length <= 100);
  const orbit = await supremeMind.getOrbit('app.js', 1_000_000_000);
  assert.ok(orbit.levels.length <= 9, 'a profundidade da órbita deve ser limitada internamente');

  const indexPath = path.join(root, '.suprememind', 'index.json');
  const malformedIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  malformedIndex.files.find(file => file.path === 'app.js').symbols = null;
  await fs.writeFile(indexPath, JSON.stringify(malformedIndex));
  const restoredFromMalformedIndex = new SupremeMindIntegration(root);
  await assert.rejects(
    restoredFromMalformedIndex.loadIndex(),
    error => error.code === 'suprememind_index_unsafe',
    'campos consumidos pelos endpoints devem ser validados antes de aceitar o índice persistido'
  );
});

test('ledger não deixa etapas em execução depois de falha ou cancelamento', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-ledger-terminal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ledger = await new TaskLedgerStore(root).init();
  const input = {
    contract: { objective: 'Executar uma tarefa controlada.' },
    steps: [
      { id: 'one', label: 'Primeira', status: 'running' },
      { id: 'two', label: 'Segunda', status: 'pending' }
    ]
  };
  const failing = await ledger.createTask(input);
  const failed = await ledger.failTask(failing.id, { message: 'Verificação falhou.' });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.steps.map(step => step.status), ['failed', 'skipped']);

  const cancelling = await ledger.createTask(input);
  const cancelled = await ledger.cancelTask(cancelling.id, 'Interrompida pelo usuário.');
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.steps.map(step => step.status), ['skipped', 'skipped']);

  const summaries = ledger.publicSnapshot({ limit: 10 }).tasks;
  const failedSummary = summaries.find(task => task.id === failing.id);
  const cancelledSummary = summaries.find(task => task.id === cancelling.id);
  assert.deepEqual({
    completed: failedSummary.completedSteps,
    failed: failedSummary.failedSteps,
    skipped: failedSummary.skippedSteps,
    terminal: failedSummary.terminalSteps
  }, { completed: 0, failed: 1, skipped: 1, terminal: 2 });
  assert.deepEqual({
    completed: cancelledSummary.completedSteps,
    failed: cancelledSummary.failedSteps,
    skipped: cancelledSummary.skippedSteps,
    terminal: cancelledSummary.terminalSteps
  }, { completed: 0, failed: 0, skipped: 2, terminal: 2 });
});

test('chat encerra falhas com relatório final honesto sem persistir conteúdo parcial', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-server-truncated-'));
  const dataDir = path.join(root, '.genesis');
  const store = await new GenesisStore(dataDir).init();
  const telemetry = await new GenesisTelemetry(dataDir).init();
  const attachmentStore = await new AttachmentStore(dataDir).init();
  const projectStore = await new ProjectStore(dataDir).init();
  const permissionStore = await new PermissionStore(dataDir).init();
  const approvalManager = new ApprovalManager();
  const projectTools = new ProjectToolExecutor({ projectStore, permissionStore, approvalManager });
  const taskLedger = await new TaskLedgerStore(dataDir).init();
  const supremeMind = new SupremeMindIntegration(dataDir);
  let calls = 0;
  let successfulRoutes = 0;
  const remote = {
    id: 'openrouter',
    name: 'OpenRouter',
    configured: true,
    account: {},
    catalog: [],
    publicStatus() {
      return {
        id: this.id, name: this.name, configured: true, state: 'online',
        failureCount: 0, latencyMs: null, remainingRequests: null, remainingTokens: null
      };
    },
    async resolveCandidates() {
      return [{
        providerId: 'openrouter', model: 'truncated:free', displayName: 'Truncated Free',
        contextWindow: 32_768, outputLimit: 128, supportedParameters: [],
        supportsTools: false, score: 100, freeVerified: true
      }];
    },
    async generate() {
      calls += 1;
      return {
        content: `Trecho parcial ${calls}.`, model: 'truncated:free', resolvedModel: 'truncated:free',
        resolvedProvider: 'Mock', latencyMs: 1, finishReason: 'length',
        usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, toolCalls: []
      };
    },
    markSuccess() { successfulRoutes += 1; },
    markFailure() {}
  };
  const orchestrator = new GenesisOrchestrator({
    providers: [remote],
    contextEngine: new ContextEngine({ inputTokenBudget: 3_000, outputTokenBudget: 128 }),
    outputTokenBudget: 128,
    recoveryDelaysMs: []
  });
  const userMemory = {
    observe: async () => {},
    context: async () => '',
    publicState: () => ({ enabled: false })
  };
  const handler = createHandler({
    config: { root, dataDir, maxMessageCharacters: 120_000, inputTokenBudget: 12_000 },
    store,
    orchestrator,
    telemetry,
    settings: { publicState: () => ({}) },
    attachmentStore,
    projectStore,
    permissionStore,
    approvalManager,
    projectTools,
    userMemory,
    supremeMind,
    taskLedger
  });
  const server = http.createServer(handler);
  const baseUrl = await listen(server);
  const shutdown = createRuntimeShutdown({
    server,
    handler,
    persistences: [store, projectStore, permissionStore, taskLedger],
    telemetry
  });
  t.after(async () => {
    await shutdown();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const conversation = await store.createConversation({ title: 'Resposta truncada' });
  const response = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-genesis-client': 'web' },
    body: JSON.stringify({ content: 'Explique detalhadamente o sistema.', mode: 'balanced' })
  });
  const stream = await response.text();

  assert.equal(response.status, 200);
  assert.doesNotMatch(stream, /event: error/);
  assert.match(stream, /task_verification_failed/);
  assert.match(stream, /event: done/);
  assert.equal(calls, 3);
  assert.equal(successfulRoutes, 0);
  const persisted = store.getConversation(conversation.id);
  assert.equal(persisted.messages.length, 2, 'deve persistir a resposta terminal, nunca o texto parcial do modelo');
  assert.match(persisted.messages[1].content, /Não consegui concluir esta (?:resposta|análise)/);
  assert.match(persisted.messages[1].content, /contexto da conversa foram preservados/);
  assert.doesNotMatch(persisted.messages[1].content, /Relatório final do Genesis|nenhuma alteração foi confirmada/);
  assert.doesNotMatch(persisted.messages[1].content, /Trecho parcial/);
  assert.equal(persisted.messages[1].meta.terminalReport, true);
  assert.equal(persisted.messages[1].meta.terminalStatus, 'failed');
  assert.deepEqual({
    inputTokens: persisted.stats.inputTokens,
    outputTokens: persisted.stats.outputTokens,
    requests: persisted.stats.requests
  }, { inputTokens: 90, outputTokens: 30, requests: 3 });
  const tasksPayload = await (await fetch(`${baseUrl}/api/tasks`)).json();
  assert.equal(tasksPayload.tasks.tasks[0].status, 'failed');
  assert.equal(taskLedger.getTask(tasksPayload.tasks.tasks[0].id).failure.code, 'task_verification_failed');
  assert.equal(tasksPayload.tasks.tasks[0].usage.totalTokens, 120);
  const neural = await (await fetch(`${baseUrl}/api/neural/snapshot`)).json();
  assert.equal(neural.telemetry.metrics.tokensSent, 90);
  assert.equal(neural.telemetry.metrics.tokensReceived, 30);
  assert.equal(neural.telemetry.metrics.providerRequestCount, 3);
  assert.ok(neural.telemetry.events.some(event => event.type === 'agent.failed'));
});

test('chat ASTRAEON integra perfil local, ledger, storage e Neural sem chamar OpenRouter', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-server-evolution-'));
  const dataDir = path.join(root, '.genesis');
  const projectRoot = path.join(root, 'ASTRAEON');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'index.html'), [
    '<!doctype html><canvas id="game"></canvas>',
    `<img src="data:image/png;base64,${'A'.repeat(48_000)}">`,
    '<script>function startGame() { return true; }</script>'
  ].join('\n'));
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# ASTRAEON\nJogo 2D local.\n');

  const store = await new GenesisStore(dataDir).init();
  const telemetry = await new GenesisTelemetry(dataDir).init();
  const attachmentStore = await new AttachmentStore(dataDir).init();
  const projectStore = await new ProjectStore(dataDir).init();
  await projectStore.openPath(projectRoot);
  const permissionStore = await new PermissionStore(dataDir).init();
  const approvalManager = new ApprovalManager();
  const projectTools = new ProjectToolExecutor({ projectStore, permissionStore, approvalManager });
  const taskLedger = await new TaskLedgerStore(dataDir).init();
  const supremeMind = new SupremeMindIntegration(dataDir);
  const remote = {
    id: 'openrouter',
    name: 'OpenRouter',
    configured: true,
    account: {},
    catalog: [],
    remoteCalls: 0,
    publicStatus() {
      return { id: this.id, name: this.name, configured: true, state: 'online', failureCount: 0 };
    },
    async resolveCandidates() {
      this.remoteCalls += 1;
      throw new Error('A rota remota não deveria ser consultada.');
    },
    markSuccess() {},
    markFailure() {}
  };
  const orchestrator = new GenesisOrchestrator({
    providers: [remote],
    contextEngine: new ContextEngine({ inputTokenBudget: 3_000, outputTokenBudget: 500 }),
    outputTokenBudget: 500,
    recoveryDelaysMs: []
  });
  const userMemory = {
    observe: async () => {},
    context: async () => '',
    publicState: () => ({ enabled: false })
  };
  const config = {
    root,
    dataDir,
    maxMessageCharacters: 120_000,
    inputTokenBudget: 12_000
  };
  const handler = createHandler({
    config,
    store,
    orchestrator,
    telemetry,
    settings: { publicState: () => ({}) },
    attachmentStore,
    projectStore,
    permissionStore,
    approvalManager,
    projectTools,
    userMemory,
    supremeMind,
    taskLedger
  });
  const server = http.createServer(handler);
  const baseUrl = await listen(server);
  const shutdown = createRuntimeShutdown({
    server,
    handler,
    persistences: [store, projectStore, permissionStore, taskLedger],
    telemetry
  });
  t.after(async () => {
    await shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });

  const conversation = await store.createConversation({ title: 'ASTRAEON' });
  const response = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-genesis-client': 'web' },
    body: JSON.stringify({ content: ASTRAEON_PROMPT, mode: 'balanced' })
  });
  const stream = await response.text();

  assert.equal(response.status, 200);
  assert.match(stream, /event: done/);
  assert.doesNotMatch(stream, /event: error/);
  assert.equal(remote.remoteCalls, 0);

  const persisted = store.getConversation(conversation.id);
  assert.equal(persisted.messages.length, 2);
  assert.equal(persisted.messages[1].meta.providerId, 'genesis-local');
  assert.equal(persisted.messages[1].meta.usage.requestCount, 0);
  assert.equal(persisted.messages[1].meta.usage.totalTokens, 0);
  assert.equal(persisted.stats.requests, 0);
  assert.equal(persisted.stats.inputTokens, 0);
  assert.doesNotMatch(persisted.messages[1].content, /data:image\/png;base64/i);

  const tasksResponse = await fetch(`${baseUrl}/api/tasks`);
  const tasksPayload = await tasksResponse.json();
  assert.equal(tasksPayload.tasks.count, 1);
  assert.equal(tasksPayload.tasks.activeCount, 0);
  assert.equal(tasksPayload.tasks.tasks[0].status, 'completed');
  assert.equal(tasksPayload.tasks.tasks[0].usage.requestCount, 0);
  assert.equal(tasksPayload.tasks.tasks[0].usage.totalTokens, 0);

  const neuralResponse = await fetch(`${baseUrl}/api/neural/snapshot`);
  const neural = await neuralResponse.json();
  assert.equal(neural.project.name, 'ASTRAEON');
  assert.equal(neural.tasks.count, 1);
  assert.equal(neural.tasks.activeCount, 0);
  assert.equal(neural.runtime.activeConversations, 0);
  assert.equal(neural.telemetry.metrics.tokensSent, 0);
  assert.ok(neural.telemetry.events.some(event => event.type === 'agent.local.analysis'));

  const indexResponse = await fetch(`${baseUrl}/api/suprememind/index`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-genesis-client': 'web' },
    body: JSON.stringify({ force: true, path: path.join(root, 'fora-do-projeto') })
  });
  const indexed = await indexResponse.json();
  assert.equal(indexResponse.status, 200);
  assert.equal(indexed.indexing.status, 'completed');
  assert.equal(indexed.indexing.percent, 100);
  assert.ok(indexed.stats.indexed >= 2);

  const status = await (await fetch(`${baseUrl}/api/suprememind/status`)).json();
  assert.equal(status.indexed, true);
  assert.equal(status.projectInfo.projectName, 'ASTRAEON');
  assert.equal(status.indexing.status, 'completed');

  const graph = await (await fetch(`${baseUrl}/api/suprememind/graph?nodes=20&edges=30`)).json();
  assert.ok(graph.graph.nodes.some(node => node.path === 'index.html'));
  assert.ok(graph.graph.totals.nodes >= 2);

  const files = await (await fetch(`${baseUrl}/api/suprememind/files?query=index&limit=10`)).json();
  assert.ok(files.files.some(file => file.path === 'index.html'));
  assert.equal(files.files.some(file => file.path.includes('fora-do-projeto')), false,
    'o endpoint deve ignorar caminhos arbitrários enviados no corpo');

  await fs.rm(path.join(projectRoot, '.suprememind', 'index.json'));
  const postSupremeMind = async (endpoint, body) => {
    const endpointResponse = await fetch(`${baseUrl}/api/suprememind/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-genesis-client': 'web' },
      body: JSON.stringify(body)
    });
    return { response: endpointResponse, payload: await endpointResponse.json() };
  };
  const cachedQuery = await postSupremeMind('query', { query: 'startGame', limit: 10 });
  const cachedContext = await postSupremeMind('context', { query: 'startGame', budget: 2_000 });
  const cachedImpact = await postSupremeMind('impact', { path: 'index.html', depth: 2 });
  const cachedOrbit = await postSupremeMind('orbit', { path: 'index.html', depth: 2 });
  assert.equal(cachedQuery.response.status, 200);
  assert.ok(cachedQuery.payload.results.some(result => result.path === 'index.html'));
  assert.equal(cachedContext.response.status, 200);
  assert.match(cachedContext.payload.markdown, /ASTRAEON/);
  assert.equal(cachedImpact.response.status, 200);
  assert.equal(cachedImpact.payload.target, 'index.html');
  assert.equal(cachedOrbit.response.status, 200);
  assert.equal(cachedOrbit.payload.target, 'index.html');

  await permissionStore.setMode('full');
  let generation = 0;
  remote.resolveCandidates = async () => {
    remote.remoteCalls += 1;
    return [{
      providerId: 'openrouter',
      model: 'mock-code:free',
      displayName: 'Mock Code Free',
      contextWindow: 32_768,
      outputLimit: 512,
      supportedParameters: ['tools'],
      supportsTools: true,
      score: 100,
      freeVerified: true
    }];
  };
  remote.generate = async () => {
    generation += 1;
    if (generation === 1) {
      return {
        content: '',
        model: 'mock-code:free',
        resolvedModel: 'mock-code:free',
        resolvedProvider: 'Mock',
        latencyMs: 1,
        finishReason: 'tool_calls',
        usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
        toolCalls: [{
          id: 'write-readme',
          type: 'function',
          function: {
            name: 'write_project_file',
            arguments: JSON.stringify({ path: 'README.md', content: '# ASTRAEON\nAtualizado pelo Genesis.\n' })
          }
        }]
      };
    }
    return {
      content: 'O README do ASTRAEON foi atualizado.',
      model: 'mock-code:free',
      resolvedModel: 'mock-code:free',
      resolvedProvider: 'Mock',
      latencyMs: 1,
      finishReason: 'stop',
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      toolCalls: []
    };
  };

  const mutationConversation = await store.createConversation({ title: 'Mutação ASTRAEON' });
  const mutationResponse = await fetch(`${baseUrl}/api/conversations/${mutationConversation.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-genesis-client': 'web' },
    body: JSON.stringify({ content: 'Atualize o README do projeto.', mode: 'code' })
  });
  const mutationStream = await mutationResponse.text();
  assert.match(mutationStream, /event: done/);
  assert.match(await fs.readFile(path.join(projectRoot, 'README.md'), 'utf8'), /Atualizado pelo Genesis/);

  const staleStatus = await (await fetch(`${baseUrl}/api/suprememind/status`)).json();
  assert.equal(staleStatus.indexed, false,
    'uma mutação deve retirar o índice anterior antes que o próximo turno possa reutilizá-lo');
  await assert.rejects(fs.access(path.join(projectRoot, '.suprememind', 'index.json')));
});
