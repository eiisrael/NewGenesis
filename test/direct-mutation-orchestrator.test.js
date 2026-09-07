import test from 'node:test';
import assert from 'node:assert/strict';
import { GenesisOrchestrator } from '../src/core/orchestrator.js';
import { createTaskContract } from '../src/core/task-contract.js';

const writeTool = {
  type: 'function',
  function: {
    name: 'write_project_file',
    description: 'Grava arquivo.',
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } }
    }
  }
};

function contextFor(conversation) {
  return {
    messages: [
      { role: 'system', content: 'Você é o Genesis.' },
      ...conversation.messages.map(message => ({ role: message.role, content: message.content }))
    ],
    estimatedTokens: 40,
    canonicalTokens: 40,
    contextWindow: 32_000,
    inputBudget: 12_000,
    outputReserve: 2_000,
    retainedMessages: conversation.messages.length,
    totalMessages: conversation.messages.length,
    compactedMessages: 0,
    projectFiles: 0,
    projectTotalFiles: 0,
    savedTokens: 0,
    memoryRetainedPercent: 100,
    usedTokens: 40,
    remainingTokens: 31_960,
    budgetAllocation: {},
    reused: false
  };
}

test('criação simples faz uma inferência, grava e finaliza com relatório local', async () => {
  let generateCalls = 0;
  let toolCalls = 0;
  const provider = {
    id: 'fake-free',
    name: 'Fake Free',
    handlesRequestBudget: false,
    publicStatus() {
      return {
        configured: true,
        latencyMs: 0,
        failureCount: 0,
        remainingRequests: null,
        remainingTokens: null
      };
    },
    async resolveCandidates() {
      return [{
        model: 'fake:free',
        displayName: 'Fake Free',
        contextWindow: 32_000,
        outputLimit: 4_000,
        score: 100,
        supportsTools: true
      }];
    },
    async generate({ tools }) {
      generateCalls += 1;
      assert.deepEqual(tools.map(item => item.function.name), ['write_project_file']);
      return {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'call-write',
          type: 'function',
          function: {
            name: 'write_project_file',
            arguments: JSON.stringify({ path: 'index.html', content: '<!doctype html><html><body>OK</body></html>' })
          }
        }],
        model: 'fake:free',
        resolvedModel: 'fake:free',
        resolvedProvider: 'Fake Free',
        latencyMs: 5,
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60, requestCount: 1 }
      };
    },
    markSuccess() {}
  };

  const conversation = {
    id: 'conversation-direct',
    lastProviderId: null,
    messages: [{ id: 'u1', role: 'user', content: 'Crie um index.html na pasta do projeto' }]
  };
  const taskContract = createTaskContract(conversation.messages[0].content, {
    project: { id: 'project', name: 'Teste', fileCount: 0, writable: true }
  });
  assert.equal(taskContract.requestBudget.limit, 1);

  const orchestrator = new GenesisOrchestrator({
    providers: [provider],
    contextEngine: { buildIncremental: async () => contextFor(conversation) },
    outputTokenBudget: 4_000,
    maxRoutes: 1,
    maxInferenceRequests: 4,
    maxToolRequests: 14,
    maxToolRounds: 12
  });

  const result = await orchestrator.respond({
    conversation,
    mode: 'code',
    taskContract,
    tools: [writeTool],
    toolExecutor: async call => {
      toolCalls += 1;
      assert.equal(call.function.name, 'write_project_file');
      return { ok: true, path: 'index.html', summary: 'index.html atualizado com segurança.' };
    }
  });

  assert.equal(generateCalls, 1);
  assert.equal(toolCalls, 1);
  assert.match(result.content, /Alterações realizadas/);
  assert.match(result.content, /index\.html/);
  assert.match(result.content, /Alterações aplicadas/);
  assert.equal(result.verification.status, 'partial');
  assert.equal(result.usage.requestCount, 1);
});