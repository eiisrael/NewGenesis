import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/runtime-hardening.js';
import { GenesisOrchestrator } from '../src/core/orchestrator.js';
import { createTaskContract } from '../src/core/task-contract.js';
import { PreciseOpenRouterProvider } from '../src/providers/precise-openrouter-provider.js';

function contextFor(conversation) {
  return {
    messages: [
      { role: 'system', content: 'Você é o Genesis.' },
      ...conversation.messages.map(message => ({ role: message.role, content: message.content }))
    ],
    estimatedTokens: 60,
    canonicalTokens: 60,
    contextWindow: 32_000,
    inputBudget: 12_000,
    outputReserve: 2_000,
    retainedMessages: conversation.messages.length,
    totalMessages: conversation.messages.length,
    compactedMessages: 0,
    projectFiles: 8,
    projectTotalFiles: 12,
    savedTokens: 0,
    memoryRetainedPercent: 100,
    usedTokens: 60,
    remainingTokens: 31_940,
    budgetAllocation: {},
    reused: false
  };
}

function createOpenRouterProvider() {
  return new PreciseOpenRouterProvider({
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

test('falha transitória do catálogo não derruba o roteador openrouter/free', async () => {
  const provider = createOpenRouterProvider();
  provider.discoverModels = async () => {
    const error = new Error('catálogo temporariamente inacessível');
    error.category = 'availability';
    error.code = 'provider_unreachable';
    throw error;
  };

  const models = await provider.models({ force: true });
  assert.deepEqual(models, []);
  assert.equal(provider.publicStatus().catalogFallbackActive, true);
  assert.equal(provider.publicStatus().freeRouterReady, true);

  const candidates = await provider.resolveCandidates('balanced', {}, {});
  assert.ok(candidates.some(candidate => candidate.model === 'openrouter/free'));
});

test('análise da própria pasta força run_project_check real antes da conclusão', async () => {
  let generateCalls = 0;
  let toolCalls = 0;
  const provider = {
    id: 'openrouter',
    name: 'Modelos gratuitos',
    handlesRequestBudget: false,
    publicStatus() {
      return {
        id: 'openrouter',
        configured: true,
        state: 'online',
        latencyMs: 10,
        failureCount: 0,
        remainingRequests: null,
        remainingTokens: null,
        modelCount: 5,
        freeRouterReady: true
      };
    },
    async resolveCandidates() {
      return [{
        providerId: 'openrouter',
        model: 'fake:free',
        displayName: 'Fake Free',
        contextWindow: 32_000,
        outputLimit: 4_000,
        score: 100,
        supportsTools: true,
        supportedParameters: ['tools'],
        freeVerified: true
      }];
    },
    async generate({ tools }) {
      generateCalls += 1;
      if (generateCalls === 1) {
        assert.deepEqual(tools.map(tool => tool.function.name), ['run_project_check']);
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'check-call',
            type: 'function',
            function: { name: 'run_project_check', arguments: JSON.stringify({ check: 'auto' }) }
          }],
          model: 'fake:free',
          resolvedModel: 'fake:free',
          resolvedProvider: 'Fake Free',
          latencyMs: 4,
          usage: { inputTokens: 50, outputTokens: 12, totalTokens: 62 }
        };
      }
      assert.deepEqual(tools, []);
      return {
        content: 'A arquitetura foi analisada com base no projeto ativo e na verificação executada.',
        finishReason: 'stop',
        toolCalls: [],
        model: 'fake:free',
        resolvedModel: 'fake:free',
        resolvedProvider: 'Fake Free',
        latencyMs: 3,
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 }
      };
    },
    markSuccess() {},
    markFailure() {}
  };

  const conversation = {
    id: 'self-audit',
    lastProviderId: null,
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'Analise sua própria pasta e o projeto inteiro e me diga se está funcionando de verdade.'
    }]
  };
  const taskContract = createTaskContract(conversation.messages[0].content, {
    project: { id: 'project', name: 'NewGenesis', fileCount: 120, writable: true }
  });

  const orchestrator = new GenesisOrchestrator({
    providers: [provider],
    contextEngine: { buildIncremental: async () => contextFor(conversation) },
    outputTokenBudget: 4_000,
    maxRoutes: 1,
    maxInferenceRequests: 4,
    maxToolRequests: 6,
    maxToolRounds: 4
  });

  const result = await orchestrator.respond({
    conversation,
    mode: 'reasoning',
    projectContext: { totalFiles: 12, selectedFiles: [], text: 'Projeto NewGenesis com código real disponível.' },
    taskContract,
    localResponse: 'Este perfil estático não deve encerrar a auditoria.',
    tools: [],
    toolExecutor: async call => {
      toolCalls += 1;
      assert.equal(call.function.name, 'run_project_check');
      assert.deepEqual(JSON.parse(call.function.arguments), { check: 'auto' });
      return {
        ok: true,
        check: 'auto',
        detectedCheck: 'check',
        command: 'npm run check',
        summary: 'Verificação “check” concluída com sucesso.'
      };
    }
  });

  assert.equal(toolCalls, 1);
  assert.equal(generateCalls, 2);
  assert.equal(result.task.toolPolicy.strategy, 'verified_project_audit');
  assert.equal(result.context.audit.projectCheck.ok, true);
  assert.equal(result.context.audit.freeModels.freeRouterReady, true);
  assert.match(result.content, /Validação prática do Genesis/);
  assert.match(result.content, /Verificação automatizada: \*\*confirmada\*\*/);
  assert.match(result.content, /npm run check|concluída com sucesso/i);
});
